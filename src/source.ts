/**
 * Instagram v2 source: paste-token connect via the engine's password vault,
 * a delta-only pull (port of v1 `src/delta.ts` runInstagramDelta), and a
 * pure toDocument. Instagram indexes DIRECT MESSAGES — not posts/stories.
 *
 * The API shape that drives the whole design: `GET /{threadId}/messages`
 * has NO pagination and returns only the last ~20 messages per thread, and
 * `GET /me/conversations` exposes no history either. So:
 *
 *  - There is no true backfill. A null cursor = epoch floor, and the very
 *    first sweep IS the initial fetch; every batch is `phase: 'live'`.
 *  - THE MERGE (why the 'query' cap): a chat-day re-rendered from the
 *    current 20-message window alone would LOSE messages that scrolled out.
 *    v1 solved this with a read-modify-write on metadata.messages; v2 does
 *    the same read in pull() via host.query.byExternalId — the prior doc's
 *    metadata.messages is the full ledger, unioned with the fetched window
 *    (dedupe by id, sort by ts then id). The item carries the FULL merged
 *    list, so toDocument stays pure and the NEXT merge reads it back.
 *
 * Deliberate omissions (vs. the Source interface):
 *  - No fetchBytes: the CDN URLs are signed and short-lived — media bytes
 *    ride ingest (DocumentInput.binary) during the same pull that saw the
 *    URL; there is nothing durable to re-fetch later.
 *  - No reconcile(): the API lists neither deletions nor history — only the
 *    last ~20 messages/thread are visible, so any "full listing" would be a
 *    partial live-set and the engine would mass-archive real history.
 */
import type {
  AuthChannel,
  Batch,
  HostFor,
  Session,
  Source,
} from './kiagent-contracts';
import {
  InstagramAuthError,
  InstagramClient,
  type InstagramClientDeps,
  type NetFetch,
} from './client';
import {
  buildChatDayExternalId,
  dayTitle,
  groupByDay,
  mergeMessages,
  renderDay,
} from './chat-day';
import { downloadThreadMedia } from './media';
import {
  CHAT_DAY_DOC_TYPE,
  FILE_DOC_TYPE,
  type ChatDayItem,
  type InstagramCursor,
  type InstagramItem,
  type InstagramMessage,
  type InstagramThread,
} from './types';

const EPOCH_ISO = new Date(0).toISOString();

