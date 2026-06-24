import type { Db, Host, Converter } from './host';
import type { InstagramClient } from './client';
import type { InstagramCursor } from './types';
import { upsertThreadDays } from './chat-day';
import { downloadLiveMediaDocs, sweepMediaCache } from './media';
import { mediaDir } from './media-dir';

export interface InstagramDeltaArgs {
  ctx: Host;
  client: InstagramClient;
  /** Override the live-media cache dir (tests pass a tmp dir). Defaults to
   *  mediaDir(ctx.dataDir). */
  mediaDir?: string;
  /** Override the downloader's fetch (tests inject a fake). */
  fetchImpl?: typeof fetch;
}

export async function runInstagramDelta(a: InstagramDeltaArgs): Promise<void> {
  const dir = a.mediaDir ?? mediaDir(a.ctx.dataDir);
  const converter = a.ctx.converter as Converter | undefined;
  const state = await a.ctx.loadSyncState();
  const prior = (state?.cursor_json as unknown as InstagramCursor | undefined)
    ?.last_activity_iso;
  const cursorMs = prior ? Date.parse(prior) : 0;

  const threads = await a.client.listThreads();
  let newestObserved = cursorMs;

  for (const thread of threads) {
    newestObserved = Math.max(newestObserved, thread.last_activity_ms);
    if (thread.last_activity_ms <= cursorMs) continue;
    const messages = await a.client.listMessages(thread.id);
    if (messages.length > 0) {
      await upsertThreadDays(a.ctx, thread, messages);
      // Eagerly persist photo attachments before their signed CDN URLs expire.
      await downloadLiveMediaDocs(a.ctx, thread.id, messages, dir, {
        fetchImpl: a.fetchImpl,
        converter,
      });
    }
  }

  // Best-effort cache hygiene: drop bytes for media already OCR'd. Never fail
  // the delta (or block the cursor advance below) over cleanup.
  if (a.ctx.db) {
    try {
      await sweepMediaCache(a.ctx.db as Db, dir);
    } catch {
      // ignore: cleanup is non-critical
    }
  }

  const flooredIso = new Date(Math.max(0, newestObserved)).toISOString();
  await a.ctx.saveSyncState({
    status: 'live',
    cursor_json: { last_activity_iso: flooredIso } as unknown as Record<
      string,
      unknown
    >,
    last_sync_at: new Date(),
  });
}
