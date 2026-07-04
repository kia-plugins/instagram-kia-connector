/**
 * Media policy + eager downloader. Pure helpers ported from the v1 suite
 * (`git show 16fd254:src/__tests__/media.test.ts`); downloadThreadMedia is
 * exercised directly with fake deps here (no disk cache anymore — items
 * carry bytes). Pull-level behavior (same-batch parent, query-backed
 * idempotency) lives in source.test.ts.
 */
import {
  MEDIA_SIZE_CAP_BYTES,
  deriveFilename,
  downloadThreadMedia,
  guessMimeType,
  isOcrCandidateAttachment,
  type MediaDownloadDeps,
} from '../media';
import { dayKey } from '../chat-day';
import type { InstagramMessage } from '../types';

const BIG_JPEG = new Uint8Array(10 * 1024).fill(0x7f);

function bytesResponse(
  status: number,
  body: Uint8Array,
  headers: Record<string, string> = {},
) {
  return { status, statusText: '', headers, body };
}

function liveMsg(
  attachments: { type: string; url?: string }[],
  id = 'mLive',
): InstagramMessage {
  return {
    id,
    from_id: 'bob',
    from_name: 'Bob',
    text: '',
    ts_ms: Date.UTC(2026, 5, 13, 12, 0, 0),
    attachments,
  };
}

function makeDeps(
  responses: unknown[],
  { hasDoc = async () => false }: { hasDoc?: (id: string) => Promise<boolean> } = {},
) {
  const fetched: string[] = [];
  const warnings: string[] = [];
  let i = 0;
  const deps: MediaDownloadDeps = {
    fetch: async (url) => {
      fetched.push(url);
      const res = responses[i];
      i += 1;
      if (res === undefined) throw new Error(`no scripted media response for ${url}`);
      if (res instanceof Error) throw res;
      return res;
    },
    hasDoc,
    warn: (msg) => {
      warnings.push(msg);
    },
  };
  return { deps, fetched, warnings };
}

describe('guessMimeType', () => {
  test('maps known extensions case-insensitively', () => {
    expect(guessMimeType('photo.JPG')).toBe('image/jpeg');
    expect(guessMimeType('img.png')).toBe('image/png');
    expect(guessMimeType('doc.pdf')).toBe('application/pdf');
  });
  test('returns undefined for unknown extensions', () => {
    expect(guessMimeType('weird.xyz')).toBeUndefined();
  });
});

describe('isOcrCandidateAttachment', () => {
  test('photo/image kinds are candidates; video/audio never are', () => {
    expect(isOcrCandidateAttachment({ type: 'photo' })).toBe(true);
    expect(isOcrCandidateAttachment({ type: 'image' })).toBe(true);
    expect(isOcrCandidateAttachment({ type: 'video', url: 'https://x/v.jpg' })).toBe(false);
    expect(isOcrCandidateAttachment({ type: 'audio' })).toBe(false);
  });
  test('unknown kinds fall back to the URL extension', () => {
    expect(
      isOcrCandidateAttachment({ type: 'media', url: 'https://cdn.example/a/p.jpeg?sig=1' }),
    ).toBe(true);
    expect(
      isOcrCandidateAttachment({ type: 'media', url: 'https://cdn.example/doc.pdf' }),
    ).toBe(true);
    expect(
      isOcrCandidateAttachment({ type: 'media', url: 'https://cdn.example/clip.mp4' }),
    ).toBe(false);
    expect(isOcrCandidateAttachment({ type: 'media' })).toBe(false);
  });
});

describe('deriveFilename', () => {
  test('uses the URL basename when it has an extension', () => {
    expect(deriveFilename('https://cdn.example/a/pic.jpg?sig=1', 'image/jpeg', 'm1', 0)).toBe(
      'pic.jpg',
    );
  });
  test('synthesizes <msgId>_<slot><ext> from the content type otherwise', () => {
    expect(deriveFilename('https://cdn.example/blob', 'image/png', 'm1', 2)).toBe('m1_2.png');
    expect(deriveFilename('https://cdn.example/blob', '', 'm1', 0)).toBe('m1_0');
  });
});