async function requireToken(session: Session): Promise<string> {
  const creds = await session.credentials();
  const token = creds?.password;
  if (!token)
    throw new Error('no Instagram credentials — reconnect the account');
  return token;
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export function createInstagramSource(
  host: HostFor<'net' | 'query'>,
  // Test seam only: the client's retry backoff resolves instantly instead of
  // really sleeping; production callers omit this.
  clock?: Pick<InstagramClientDeps, 'sleep'>,
): Source<InstagramCursor, InstagramItem> {
  const netFetch = host.net.fetch as NetFetch;

  /** One merged chat-day item per local day of the fetched window. */
  async function buildDayItems(
    session: Session,
    thread: InstagramThread,
    messages: InstagramMessage[],
  ): Promise<ChatDayItem[]> {
    const items: ChatDayItem[] = [];
    for (const [day, incoming] of groupByDay(messages)) {
      const externalId = buildChatDayExternalId(thread.id, day);
      const prior = await host.query.byExternalId(
        session.account.id,
        externalId,
        CHAT_DAY_DOC_TYPE,
      );
      const priorMsgs =
        (prior?.metadata?.messages as InstagramMessage[] | undefined) ?? [];
      items.push({
        kind: 'chat_day',
        thread: {
          id: thread.id,
          name: thread.name,
          participants: thread.participants,
        },
        day,
        messages: mergeMessages(priorMsgs, incoming),
      });
    }
    return items;
  }

  return {
    descriptor: {
      id: 'instagram',
      name: 'Instagram',
      documentTypes: [CHAT_DAY_DOC_TYPE, FILE_DOC_TYPE],
      auth: 'password',
      multiAccount: true,
      cadence: { every: '15m' },
    },

    async connect(auth: AuthChannel) {
      const answers = await auth.prompt({
        type: 'object',
        description:
          'Reads your Instagram DMs via the official API. Requires an Instagram Professional (Business or Creator) account linked to a Facebook Page.',
        'x-steps': [
          {
            title: 'Create a Meta app',
            body: 'Create an app (Business type), add the Instagram product, and connect your Instagram Professional account.',
            link: 'https://developers.facebook.com/apps',
          },
          {
            title: 'Generate a long-lived access token',
            body: 'Grant the instagram_business_manage_messages permission, then generate a long-lived token with the Access Token Tool.',
          },
        ],
        required: ['password'],
        properties: {
          password: {
            type: 'string',
            title: 'Instagram access token',
            format: 'password',
            examples: ['Long-lived token…'],
            description:
              'Long-lived tokens expire after ~60 days — when the account shows "needs reauth", paste a fresh one.',
          },
        },
      });
      const token =
        typeof answers.password === 'string' ? answers.password.trim() : '';
      // v1 validateInstagramToken's fast emptiness guard; the /me call below
      // is the authoritative check.
      if (token.length < 5) {
        throw new Error('Paste a valid long-lived Instagram access token.');
      }
      const client = new InstagramClient({ fetch: netFetch, token, ...clock });
      const me = await client.getMe();
      if (!me.id) {
        throw new Error(
          'Instagram did not return an account id for this token.',
        );
      }
      return {
        identifier: me.username ?? me.id,
        config: { ig_user_id: me.id },
      };
    },

    async *pull(
      session: Session,
      cursor: InstagramCursor | null,
    ): AsyncGenerator<Batch<InstagramCursor, InstagramItem>> {
      const token = await requireToken(session);
      const client = new InstagramClient({
        fetch: netFetch,
        token,
        log: (msg) => session.log('warn', msg),
        ...clock,
      });

      // Null cursor = epoch: that IS the initial fetch (no true backfill —
      // the API exposes no history), so every batch is phase 'live'.
      const committed: InstagramCursor = cursor ?? {
        last_activity_iso: EPOCH_ISO,
      };
      const cursorMs = Date.parse(committed.last_activity_iso) || 0;

      const threads = await client.listThreads();
      // Track the sweep's high-water mark, but do NOT advance the committed
      // cursor mid-sweep: re-polling a thread is idempotent (merge by id,
      // upsert by externalId), so a crash at any batch boundary just
      // re-sweeps from the old cursor. Note a thread that FAILS below still
      // advances this mark — the skip is durable (shared-brief per-container
      // rule); its messages return on its next activity.
      let newestObserved = cursorMs;

      for (const thread of threads) {
        // Belt-and-suspenders (the client already floors unparseable
        // updated_time to 0): a non-finite value folded into Math.max would
        // make the final cursor's toISOString() throw at the END of every
        // sweep — a permanently failing pull.
        if (Number.isFinite(thread.last_activity_ms)) {
          newestObserved = Math.max(newestObserved, thread.last_activity_ms);
        }
        if (thread.last_activity_ms <= cursorMs) continue;
        if (session.signal.aborted) return;
        try {
          const messages = (await client.listMessages(thread.id)).filter(
            (m) => {
              if (Number.isFinite(m.ts_ms)) return true;
              // An unparseable created_time would render day 'NaN-NaN-NaN'
              // (a broken externalId) and a throwing toISOString() in
              // toDocument — skip just that message, keep the thread.
              session.log(
                'warn',
                `instagram: message ${m.id} in thread ${thread.id} skipped: unparseable created_time`,
              );
              return false;
            },
          );
          if (messages.length === 0) continue;
          const dayItems = await buildDayItems(session, thread, messages);
          // Eager media download, idempotent BEFORE the fetch: an attachment
          // whose 'file' doc already exists is never re-downloaded.
          const mediaItems = await downloadThreadMedia(
            {
              fetch: netFetch,
              hasDoc: async (externalId) =>
                (await host.query.byExternalId(
                  session.account.id,
                  externalId,
                  FILE_DOC_TYPE,
                )) !== null,
              warn: (msg) => session.log('warn', msg),
            },
            thread.id,
            messages,
          );
          // ONE batch per thread — media docs commit WITH their parent day.
          yield {
            phase: 'live',
            items: [...dayItems, ...mediaItems],
            cursor: committed,
          };
        } catch (e) {
          // One broken thread must not abort the sweep; auth errors
          // propagate — every later call would fail identically and the
          // engine flips the account to needsReauth.
          if (e instanceof InstagramAuthError) throw e;
          session.log(
            'warn',
            `instagram: thread ${thread.id} skipped: ${errText(e)}`,
          );
        }
      }

      // Final batch advances the cursor — floored at epoch so delta never
      // sees a null/invalid cursor even on an empty inbox (v1 parity).
      yield {
        phase: 'live',
        items: [],
        cursor: {
          last_activity_iso: new Date(Math.max(0, newestObserved)).toISOString(),
        },
      };
    },

    toDocument(item: InstagramItem) {
      if (item.kind === 'chat_day') {
        const msgs = item.messages;
        const lastTs = msgs[msgs.length - 1]?.ts_ms ?? 0;
        return {
          externalId: buildChatDayExternalId(item.thread.id, item.day),
          type: CHAT_DAY_DOC_TYPE,
          title: dayTitle(item.thread.name, item.day),
          markdown: renderDay(msgs),
          url: `https://www.instagram.com/direct/t/${item.thread.id}/`,
          metadata: {
            thread_id: item.thread.id,
            thread_name: item.thread.name,
            participants: item.thread.participants,
            last_message_at: new Date(lastTs).toISOString(),
            // The full merged array — the ledger the NEXT merge reads.
            messages: msgs,
          },
          createdAt: new Date(msgs[0]?.ts_ms ?? lastTs).toISOString(),
        };
      }
      // media: markdown null → the engine's OCR/VLM pipeline enrolls it.
      return {
        externalId: item.externalId,
        type: FILE_DOC_TYPE,
        title: item.filename,
        markdown: null,
        binary: { bytes: item.bytes, mime: item.mime, filename: item.filename },
        parent: {
          externalId: buildChatDayExternalId(item.threadId, item.day),
          type: CHAT_DAY_DOC_TYPE,
        },
        metadata: {
          thread_id: item.threadId,
          message_id: item.messageId,
          mime_type: item.mime,
          size_bytes: item.bytes.length,
        },
        createdAt: new Date(item.sentAtMs).toISOString(),
      };
    },
  };
}
