/**
 * Pure chat-day helpers, ported from v1 `src/chat-day.ts`. v1's
 * upsertThreadDays (read-modify-write against the host DB) is gone: the
 * read half (prior doc's metadata.messages) now happens in source.ts pull()
 * via host.query.byExternalId, and the write half is toDocument — these
 * helpers stay I/O-free so both are unit-testable with fixtures.
 */
import type { InstagramMessage, InstagramThread } from './types';

/** Local-time YYYY-MM-DD (v1 dayKey — chat days follow the user's clock). */
export function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** v1 buildSourceId — the chat-day document's externalId. */
export function buildChatDayExternalId(threadId: string, day: string): string {
  return `thread:${threadId}:${day}`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `<thread name> — <Mon D, YYYY>` (v1 dayTitle). */
export function dayTitle(name: string, day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${name} — ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** '**<from>** (HH:MM): <text|[photo]>' lines joined by \n\n (v1 renderDay,
 *  minus its unused thread parameter). Times are local, like dayKey. */
export function renderDay(msgs: InstagramMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    const t = new Date(m.ts_ms);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const body = m.text || m.attachments.map((a) => `[${a.type}]`).join(' ');
    lines.push(`**${m.from_name}** (${hh}:${mm}): ${body}`);
  }
  return lines.join('\n\n');
}

/** Union by message id (incoming wins), sorted by ts then id — the merge
 *  that keeps messages the ~20-message API window has scrolled past. */
export function mergeMessages(
  prior: InstagramMessage[],
  incoming: InstagramMessage[],
): InstagramMessage[] {
  const byId = new Map<string, InstagramMessage>();
  for (const m of [...prior, ...incoming]) byId.set(m.id, m);
  return [...byId.values()].sort(
    (a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id),
  );
}

/** Group a thread's fetched window by local day (v1 upsertThreadDays' first
 *  half). Map iteration preserves first-seen day order. */
export function groupByDay(
  messages: InstagramMessage[],
): Map<string, InstagramMessage[]> {
  const byDay = new Map<string, InstagramMessage[]>();
  for (const m of messages) {
    const k = dayKey(m.ts_ms);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(m);
  }
  return byDay;
}

export type { InstagramMessage, InstagramThread };
