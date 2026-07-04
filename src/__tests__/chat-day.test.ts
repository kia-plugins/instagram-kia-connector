/**
 * Pure chat-day helpers — grouping, rendering, merge-dedupe. Ported from the
 * v1 suite (`git show 16fd254:src/__tests__/chat-day.test.ts`); the
 * host-coupled upsertThreadDays tests moved to source.test.ts (the
 * read-modify-write is pull()'s job now).
 */
import {
  buildChatDayExternalId,
  dayKey,
  dayTitle,
  groupByDay,
  mergeMessages,
  renderDay,
} from '../chat-day';
import type { InstagramMessage } from '../types';

function msg(
  id: string,
  tsMs: number,
  text: string,
  extra: Partial<InstagramMessage> = {},
): InstagramMessage {
  return {
    id,
    from_id: 'a',
    from_name: 'Alice',
    text,
    ts_ms: tsMs,
    attachments: [],
    ...extra,
  };
}

test('buildChatDayExternalId is thread + local day', () => {
  const ms = Date.UTC(2026, 5, 13, 10, 0, 0);
  expect(buildChatDayExternalId('t1', dayKey(ms))).toBe(
    `thread:t1:${dayKey(ms)}`,
  );
});

test('dayKey is a local-time YYYY-MM-DD', () => {
  const ms = Date.UTC(2026, 5, 13, 10, 0, 0);
  expect(dayKey(ms)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // same instant → same key; +24h → different key
  expect(dayKey(ms)).toBe(dayKey(ms));
  expect(dayKey(ms + 24 * 3600 * 1000)).not.toBe(dayKey(ms));
});

test('dayTitle renders "<name> — <Mon D, YYYY>"', () => {
  expect(dayTitle('Alice', '2026-06-13')).toBe('Alice — Jun 13, 2026');
  expect(dayTitle('Group chat', '2024-01-02')).toBe('Group chat — Jan 2, 2024');
});

test('renderDay emits "**<from>** (HH:MM): <text>" lines joined by blank lines', () => {
  const t = Date.UTC(2026, 5, 13, 9, 5, 0);
  const md = renderDay([msg('m1', t, 'hi'), msg('m2', t + 60_000, 'yo')]);
  const lines = md.split('\n\n');
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\*\*Alice\*\* \(\d{2}:\d{2}\): hi$/);
  expect(lines[1]).toMatch(/^\*\*Alice\*\* \(\d{2}:\d{2}\): yo$/);
});

test('renderDay falls back to [type] placeholders for attachment-only messages', () => {
  const t = Date.UTC(2026, 5, 13, 9, 0, 0);
  const md = renderDay([
    msg('m1', t, '', {
      attachments: [
        { type: 'photo', url: 'https://cdn.example/p.jpg' },
        { type: 'video', url: 'https://cdn.example/v.mp4' },
      ],
    }),
  ]);
  expect(md).toContain('[photo] [video]');
});

test('mergeMessages unions by id (incoming wins) and sorts by ts then id', () => {
  const t = Date.UTC(2026, 5, 13, 9, 0, 0);
  const prior = [msg('m1', t, 'old text'), msg('m0', t - 60_000, 'scrolled out')];
  const incoming = [msg('m1', t, 'edited'), msg('m2', t + 60_000, 'new')];

  const merged = mergeMessages(prior, incoming);

  expect(merged.map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
  expect(merged[1].text).toBe('edited'); // incoming replaced prior m1
});

test('mergeMessages is idempotent — re-merging the same window changes nothing', () => {
  const t = Date.UTC(2026, 5, 13, 9, 0, 0);
  const window = [msg('m1', t, 'hi'), msg('m2', t + 1000, 'yo')];
  const once = mergeMessages([], window);
  const twice = mergeMessages(once, window);
  expect(twice).toEqual(once);
});

test('mergeMessages breaks ts ties by id', () => {
  const t = Date.UTC(2026, 5, 13, 9, 0, 0);
  const merged = mergeMessages([msg('b', t, 'second')], [msg('a', t, 'first')]);
  expect(merged.map((m) => m.id)).toEqual(['a', 'b']);
});

test('groupByDay buckets by local day preserving first-seen order', () => {
  const d1 = Date.UTC(2026, 5, 13, 12, 0, 0);
  const d2 = d1 + 24 * 3600 * 1000;
  const grouped = groupByDay([
    msg('m1', d1, 'a'),
    msg('m2', d2, 'b'),
    msg('m3', d1 + 1000, 'c'),
  ]);
  expect([...grouped.keys()]).toEqual([dayKey(d1), dayKey(d2)]);
  expect(grouped.get(dayKey(d1))!.map((m) => m.id)).toEqual(['m1', 'm3']);
  expect(grouped.get(dayKey(d2))!.map((m) => m.id)).toEqual(['m2']);
});
