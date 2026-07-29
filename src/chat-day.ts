/**
 * Pure chat-day helpers, ported from v1 `src/chat-day.ts`. v1's
 * upsertThreadDays (read-modify-write against the host DB) is gone: the
 * read half (prior doc's metadata.messages) now happens in source.ts pull()
 * via host.query.byExternalId, and the write half is toDocument — these
 * helpers stay I/O-free so both are unit-testable with fixtures.
 *
 * `dayKey`, `dayTitle`, and the merge logic now come from
 * `@kiagent/connector-sdk/chat-day` — this file keeps only what's
 * Instagram-specific: the external-id builder, day-grouping, and the
 * LEGACY `renderDay`, whose '**bold** (HH:MM)' markdown is a byte-for-byte
 * contract with existing day docs (the SDK's own `renderDay` uses a
 * different shape and must never be substituted here).
 */
import {
  dayKey,
  dayTitle,
  mergeMessages as sdkMergeMessages,
} from '@kiagent/connector-sdk/chat-day';
import type { InstagramMessage, InstagramThread } from './types';

export { dayKey, dayTitle };

/** v1 buildSourceId — the chat-day document's externalId. */
export function buildChatDayExternalId(threadId: string, day: string): string {
  return `thread:${threadId}:${day}`;
}

/** '**<from>** (HH:MM): <text|[photo]>' lines joined by \n\n (v1 renderDay,
 *  minus its unused thread parameter). Times are local, like dayKey.
 *  LEGACY format, pinned to existing day docs — do NOT swap for the SDK's
 *  own renderDay, which emits a different markdown shape. */
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
 *  that keeps messages the ~20-message API window has scrolled past.
 *  Delegates to the SDK's mergeMessages with Instagram's ts_ms accessor and
 *  the default lexical id comparator (same tie-break this used locally). */
export function mergeMessages(
  prior: InstagramMessage[],
  incoming: InstagramMessage[],
): InstagramMessage[] {
  return sdkMergeMessages(prior, incoming, (m) => m.ts_ms);
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
