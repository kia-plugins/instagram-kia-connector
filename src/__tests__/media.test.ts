/** @jest-environment node */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { Document } from '@kiagent/connector-sdk';
import type { InstagramMessage } from '../types';
import {
  guessMimeType,
  upsertExportMediaDocs,
  downloadLiveMediaDocs,
  FILE_DOC_TYPE,
} from '../media';
import { mediaDir } from '../media-dir';
import { makeInstagramByteSource } from '../byte-source';
import { captureHost, fakeMediaResponse } from './mocks';

// A placeholder larger than the host's tiny-image threshold so it is treated as
// a real OCR candidate rather than a tracking pixel.
const BIG_JPEG = Buffer.alloc(10 * 1024, 0x7f);

describe('guessMimeType', () => {
  test('maps known extensions case-insensitively', () => {
    expect(guessMimeType('photo.JPG')).toBe('image/jpeg');
    expect(guessMimeType('img.png')).toBe('image/png');
  });
  test('returns undefined for unknown extensions', () => {
    expect(guessMimeType('weird.xyz')).toBeUndefined();
  });
});

describe('upsertExportMediaDocs (copies export bytes into the content cache)', () => {
  let dataRoot: string;
  let baseDir: string;
  let root: string;
  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-data-'));
    baseDir = mediaDir(dataRoot);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-export-'));
  });
  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeMedia(relUrl: string): void {
    const abs = path.join(root, relUrl);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, BIG_JPEG);
  }

  function msgWith(url: string, type = 'photo'): InstagramMessage {
    return {
      id: 'm1',
      from_id: 'Alice',
      from_name: 'Alice',
      text: '',
      ts_ms: 1749810000000,
      attachments: [{ type, url }],
    };
  }

  test('creates a null-markdown file doc, caches bytes by content_hash, round-trips via the byte source', async () => {
    const relUrl =
      'your_instagram_activity/messages/inbox/alice/photos/pic.jpg';
    writeMedia(relUrl);
    const { ctx, docs } = captureHost();

    const n = await upsertExportMediaDocs(ctx, root, 'alice_123', [
      msgWith(relUrl),
    ], { baseDir });

    expect(n).toBe(1);
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.source).toBe('instagram');
    expect(doc.type).toBe(FILE_DOC_TYPE);
    expect(doc.type).toBe('file');
    expect(doc.markdown).toBeNull();
    expect(doc.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const meta = doc.metadata as Record<string, unknown>;
    expect(meta.mime_type).toBe('image/jpeg');
    expect(meta.filename).toBe('pic.jpg');
    expect(meta.size_bytes as number).toBeGreaterThan(0);
    expect(meta.extraction_status).toBe('unsupported');
    expect(meta.thread_id).toBe('alice_123');
    expect(meta.media_kind).toBe('photo');

    // Bytes landed in the content cache keyed by content_hash.
    const cached = path.join(baseDir, doc.content_hash!);
    expect(fs.existsSync(cached)).toBe(true);
    expect(fs.readFileSync(cached).equals(BIG_JPEG)).toBe(true);

    // The fetch-model byte source serves them back by content_hash.
    const src = makeInstagramByteSource(dataRoot);
    const r = await src.fetch({}, { content_hash: doc.content_hash });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.equals(BIG_JPEG)).toBe(true);
  });

  test('is idempotent: skips media that already has a doc (no copy)', async () => {
    const relUrl = 'photos/existing.jpg';
    writeMedia(relUrl);
    const { ctx, docs } = captureHost({ existing: { id: 99n } as Document });

    const n = await upsertExportMediaDocs(ctx, root, 'alice_123', [
      msgWith(relUrl),
    ], { baseDir });

    expect(n).toBe(0);
    expect(docs).toHaveLength(0);
    expect(fs.existsSync(baseDir) ? fs.readdirSync(baseDir) : []).toHaveLength(
      0,
    );
  });

  test('skips attachments whose file is missing (no doc, no throw)', async () => {
    const { ctx, docs } = captureHost();
    const n = await upsertExportMediaDocs(ctx, root, 'alice_123', [
      msgWith('photos/does-not-exist.jpg'),
    ], { baseDir });
    expect(n).toBe(0);
    expect(docs).toHaveLength(0);
  });

  test('skips non-OCR attachments (video) without copying', async () => {
    const relUrl = 'videos/clip.mp4';
    writeMedia(relUrl);
    const { ctx, docs } = captureHost();
    const n = await upsertExportMediaDocs(ctx, root, 'alice_123', [
      msgWith(relUrl, 'video'),
    ], { baseDir });
    expect(n).toBe(0);
    expect(docs).toHaveLength(0);
  });
});

describe('downloadLiveMediaDocs (eager live-media capture into the content cache)', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-live-cache-'));
  });
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  function liveMsg(
    attachments: { type: string; url?: string }[],
  ): InstagramMessage {
    return {
      id: 'mLive',
      from_id: 'Bob',
      from_name: 'Bob',
      text: '',
      ts_ms: 1749810000000,
      attachments,
    };
  }

  test('downloads a photo, caches bytes by content_hash, creates a null-markdown file doc', async () => {
    const { ctx, docs } = captureHost();
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(fakeMediaResponse(BIG_JPEG)) as unknown as typeof fetch;

    const n = await downloadLiveMediaDocs(
      ctx,
      'thread1',
      [liveMsg([{ type: 'photo', url: 'https://cdn.example/abc.jpg?sig=1' }])],
      cacheDir,
      { fetchImpl },
    );

    expect(n).toBe(1);
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.source).toBe('instagram');
    expect(doc.type).toBe(FILE_DOC_TYPE);
    expect(doc.markdown).toBeNull();
    const meta = doc.metadata as Record<string, unknown>;
    expect(meta.mime_type).toBe('image/jpeg');
    expect(meta.extraction_status).toBe('unsupported');
    expect(meta.thread_id).toBe('thread1');
    expect(meta.message_id).toBe('mLive');
    // the cache filename is the sha256 of the bytes == content_hash
    const cached = path.join(cacheDir, doc.content_hash!);
    expect(fs.existsSync(cached)).toBe(true);
    expect(fs.readFileSync(cached).equals(BIG_JPEG)).toBe(true);
  });

  test('is idempotent: existing doc → no fetch, no write', async () => {
    const { ctx, docs } = captureHost({ existing: { id: 5n } as Document });
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const n = await downloadLiveMediaDocs(
      ctx,
      'thread1',
      [liveMsg([{ type: 'photo', url: 'https://cdn.example/abc.jpg' }])],
      cacheDir,
      { fetchImpl },
    );
    expect(n).toBe(0);
    expect(docs).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.readdirSync(cacheDir)).toHaveLength(0);
  });

  test('skips videos (not OCR candidates) without fetching', async () => {
    const { ctx, docs } = captureHost();
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const n = await downloadLiveMediaDocs(
      ctx,
      'thread1',
      [liveMsg([{ type: 'video', url: 'https://cdn.example/clip.mp4' }])],
      cacheDir,
      { fetchImpl },
    );
    expect(n).toBe(0);
    expect(docs).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an expired/failed fetch leaves no doc and never throws', async () => {
    const { ctx, docs } = captureHost();
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new Error('410 Gone')) as unknown as typeof fetch;
    const n = await downloadLiveMediaDocs(
      ctx,
      'thread1',
      [liveMsg([{ type: 'photo', url: 'https://cdn.example/expired.jpg' }])],
      cacheDir,
      { fetchImpl },
    );
    expect(n).toBe(0);
    expect(docs).toHaveLength(0);
    expect(fs.readdirSync(cacheDir)).toHaveLength(0);
  });
});
