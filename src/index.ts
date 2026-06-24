import type {
  Account,
  Connector,
  ConnectorInstance,
  ConnectorHost,
  ConnectorSetupHost,
  ProgressSink,
} from '@alpha-cent/connector-sdk';
import type { Converter } from './host';
import { loadTokenBlob } from './safe-storage-blob';
import { decodeInstagramTokenFromStorage } from './token';
import { InstagramClient } from './client';
import { runInstagramDelta } from './delta';
import { mediaDir } from './media-dir';
import { makeInstagramByteSource } from './byte-source';
import { importExportFolder } from './export-import';
import { submitInstagram } from './submit';

export const connector: Connector = {
  id: 'instagram',
  displayName: 'Instagram',
  capabilities: {
    multiAccount: true,
    requiresAuth: true,
    // Instagram is delta-only: the Graph API exposes no historical paging for
    // DMs, so there is no backfill — pollDelta walks the last ~20 msgs/thread.
    supportsBackfill: false,
    supportsDelta: true,
    supportsRealtime: false,
  },

  getAccountSchema: () => ({
    type: 'object',
    required: ['token'],
    properties: {
      token: { type: 'string', title: 'Long-lived access token' },
    },
  }),

  validateAccount: (input) => {
    const token = (input as { token?: string })?.token?.trim() ?? '';
    // Mirror the threshold in validateInstagramToken (add-account.ts); the real
    // network check there is authoritative — this is just a fast empty-ish guard.
    if (token.length < 5)
      return {
        ok: false as const,
        error: 'Paste a valid long-lived Instagram access token.',
      };
    return { ok: true as const };
  },

  createInstance,
};

async function createInstance(
  account: Account,
  ctx: ConnectorHost,
): Promise<ConnectorInstance> {
  const token = decodeInstagramTokenFromStorage(
    loadTokenBlob(account.credentials_blob_path!),
    ctx.safeStorage,
  );
  const client = new InstagramClient({
    getToken: async () => token.access_token,
  });
  return {
    // supportsBackfill is false, but the scheduler may still call startBackfill
    // on a fresh account; mirror the in-tree builtin and run a delta (cursor
    // starts at epoch → ingests everything the API currently returns).
    async startBackfill() {
      await runInstagramDelta({ ctx, client });
    },
    async pollDelta() {
      await runInstagramDelta({ ctx, client });
    },
    requestStop() {
      // Delta is short-lived (no long-running socket); nothing to interrupt.
    },
    async shutdown() {},
    buildSourceUrl(
      sourceId: string,
      _type: string,
      _metadata: Record<string, unknown>,
    ) {
      const threadId = sourceId.split(':')[1] ?? '';
      return `https://www.instagram.com/direct/t/${threadId}/`;
    },
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The 'instagram-import' action hook: pick an extracted Instagram DYI export
 * folder, ingest its threads + media into the account named by payload.accountId
 * (this is a `needsAccount` action — Instagram requires an existing paste-token
 * account before importing). Mirrors WhatsApp's whatsappImport: ctx.pickFile +
 * ctx.hostFor(accountId) + ctx.publishState.
 */
async function instagramImport(
  payload: Record<string, unknown> | undefined,
  ctx: ConnectorSetupHost,
): Promise<{
  ok: boolean;
  message?: string;
  error?: string;
  threads?: number;
  days?: number;
  media?: number;
}> {
  const rawId = payload?.accountId;
  if (rawId == null) return { ok: false, error: 'no-account' };
  let accountId: bigint;
  try {
    accountId =
      typeof rawId === 'bigint' ? rawId : BigInt(rawId as string | number);
  } catch {
    return { ok: false, error: 'no-account' };
  }

  const picked = await ctx.pickFile({
    title: 'Select your extracted Instagram export folder',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) {
    return { ok: false, error: 'cancelled' };
  }

  try {
    const host = ctx.hostFor(accountId);
    const progress: ProgressSink = {
      update: () => {
        ctx.publishState().catch(() => {});
      },
      log: () => {},
    };
    const result = await importExportFolder(host, picked.filePaths[0], progress, {
      baseDir: mediaDir(host.dataDir),
      converter: host.converter as Converter | undefined,
    });
    await ctx.publishState();
    const media = result.media ?? 0;
    return {
      ok: true,
      ...result,
      message: `Imported ${result.threads.toLocaleString()} ${result.threads === 1 ? 'thread' : 'threads'} across ${result.days.toLocaleString()} ${result.days === 1 ? 'day' : 'days'}${media > 0 ? ` (${media.toLocaleString()} media)` : ''}.`,
    };
  } catch (e) {
    return { ok: false, error: 'import-failed', message: errMsg(e) };
  }
}

// Only the manifest-referenced backend hooks are exported: the loader rejects
// "orphan" hooks (declared but unreferenced). The manifest references
// 'instagram-submit' (source.submit) and 'instagram-import' (actions[].hook).
// The input-fields `instagram-token` validation is resolved renderer-side, not
// as a backend hook, so it is intentionally NOT here.
export const hooks = {
  'instagram-submit': submitInstagram,
  'instagram-import': instagramImport,
};

export function makeByteSource(deps: { dataDir: string }) {
  return makeInstagramByteSource(deps.dataDir);
}

export default { connector, hooks, makeByteSource };
module.exports = { connector, hooks, makeByteSource };
