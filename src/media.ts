/**
 * Live-media policy + eager downloader, ported from v1 `src/media.ts`
 * (downloadLiveMediaDocs). The policy is unchanged: OCR candidates only
 * (image/* or application/pdf, ≤ 25 MiB); photos are fetched EAGERLY during
 * pull because the Graph API hands back short-lived signed CDN URLs that
 * have expired by the time any deferred extraction would re-fetch them;
 * videos/audio stay chat-day text placeholders.
 *
 * What changed for v2: instead of writing bytes to a content-addressed disk
 * cache and upserting 'file' docs itself, the downloader returns MediaItems
 * whose bytes ride DocumentInput.binary — the ENGINE owns storage and the
 * OCR/VLM pipeline (markdown: null enrolls the doc). Dropped with that:
 * storeMedia, the byte source, sweepMediaCache (no connector-side cache to
 * sweep), and upsertExportMediaDocs (the export-folder import is out of
 * scope for v2 — see README).
 *
 * Idempotency is preserved: `deps.hasDoc('live-media:<threadId>:<msgId>:<slot>')`
 * (host.query.byExternalId under the hood) is checked BEFORE any network
 * fetch, so re-polls of the ~20-message window never re-download.
 */
import * as path from 'node:path';
import { dayKey } from './chat-day';
import type { NetFetch } from './client';
import type { InstagramAttachment, InstagramMessage, MediaItem } from './types';

/** Download cap; larger media stays a chat-day text placeholder. */
export const MEDIA_SIZE_CAP_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  pdf: 'application/pdf',
};

/** Map a filename to a MIME type by extension (case-insensitive). */
export function guessMimeType(filename: string): string | undefined {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return MIME_BY_EXT[ext];
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/tiff': '.tif',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
};

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;

/**
 * Only photos (and PDFs) are worth downloading: the engine's deep-extraction
 * classifier enrolls images/PDFs for OCR/VLM but never videos/audio. Decide
 * from the attachment kind first, then the URL extension.
 */
export function isOcrCandidateAttachment(a: {
  type: string;
  url?: string;
}): boolean {
  if (a.type === 'photo' || a.type === 'image') return true;
  if (a.type === 'video' || a.type === 'audio') return false;
  if (a.url) {
    try {
      // A bare path (no scheme) is not a parseable URL — fall back to
      // testing the raw string's extension.
      const base = /^[a-z]+:\/\//i.test(a.url)
        ? path.basename(new URL(a.url).pathname)
        : path.basename(a.url);
      return IMAGE_EXT_RE.test(base) || /\.pdf$/i.test(base);
    } catch {
      // not parseable → not a candidate
    }
  }
  return false;
}

/** Build a filename with a usable extension so the classifier recognizes it. */
export function deriveFilename(
  url: string,
  contentType: string,
  msgId: string,
  index: number,
): string {
  try {
    const base = path.basename(new URL(url).pathname);
    if (base && path.extname(base)) return base;
  } catch {
    // fall through to a synthetic name
  }
  const ext = EXT_BY_MIME[contentType] ?? '';
  return `${msgId}_${index}${ext}`;
}

/** The host `net.fetch` response shape (lowercase header keys). */
interface HostResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface MediaDownloadDeps {
  /** host.net.fetch — the CDN URL is signed; no token rides this request. */
  fetch: NetFetch;
  /** True when the 'file' doc already exists (skip BEFORE downloading). */
  hasDoc(externalId: string): Promise<boolean>;
  /** session.log('warn', …) — a failed/expired fetch is warned, never fatal. */
  warn(msg: string): void;
}

/**
 * Eagerly download a thread window's photo/PDF attachments, returning one
 * MediaItem per new attachment. Stable per-(message, slot) externalIds keep
 * re-polls idempotent; failures leave the chat-day text placeholder.
 */
export async function downloadThreadMedia(
  deps: MediaDownloadDeps,
  threadId: string,
  messages: InstagramMessage[],
): Promise<MediaItem[]> {
  const out: MediaItem[] = [];
  for (const message of messages) {
    for (let i = 0; i < message.attachments.length; i++) {
      const attachment: InstagramAttachment = message.attachments[i];
      if (!attachment.url) continue;
      if (!isOcrCandidateAttachment(attachment)) continue;

      const externalId = `live-media:${threadId}:${message.id}:${i}`;
      if (await deps.hasDoc(externalId)) continue;

      let bytes: Uint8Array;
      let contentType = '';
      try {
        const res = (await deps.fetch(attachment.url)) as HostResponse;
        if (res.status < 200 || res.status >= 300) {
          deps.warn(
            `instagram media ${externalId}: HTTP ${res.status} — skipped (placeholder kept)`,
          );
          continue;
        }
        contentType = (res.headers['content-type'] ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        const declared = Number(res.headers['content-length'] ?? '0');
        if (declared > MEDIA_SIZE_CAP_BYTES) continue;
        if (res.body.length === 0 || res.body.length > MEDIA_SIZE_CAP_BYTES)
          continue;
        bytes = res.body;
      } catch (e) {
        // expired/unreachable CDN URL → leave the chat-day text placeholder
        deps.warn(
          `instagram media ${externalId}: fetch failed (${
            e instanceof Error ? e.message : String(e)
          }) — skipped (placeholder kept)`,
        );
        continue;
      }

      const filename = deriveFilename(attachment.url, contentType, message.id, i);
      const mime =
        contentType &&
        (contentType.startsWith('image/') || contentType === 'application/pdf')
          ? contentType
          : guessMimeType(filename);
      // If we still can't prove it's an image/PDF, the classifier would never
      // enroll it — drop it rather than ingest dead bytes.
      if (!mime || (!mime.startsWith('image/') && mime !== 'application/pdf')) {
        continue;
      }

      out.push({
        kind: 'media',
        externalId,
        threadId,
        messageId: message.id,
        day: dayKey(message.ts_ms),
        filename,
        mime,
        bytes,
        sentAtMs: message.ts_ms,
      });
    }
  }
  return out;
}
