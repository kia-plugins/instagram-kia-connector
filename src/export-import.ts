import fs from 'node:fs';
import path from 'node:path';
import type { ProgressSink } from '@kiagent/connector-sdk';
import type { Host, Converter } from './host';
import type { InstagramMessage, InstagramThread } from './types';
import { upsertThreadDays } from './chat-day';
import { upsertExportMediaDocs } from './media';

export function fixMetaMojibake(s: string): string {
  return Buffer.from(s, 'latin1').toString('utf8');
}

interface RawThread {
  participants?: { name?: string }[];
  thread_path?: string;
  messages?: {
    sender_name?: string;
    timestamp_ms?: number;
    content?: string;
    photos?: { uri: string }[];
    videos?: { uri: string }[];
    audio_files?: { uri: string }[];
  }[];
}

export function parseThreadJson(
  raw: RawThread,
  threadId: string,
  fileTag = '',
): { thread: InstagramThread; messages: InstagramMessage[] } {
  const participants = (raw.participants ?? [])
    .map((p) => fixMetaMojibake(p.name ?? ''))
    .filter(Boolean);
  const messages: InstagramMessage[] = (raw.messages ?? []).map((m, i) => {
    const media = [
      ...(m.photos ?? []).map((x) => ({ type: 'photo', url: x.uri })),
      ...(m.videos ?? []).map((x) => ({ type: 'video', url: x.uri })),
      ...(m.audio_files ?? []).map((x) => ({ type: 'audio', url: x.uri })),
    ];
    return {
      // fileTag keeps ids unique across paginated message_N.json files, where
      // the per-file index `i` resets and timestamps can repeat.
      id: `${threadId}:${fileTag}${m.timestamp_ms ?? 0}:${i}`,
      from_id: fixMetaMojibake(m.sender_name ?? ''),
      from_name: fixMetaMojibake(m.sender_name ?? ''),
      text: m.content ? fixMetaMojibake(m.content) : '',
      ts_ms: m.timestamp_ms ?? 0,
      attachments: media,
    };
  });
  return {
    thread: {
      id: threadId,
      name: participants.join(', ') || threadId,
      participants,
      last_activity_ms: 0,
    },
    messages,
  };
}

export function findThreadDirs(root: string): string[] {
  const inbox = path.join(root, 'your_instagram_activity', 'messages', 'inbox');
  if (!fs.existsSync(inbox)) return [];
  return fs
    .readdirSync(inbox)
    .map((d) => path.join(inbox, d))
    .filter((p) => fs.statSync(p).isDirectory());
}

export async function importExportFolder(
  ctx: Host,
  root: string,
  progress: ProgressSink,
  deps: { baseDir: string; converter?: Converter },
): Promise<{ threads: number; days: number; media: number }> {
  const dirs = findThreadDirs(root);
  let days = 0;
  let mediaCount = 0;
  let done = 0;
  for (const dir of dirs) {
    const threadId = path.basename(dir);
    const jsonFiles = fs
      .readdirSync(dir)
      .filter((f) => /^message_\d+\.json$/.test(f));
    const all: InstagramMessage[] = [];
    let thread: InstagramThread | null = null;
    for (const f of jsonFiles) {
      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, f), 'utf8'),
      ) as RawThread;
      const parsed = parseThreadJson(raw, threadId, `${f}:`);
      thread = parsed.thread;
      all.push(...parsed.messages);
    }
    if (thread && all.length) {
      await upsertThreadDays(ctx, thread, all);
      mediaCount += await upsertExportMediaDocs(ctx, root, threadId, all, deps);
      days += new Set(all.map((m) => new Date(m.ts_ms).toDateString())).size;
    }
    done += 1;
    progress.update(done, dirs.length);
  }
  return { threads: dirs.length, days, media: mediaCount };
}
