import { buildSourceId, dayKey, upsertThreadDays } from '../chat-day';
import { DOC_TYPE } from '../types';
import type { InstagramMessage, InstagramThread } from '../types';
import { captureHost } from './mocks';
import type { Document } from '@alpha-cent/connector-sdk';

test('buildSourceId is thread + local day', () => {
  const ms = Date.UTC(2026, 5, 13, 10, 0, 0);
  expect(buildSourceId('t1', dayKey(ms))).toBe(`thread:t1:${dayKey(ms)}`);
});

test('upsertThreadDays groups by day and upserts one doc per day with sha256 hash', async () => {
  const thread: InstagramThread = {
    id: 't1',
    name: 'Alice',
    participants: ['Alice', 'me'],
    last_activity_ms: 0,
  };
  const day = Date.UTC(2026, 5, 13, 9, 0, 0);
  const msgs: InstagramMessage[] = [
    {
      id: 'm1',
      from_id: 'a',
      from_name: 'Alice',
      text: 'hi',
      ts_ms: day,
      attachments: [],
    },
    {
      id: 'm2',
      from_id: 'me',
      from_name: 'me',
      text: 'yo',
      ts_ms: day + 1000,
      attachments: [],
    },
  ];
  const { ctx, docs } = captureHost();
  await upsertThreadDays(ctx, thread, msgs);
  expect(docs).toHaveLength(1);
  expect(docs[0].source).toBe('instagram');
  expect(docs[0].type).toBe(DOC_TYPE);
  expect(docs[0].source_id).toBe(`thread:t1:${dayKey(day)}`);
  expect(docs[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(docs[0].markdown).toContain('Alice');
  expect(docs[0].markdown).toContain('hi');
});

test('re-ingesting the same messages is idempotent (merge dedups by id)', async () => {
  const thread: InstagramThread = {
    id: 't1',
    name: 'Alice',
    participants: [],
    last_activity_ms: 0,
  };
  const day = Date.UTC(2026, 5, 13, 9, 0, 0);
  const msg: InstagramMessage = {
    id: 'm1',
    from_id: 'a',
    from_name: 'Alice',
    text: 'hi',
    ts_ms: day,
    attachments: [],
  };
  let stored: { metadata: Record<string, unknown> } | null = null;
  const ctx = {
    accountId: 7n,
    findBySourceId: async () => stored as unknown as Document | null,
    upsertDocument: async (d: { metadata: Record<string, unknown> }) => {
      stored = { metadata: d.metadata };
      return 1n;
    },
  } as never;
  await upsertThreadDays(ctx, thread, [msg]);
  const first = (stored!.metadata.messages as unknown[]).length;
  await upsertThreadDays(ctx, thread, [msg]);
  expect((stored!.metadata.messages as unknown[]).length).toBe(first);
});
