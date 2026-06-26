import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { ConnectorSetupHost } from '@kiagent/connector-sdk';
import type { Db } from './host';
import {
  deleteAccount,
  upsertAccountWithFreshSyncState,
} from './account-store';
import { validateInstagramToken } from './add-account';
import { encodeInstagramTokenForStorage } from './token';
import { saveTokenBlob } from './safe-storage-blob';

type AddResult =
  | { ok: true; accountId?: string; [k: string]: unknown }
  | { ok: false; error?: string; message?: string };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The 'instagram-submit' hook: validate the pasted long-lived access token,
 * create/refresh the account, and persist the encrypted token blob.
 *
 * Encryption differs from the in-tree builtin: a ConnectorSetupHost only exposes
 * `safeStorage.isEncryptionAvailable()`, so we obtain a full ConnectorHost via
 * `ctx.hostFor(accountId)` (which carries encrypt/decrypt) to write the blob.
 * The account is created first so we have an id to bind the host to; a vault
 * failure rolls it back so a retry starts clean.
 */
export async function submitInstagram(
  payload: Record<string, unknown> | undefined,
  ctx: ConnectorSetupHost,
): Promise<AddResult> {
  const raw = (payload?.token as string | undefined) ?? '';
  const v = await validateInstagramToken(raw);
  if (!v.ok) return v;

  if (!ctx.safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      error: 'vault-failed',
      message: 'safeStorage encryption unavailable',
    };
  }

  fs.mkdirSync(ctx.oauthDir, { recursive: true });
  const credsPath = path.join(ctx.oauthDir, `${crypto.randomUUID()}.bin`);
  const db = ctx.db as Db;

  let accountId: bigint;
  try {
    accountId = await upsertAccountWithFreshSyncState(db, {
      source: 'instagram',
      identifier: v.token.ig_user_id,
      displayName: v.token.username,
      credsPath,
    });
  } catch (e) {
    const msg = errMsg(e);
    console.error('[instagram] submit: DB insert failed:', msg);
    return { ok: false, error: 'db-failed', message: msg };
  }

  // Encryption can only happen AFTER the account exists: a ConnectorSetupHost
  // exposes encrypt/decrypt solely through ctx.hostFor(accountId) (the forked
  // process has no Electron safeStorage of its own). That inverts the in-tree
  // order (blob-then-account). The window is closed by the rollback below; if
  // the rollback also fails, the account is left pointing at a missing blob —
  // createInstance throws on next sync (account flagged) and re-adding the same
  // token upserts + rewrites the blob, self-healing.
  try {
    const host = ctx.hostFor(accountId);
    saveTokenBlob(
      credsPath,
      encodeInstagramTokenForStorage(v.token, host.safeStorage),
    );
  } catch (e) {
    const msg = errMsg(e);
    console.error('[instagram] submit: vault write failed:', msg);
    try {
      await deleteAccount(db, accountId);
    } catch (rollbackErr) {
      console.error('[instagram] submit: rollback failed', rollbackErr);
    }
    return { ok: false, error: 'vault-failed', message: msg };
  }

  try {
    await ctx.restartAccount(accountId);
  } catch (e) {
    console.error('[instagram] submit: restartAccount failed', e);
  }
  try {
    await ctx.publishState();
  } catch {
    /* best-effort */
  }

  return {
    ok: true,
    accountId: String(accountId),
    username: v.token.username,
  };
}
