/** @jest-environment node */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runInstagramDelta } from '../delta';
import { openTestDb } from './harness';
import { captureHost, fakeClient, fakeMediaResponse } from './mocks';
import type { InstagramThread, InstagramMessage } from '../types';

const EPOCH_STATE = {
  status: 'live' as const,
  cursor_json: { last_activity_iso: new Date(0).toISOString() },
};

test('ingests threads newer than cursor and advances cursor to newest observed', async () => {
  const newMs = Date.UTC(2026, 5, 13, 12, 0, 0);
  const threads: InstagramThread[] = [
    { id: 't1', name: 'Alice', participants: [], last_activity_ms: newMs },
  ];
  const msgs: InstagramMessage[] = [
    {
      id: 'm1',
      from_id: 'a',
      from_name: 'Alice',
      text: 'hi',
      ts_ms: newMs,
      attachments: [],
    },
  ];
  const { ctx, box } = captureHost({ state: EPOCH_STATE });
  await runInstagramDelta({ ctx, client: fakeClient(threads, { t1: msgs }) });
  expect(box.state!.status).toBe('live');
  expect(
    (box.state!.cursor_json as { last_activity_iso: string }).last_activity_iso,
  ).toBe(new Date(newMs).toISOString());
});

test('empty inbox still persists a cursor floored at epoch', async () => {
  const { ctx, box } = captureHost({ state: EPOCH_STATE });
  await runInstagramDelta({ ctx, client: fakeClient([], {}) });
  expect(
    (box.state!.cursor_json as { last_activity_iso: string }).last_activity_iso,
  ).toBe(new Date(0).toISOString());
});

test('eagerly downloads live photo media into the content cache during a delta', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-delta-media-'));
  const db = openTestDb();
  try {
    const newMs = Date.UTC(2026, 5, 13, 12, 0, 0);
    const threads: InstagramThread[] = [
      { id: 't1', name: 'Alice', participants: [], last_activity_ms: newMs },
    ];
    const msgs: InstagramMessage[] = [
      {
        id: 'm1',
        from_id: 'a',
        from_name: 'Alice',
        text: '',
        ts_ms: newMs,
        attachments: [{ type: 'photo', url: 'https://cdn.example/p.jpg?sig=1' }],
      },
    ];
    // db is wired so the post-delta sweepMediaCache() SQL runs against the real
    // schema (empty documents → removes nothing, just proves it compiles/runs).
    const { ctx, docs } = captureHost({ db, state: EPOCH_STATE });
    const png = Buffer.alloc(10 * 1024, 0x7f);
    const fetchImpl = (async () =>
      fakeMediaResponse(png)) as unknown as typeof fetch;

    await runInstagramDelta({
      ctx,
      client: fakeClient(threads, { t1: msgs }),
      mediaDir: cacheDir,
      fetchImpl,
    });

    const fileDocs = docs.filter((d) => d.type === 'file');
    expect(fileDocs).toHaveLength(1);
    expect((fileDocs[0].metadata as Record<string, unknown>).mime_type).toBe(
      'image/jpeg',
    );
    expect(
      fs.existsSync(path.join(cacheDir, fileDocs[0].content_hash!)),
    ).toBe(true);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    await db.close();
  }
});
