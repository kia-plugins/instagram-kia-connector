import type {
  ConnectorHost,
  Document,
  DocumentId,
  PendingDocument,
  SyncStateRow,
} from '@kiagent/connector-sdk';
import type { InstagramClient } from '../client';
import type { InstagramMessage, InstagramThread } from '../types';

/** Reversible stand-in for Electron safeStorage (tests have no keyring). */
export function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  };
}

export interface CaptureHost {
  ctx: ConnectorHost;
  docs: PendingDocument[];
  box: { state: Partial<SyncStateRow> | null };
}

/** A ConnectorHost that records upserted documents + sync-state. findBySourceId
 *  returns opts.existing (default null) so idempotency paths can be exercised. */
export function captureHost(
  opts: {
    db?: unknown;
    dataDir?: string;
    converter?: unknown;
    state?: Partial<SyncStateRow> | null;
    existing?: Document | null;
  } = {},
): CaptureHost {
  const docs: PendingDocument[] = [];
  const box: { state: Partial<SyncStateRow> | null } = {
    state: opts.state ?? null,
  };
  let nextId = 1n;
  const ctx = {
    accountId: 1n,
    db: opts.db,
    dataDir: opts.dataDir ?? '/tmp/instagram-test',
    converter: opts.converter,
    safeStorage: fakeSafeStorage(),
    emitStreamEvent: () => {},
    async upsertDocument(doc: PendingDocument): Promise<DocumentId> {
      docs.push(doc);
      return nextId++;
    },
    async deleteDocument() {},
    async archiveDocument() {},
    async findBySourceId() {
      return opts.existing ?? null;
    },
    async findByContentHash() {
      return [];
    },
    async saveSyncState(s: Partial<SyncStateRow>) {
      box.state = { ...(box.state ?? {}), ...s };
    },
    async loadSyncState() {
      return box.state as SyncStateRow | null;
    },
  } as unknown as ConnectorHost;
  return { ctx, docs, box };
}

/** An InstagramClient stand-in routed by in-memory fixtures (no network). */
export function fakeClient(
  threads: InstagramThread[],
  messagesByThread: Record<string, InstagramMessage[]> = {},
): InstagramClient {
  return {
    async listThreads() {
      return threads;
    },
    async listMessages(threadId: string) {
      return messagesByThread[threadId] ?? [];
    },
  } as unknown as InstagramClient;
}

/** A fake byte-stream fetch Response carrying image bytes. */
export function fakeMediaResponse(
  bytes: Buffer,
  contentType = 'image/jpeg',
): unknown {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(bytes.length),
  };
  return {
    ok: true,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}
