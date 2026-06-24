import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ByteSource } from '@alpha-cent/connector-sdk';
import type { Db } from './host';
import { mediaDir } from './media-dir';

type Candidate = {
  documentId?: bigint;
  content_hash?: string;
  source?: string;
};

/**
 * Reads Instagram media from the local content-addressed cache by content_hash.
 * No network: the live-API CDN URLs are signed + short-lived and the export
 * folder is read once at import, so a cache miss is terminal ('gone'). dataRoot
 * is the host's shared data root; we namespace under instagram/media.
 *
 * This is the SDK FETCH model `{ source, fetch(db, candidate) }`. The in-tree
 * builtin instead embedded absolute file paths in each doc's
 * metadata.media_paths; here every byte (live download AND export copy) lands
 * in the content cache keyed by the sha256 of the bytes, so the source resolves
 * purely from content_hash (taken from the candidate, or looked up from the
 * documents column by document id).
 */
export function makeInstagramByteSource(dataRoot: string): ByteSource {
  const dir = mediaDir(dataRoot);
  return {
    source: 'instagram',
    async fetch(dbUnknown, candidateUnknown) {
      const db = dbUnknown as Db;
      const c = (candidateUnknown ?? {}) as Candidate;
      let hash = c.content_hash;
      if (!hash && c.documentId != null) {
        try {
          const rows = await db.all(
            `SELECT content_hash FROM documents WHERE id=?`,
            [c.documentId],
          );
          const h = rows[0]?.content_hash;
          if (typeof h === 'string' && h) hash = h;
        } catch {
          /* fall through */
        }
      }
      if (!hash) return { ok: false, kind: 'gone', detail: 'no content_hash' };
      try {
        return { ok: true, bytes: await fsp.readFile(path.join(dir, hash)) };
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'ENOENT')
          return { ok: false, kind: 'gone', detail: 'not in instagram media cache' };
        return { ok: false, kind: 'unavailable', detail: code ?? 'read failed' };
      }
    },
  };
}
