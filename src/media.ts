import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db, Host, Converter } from './host';
import type { InstagramMessage } from './types';

/**
 * Standalone media docs use the same 'file' type WhatsApp uses so the host's
 * deep-extraction classifier treats photos/PDFs as OCR/VLM candidates. The
 * extractor writes recovered text back into this same doc's markdown, so these
 * docs carry no parent_id. Bytes are read back by makeInstagramByteSource via
 * the content-addressed cache (filename == content_hash).
 */
export const FILE_DOC_TYPE = 'file';

/** Download/copy cap; larger media stays a chat-day text placeholder. */
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
 * Only photos (and PDFs) are worth caching: deep-extraction's classifier enrolls
 * images/PDFs for OCR/VLM but never videos/audio, so copying their bytes into a
 * second cache would only waste disk. Videos/audio stay as the chat-day text
 * placeholder ([video]/[audio]) rendered by renderDay. Decide from the
 * attachment kind first, then the URL extension.
 */
export function isOcrCandidateAttachment(a: {
  type: string;
  url?: string;
}): boolean {
  if (a.type === 'photo' || a.type === 'image') return true;
  if (a.type === 'video' || a.type === 'audio') return false;
  if (a.url) {
    try {
      // A bare export-relative path (no scheme) is not a parseable URL — fall
      // back to testing the raw string's extension.
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
function deriveFilename(
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

/**
 * Persist media bytes to the content-addressed cache, first-pass-convert, and
 * upsert a 'file' doc. The on-disk filename IS the sha256 content_hash; the doc
 * carries that same content_hash so the byte source can serve the bytes back.
 *
 * markdown is null for images (and anything the converter can't read) so the
 * host's upsertDocument auto-enrolls them into deep-extraction; converter text
 * (e.g. a PDF) is stored directly. extraction_status mirrors WhatsApp's
 * storeMedia ('ok' when we have markdown, else 'unsupported'). There is NO
 * ctx.enqueueExtraction on the SDK host — enrollment is the host's job, keyed
 * off the null markdown. Returns the doc's stringified id.
 */
export async function storeMedia(args: {
  ctx: Host;
  baseDir: string;
  converter?: Converter;
  /** Stable per-attachment source id (drives idempotent upsert). */
  sourceId: string;
  threadId: string;
  messageId?: string;
  /** Epoch-ms send time of the carrying message (drives created_at). */
  sentAtMs: number;
  bytes: Buffer;
  filename: string;
  mimeType?: string;
  mediaKind?: string;
}): Promise<string> {
  const { ctx, bytes } = args;
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fsp.mkdir(args.baseDir, { recursive: true });
  // Atomic content-addressed write: a crash mid-write must never leave a partial
  // file NAMED for the full-content hash (reads don't re-validate). Rename
  // within the same dir is atomic on local filesystems.
  const finalPath = path.join(args.baseDir, hash);
  const tmpPath = `${finalPath}.part`;
  await fsp.writeFile(tmpPath, bytes, { mode: 0o600 });
  await fsp.rename(tmpPath, finalPath);

  let markdown: string | null = null;
  if (args.converter) {
    try {
      const conv = await args.converter.convert({
        kind: 'bytes',
        bytes,
        mimeType: args.mimeType ?? '',
        filename: args.filename,
      });
      markdown = conv?.markdown ?? null;
    } catch {
      markdown = null; // unsupported (e.g. image) or backpressure → deep-extraction handles it
    }
  }

  const metadata: Record<string, unknown> = {
    thread_id: args.threadId,
    filename: args.filename,
    size_bytes: bytes.length,
    extraction_status: markdown ? 'ok' : 'unsupported',
  };
  if (args.messageId !== undefined) metadata.message_id = args.messageId;
  if (args.mimeType !== undefined) metadata.mime_type = args.mimeType;
  if (args.mediaKind !== undefined) metadata.media_kind = args.mediaKind;

  const id = await ctx.upsertDocument({
    source: 'instagram',
    source_id: args.sourceId,
    type: FILE_DOC_TYPE,
    title: args.filename,
    markdown,
    metadata,
    source_url: '',
    content_hash: hash,
    created_at: new Date(args.sentAtMs),
  });
  return String(id);
}

/**
 * Create one 'file' doc per EXPORT media photo/PDF so deep-extraction can OCR/VLM
 * it. Unlike the in-tree builtin (which referenced the export folder in-place via
 * metadata.media_paths), the SDK byte source reads the content cache by
 * content_hash, so the bytes are COPIED into the cache here via storeMedia.
 *
 * Idempotent: a media doc that already exists (by stable source_id) is left
 * untouched so a re-import never clobbers OCR'd markdown. Non-OCR attachments
 * (video/audio) and missing/over-cap files are skipped. Returns the count
 * created.
 */
export async function upsertExportMediaDocs(
  ctx: Host,
  root: string,
  threadId: string,
  messages: InstagramMessage[],
  deps: { baseDir: string; converter?: Converter },
): Promise<number> {
  let count = 0;
  for (const message of messages) {
    for (const attachment of message.attachments) {
      if (!attachment.url) continue;
      if (!isOcrCandidateAttachment(attachment)) continue;
      const absolutePath = path.join(root, attachment.url);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        // export-relative uri points at a file that wasn't included in the
        // export → nothing to OCR, skip without creating a doc
        continue;
      }
      if (stat.size === 0 || stat.size > MEDIA_SIZE_CAP_BYTES) continue;

      const mediaSourceId = `media:${threadId}:${attachment.url}`;
      const existing = await ctx.findBySourceId(
        'instagram',
        mediaSourceId,
        FILE_DOC_TYPE,
      );
      if (existing) continue;

      let bytes: Buffer;
      try {
        bytes = await fsp.readFile(absolutePath);
      } catch {
        continue;
      }
      const filename = path.basename(attachment.url);
      await storeMedia({
        ctx,
        baseDir: deps.baseDir,
        converter: deps.converter,
        sourceId: mediaSourceId,
        threadId,
        sentAtMs: message.ts_ms,
        bytes,
        filename,
        mimeType: guessMimeType(filename),
        mediaKind: attachment.type,
      });
      count++;
    }
  }
  return count;
}

/**
 * Eagerly download LIVE-API DM media and persist it as OCR-able 'file' docs.
 *
 * Why eager (not lazy like the rest of deep-extraction): the Graph API hands back
 * short-lived, signed CDN URLs that have expired by the time an async extraction
 * drain would re-fetch them. So we fetch the bytes during the poll and write them
 * to the content cache; makeInstagramByteSource then serves them off disk by
 * content_hash.
 *
 * Idempotent: an attachment whose 'file' doc already exists is skipped BEFORE any
 * network fetch, so re-polls (the API returns the last ~20 msgs/thread) never
 * re-download. A failed/expired fetch is swallowed — the chat-day text
 * placeholder remains. Returns the number of new media docs created.
 */
export async function downloadLiveMediaDocs(
  ctx: Host,
  threadId: string,
  messages: InstagramMessage[],
  baseDir: string,
  deps: { fetchImpl?: typeof fetch; converter?: Converter } = {},
): Promise<number> {
  const doFetch = deps.fetchImpl ?? fetch;
  let count = 0;
  for (const message of messages) {
    for (let i = 0; i < message.attachments.length; i++) {
      const attachment = message.attachments[i];
      if (!attachment.url) continue;
      if (!isOcrCandidateAttachment(attachment)) continue;

      // Stable per-(message, slot) id → idempotent across re-polls.
      const mediaSourceId = `live-media:${threadId}:${message.id}:${i}`;
      const existing = await ctx.findBySourceId(
        'instagram',
        mediaSourceId,
        FILE_DOC_TYPE,
      );
      if (existing) continue;

      let bytes: Buffer;
      let contentType = '';
      try {
        const res = await doFetch(attachment.url);
        if (!res.ok) continue;
        contentType = (res.headers.get('content-type') ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        const declared = Number(res.headers.get('content-length') ?? '0');
        if (declared > MEDIA_SIZE_CAP_BYTES) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MEDIA_SIZE_CAP_BYTES) continue;
        bytes = buf;
      } catch {
        // expired/unreachable CDN URL → leave the chat-day text placeholder
        continue;
      }

      const filename = deriveFilename(
        attachment.url,
        contentType,
        message.id,
        i,
      );
      const mime =
        contentType &&
        (contentType.startsWith('image/') || contentType === 'application/pdf')
          ? contentType
          : guessMimeType(filename);
      // If we still can't prove it's an image/PDF, the classifier would never
      // enroll it — drop it rather than cache dead bytes.
      if (!mime || (!mime.startsWith('image/') && mime !== 'application/pdf')) {
        continue;
      }

      await storeMedia({
        ctx,
        baseDir,
        converter: deps.converter,
        sourceId: mediaSourceId,
        threadId,
        messageId: message.id,
        sentAtMs: message.ts_ms,
        bytes,
        filename,
        mimeType: mime,
        mediaKind: attachment.type,
      });
      count++;
    }
  }
  return count;
}

/**
 * Delete cached media bytes for instagram 'file' docs once they are fully
 * processed, so the cache doesn't grow without bound. HASH-WIDE, mirroring
 * WhatsApp's sweep: the on-disk filename IS the sha256 content_hash, so a shared
 * cache file is removed ONLY when (a) at least one instagram 'file' doc sharing
 * that hash is done (markdown present OR a terminal deep_extractions row), AND
 * (b) NO doc sharing it still needs the bytes (markdown NULL and no terminal
 * row). Idempotent; returns the count of files actually removed.
 *
 * Ported from the in-tree DocumentsRepository.listSweepableInstagramMediaHashes
 * to raw SQL over the host's db surface; the standalone host schema names the
 * terminal table `deep_extractions` (the in-tree query read `inference_jobs`).
 */
export async function sweepMediaCache(
  db: Db,
  baseDir: string,
): Promise<number> {
  const rows = await db.all(
    `SELECT d.content_hash AS h
       FROM documents d
      WHERE d.source = 'instagram' AND d.type = 'file' AND d.content_hash IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM documents dd
           WHERE dd.content_hash = d.content_hash AND dd.source = 'instagram' AND dd.type = 'file'
             AND (
               dd.markdown IS NOT NULL
               OR EXISTS (SELECT 1 FROM deep_extractions de
                           WHERE de.document_id = dd.id AND de.state IN ('done','skipped','failed'))
             )
        )
        AND NOT EXISTS (
          SELECT 1 FROM documents dn
           WHERE dn.content_hash = d.content_hash AND dn.source = 'instagram' AND dn.type = 'file'
             AND dn.markdown IS NULL
             AND NOT EXISTS (SELECT 1 FROM deep_extractions de
                              WHERE de.document_id = dn.id AND de.state IN ('done','skipped','failed'))
        )
      GROUP BY d.content_hash`,
  );
  let removed = 0;
  for (const r of rows) {
    try {
      await fsp.rm(path.join(baseDir, r.h as string));
      removed++;
    } catch {
      // best-effort: already gone (idempotent re-sweep) or unreadable
    }
  }
  return removed;
}
