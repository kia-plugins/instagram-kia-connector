import crypto from 'node:crypto';
import type { Host } from './host';
import { DOC_TYPE } from './types';
import type { InstagramMessage, InstagramThread } from './types';

export function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function buildSourceId(threadId: string, day: string): string {
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
function dayTitle(name: string, day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${name} — ${MONTHS[m - 1]} ${d}, ${y}`;
}

export function renderDay(
  thread: InstagramThread,
  msgs: InstagramMessage[],
): string {
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

function mergeMessages(
  prior: InstagramMessage[],
  incoming: InstagramMessage[],
): InstagramMessage[] {
  const byId = new Map<string, InstagramMessage>();
  for (const m of [...prior, ...incoming]) byId.set(m.id, m);
  return [...byId.values()].sort(
    (a, b) => a.ts_ms - b.ts_ms || a.id.localeCompare(b.id),
  );
}

export async function upsertThreadDays(
  ctx: Host,
  thread: InstagramThread,
  messages: InstagramMessage[],
): Promise<void> {
  const byDay = new Map<string, InstagramMessage[]>();
  for (const m of messages) {
    const k = dayKey(m.ts_ms);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(m);
  }

  for (const [day, incoming] of byDay) {
    const sourceId = buildSourceId(thread.id, day);
    const prior = await ctx.findBySourceId('instagram', sourceId, DOC_TYPE);
    const priorMsgs =
      (prior?.metadata?.messages as InstagramMessage[] | undefined) ?? [];
    const merged = mergeMessages(priorMsgs, incoming);
    const markdown = renderDay(thread, merged);
    const content_hash = crypto
      .createHash('sha256')
      .update(markdown)
      .digest('hex');
    const lastTs = merged[merged.length - 1]?.ts_ms ?? Date.now();

    await ctx.upsertDocument({
      source: 'instagram',
      source_id: sourceId,
      type: DOC_TYPE,
      title: dayTitle(thread.name, day),
      markdown,
      content_hash,
      metadata: {
        thread_id: thread.id,
        thread_name: thread.name,
        participants: thread.participants,
        last_message_at: new Date(lastTs).toISOString(),
        messages: merged,
      },
      source_url: `https://www.instagram.com/direct/t/${thread.id}/`,
      created_at: new Date(merged[0]?.ts_ms ?? lastTs),
    });
  }
}