describe('downloadThreadMedia', () => {
  test('downloads a photo and returns a MediaItem with stable externalId, mime, day, bytes', async () => {
    const { deps, fetched, warnings } = makeDeps([
      bytesResponse(200, BIG_JPEG, { 'content-type': 'image/jpeg' }),
    ]);
    const msg = liveMsg([{ type: 'photo', url: 'https://cdn.example/abc.jpg?sig=1' }]);

    const items = await downloadThreadMedia(deps, 'thread1', [msg]);

    expect(fetched).toEqual(['https://cdn.example/abc.jpg?sig=1']);
    expect(warnings).toEqual([]);
    expect(items).toEqual([
      {
        kind: 'media',
        externalId: 'live-media:thread1:mLive:0',
        threadId: 'thread1',
        messageId: 'mLive',
        day: dayKey(msg.ts_ms),
        filename: 'abc.jpg',
        mime: 'image/jpeg',
        bytes: BIG_JPEG,
        sentAtMs: msg.ts_ms,
      },
    ]);
  });

  test('skips an attachment whose doc already exists — no fetch at all', async () => {
    const { deps, fetched } = makeDeps([], {
      hasDoc: async (id) => id === 'live-media:thread1:mLive:0',
    });
    const items = await downloadThreadMedia(deps, 'thread1', [
      liveMsg([{ type: 'photo', url: 'https://cdn.example/abc.jpg' }]),
    ]);
    expect(items).toEqual([]);
    expect(fetched).toEqual([]);
  });

  test('skips videos (not OCR candidates) without fetching', async () => {
    const { deps, fetched } = makeDeps([]);
    const items = await downloadThreadMedia(deps, 'thread1', [
      liveMsg([{ type: 'video', url: 'https://cdn.example/clip.mp4' }]),
    ]);
    expect(items).toEqual([]);
    expect(fetched).toEqual([]);
  });

  test('skips media over the 25 MiB cap — declared via content-length or actual body size', async () => {
    const { deps } = makeDeps([
      bytesResponse(200, BIG_JPEG, {
        'content-type': 'image/jpeg',
        'content-length': String(MEDIA_SIZE_CAP_BYTES + 1),
      }),
      bytesResponse(200, new Uint8Array(MEDIA_SIZE_CAP_BYTES + 1), {
        'content-type': 'image/jpeg',
      }),
      bytesResponse(200, new Uint8Array(0), { 'content-type': 'image/jpeg' }),
    ]);
    const msgs = [
      liveMsg([{ type: 'photo', url: 'https://cdn.example/declared-huge.jpg' }], 'm1'),
      liveMsg([{ type: 'photo', url: 'https://cdn.example/actually-huge.jpg' }], 'm2'),
      liveMsg([{ type: 'photo', url: 'https://cdn.example/empty.jpg' }], 'm3'),
    ];
    expect(await downloadThreadMedia(deps, 'thread1', msgs)).toEqual([]);
  });

  test('an expired/failed CDN fetch is tolerated: warn, skip, keep going', async () => {
    const { deps, warnings } = makeDeps([
      new Error('410 Gone'),
      bytesResponse(404, new Uint8Array(0), {}),
      bytesResponse(200, BIG_JPEG, { 'content-type': 'image/jpeg' }),
    ]);
    const msgs = [
      liveMsg([{ type: 'photo', url: 'https://cdn.example/expired.jpg' }], 'm1'),
      liveMsg([{ type: 'photo', url: 'https://cdn.example/gone.jpg' }], 'm2'),
      liveMsg([{ type: 'photo', url: 'https://cdn.example/ok.jpg' }], 'm3'),
    ];

    const items = await downloadThreadMedia(deps, 'thread1', msgs);

    expect(items.map((i) => i.externalId)).toEqual(['live-media:thread1:m3:0']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('live-media:thread1:m1:0');
    expect(warnings[1]).toContain('live-media:thread1:m2:0');
  });

  test('drops bytes it cannot prove are image/PDF (unknown content-type, no usable extension)', async () => {
    const { deps } = makeDeps([
      bytesResponse(200, BIG_JPEG, { 'content-type': 'application/octet-stream' }),
    ]);
    const items = await downloadThreadMedia(deps, 'thread1', [
      // kind 'image' passes the candidate gate, but the response proves nothing
      liveMsg([{ type: 'image', url: 'https://cdn.example/blob' }]),
    ]);
    expect(items).toEqual([]);
  });

  test('trusts an image content-type over a missing extension and synthesizes the filename', async () => {
    const { deps } = makeDeps([
      bytesResponse(200, BIG_JPEG, { 'content-type': 'image/png; charset=binary' }),
    ]);
    const items = await downloadThreadMedia(deps, 'thread1', [
      liveMsg([{ type: 'photo', url: 'https://cdn.example/blob' }]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].mime).toBe('image/png');
    expect(items[0].filename).toBe('mLive_0.png');
  });
});
