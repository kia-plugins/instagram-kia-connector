/**
 * Instagram v2 source suite: connect (password-vault prompt + /me
 * validation), the delta-only pull (per-thread batches, cursor unchanged
 * mid-sweep and advanced only in the final batch, query-backed chat-day
 * merge, eager media in the parent's batch, per-thread skip guard,
 * auth-error propagation), and the pure toDocument for both types.
 *
 * `host.net.fetch` is fully scripted per URL — no real network, no timers
 * (the client's backoff sleep is instant via the test clock seam).
 */
import { createInstagramSource } from '../source';
import { InstagramAuthError, type NetFetch } from '../client';
import { dayKey } from '../chat-day';
import {
  CHAT_DAY_DOC_TYPE,
  FILE_DOC_TYPE,
  type ChatDayItem,
  type InstagramCursor,
  type InstagramItem,
  type MediaItem,
} from '../types';
import type {
  Account,
  AuthChannel,
  Batch,
  Credentials,
  Document,
  DocumentInput,
  HostFor,
  Query,
  Session,
} from '../kiagent-contracts';

const EPOCH_ISO = new Date(0).toISOString();
const ACCOUNT_ID = 'acc-1';

function jsonResponse(
  status: number,
  json: unknown,
  headers: Record<string, string> = {},
) {
  return {
    status,
    statusText: '',
    headers,
    body: new TextEncoder().encode(JSON.stringify(json)),
  };
}

function bytesResponse(
  status: number,
  body: Uint8Array,
  headers: Record<string, string> = {},
) {
  return { status, statusText: '', headers, body };
}

interface Route {
  match: string;
  /** One response reused forever, or a queue consumed per call. */
  res: unknown | unknown[];
}

/** First route whose `match` substring hits the url wins; Error values throw. */
function routedFetch(routes: Route[]): { fetchFn: NetFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: NetFetch = async (url) => {
    calls.push(url);
    for (const r of routes) {
      if (!url.includes(r.match)) continue;
      const res = Array.isArray(r.res) ? r.res.shift() : r.res;
      if (res === undefined) throw new Error(`routedFetch: route ${r.match} exhausted (${url})`);
      if (res instanceof Error) throw res;
      return res;
    }
    throw new Error(`routedFetch: no route for ${url}`);
  };
  return { fetchFn, calls };
}

interface QueryCall {
  account: string;
  externalId: string;
  type: string;
}

function makeHost(
  fetchFn: NetFetch,
  priorDocs: Map<string, Document> = new Map(),
): { host: HostFor<'net' | 'query'>; queryCalls: QueryCall[] } {
  const queryCalls: QueryCall[] = [];
  const query: Query = {
    document: async () => null,
    children: async () => [],
    byExternalId: async (account, externalId, type) => {
      queryCalls.push({ account: String(account), externalId, type });
      return priorDocs.get(`${externalId}|${type}`) ?? null;
    },
    search: async () => [],
    count: async () => 0,
    accounts: async () => [],
  };
  return {
    host: {
      self: { id: 'instagram', dataDir: '/tmp' },
      log: () => {},
      net: { fetch: fetchFn },
      query,
    },
    queryCalls,
  };
}

function priorDoc(messages: unknown[]): Document {
  return { metadata: { messages } } as unknown as Document;
}

function makeSession(credentials: Credentials | null): {
  session: Session;
  warnings: string[];
} {
  const warnings: string[] = [];
  return {
    session: {
      account: { id: ACCOUNT_ID } as Account,
      signal: new AbortController().signal,
      credentials: async () => credentials,
      log: (level, msg) => {
        if (level === 'warn') warnings.push(msg);
      },
    },
    warnings,
  };
}

function makeAuth(answers: Record<string, unknown>): {
  auth: AuthChannel;
  getSchema: () => unknown;
} {
  let schema: unknown;
  const auth: AuthChannel = {
    oauth: async () => ({}),
    showQr: () => {},
    prompt: async (s) => {
      schema = s;
      return answers;
    },
    status: () => {},
  };
  return { auth, getSchema: () => schema };
}

// Instant clock via createInstagramSource's test seam: retry backoff
// resolves immediately instead of really sleeping.
const instantClock = { sleep: async () => {} };

const T_OLD = '2026-06-13T09:00:00.000Z';
const T1 = '2026-06-13T10:00:00.000Z';
const T2 = '2026-06-13T11:00:00.000Z';
const T3 = '2026-06-13T12:00:00.000Z';

function threadJson(id: string, updatedIso: string, participants: string[] = []) {
  return {
    id,
    updated_time: updatedIso,
    ...(participants.length
      ? { participants: { data: participants.map((username) => ({ username })) } }
      : {}),
  };
}

function msgJson(
  id: string,
  iso: string,
  username: string,
  message: string,
  attachments?: { image_data?: { url: string }; video_data?: { url: string } }[],
) {
  return {
    id,
    created_time: iso,
    from: { id: `uid-${username}`, username },
    message,
    ...(attachments ? { attachments: { data: attachments } } : {}),
  };
}

async function drain(
  source: ReturnType<typeof createInstagramSource>,
  session: Session,
  cursor: InstagramCursor | null,
): Promise<Array<Batch<InstagramCursor, InstagramItem>>> {
  const batches: Array<Batch<InstagramCursor, InstagramItem>> = [];
  for await (const b of source.pull(session, cursor)) batches.push(b);
  return batches;
}

describe('connect', () => {
  it('prompts with a single `password` field (title "Instagram access token", format password) and rejects an empty-ish token before any fetch', async () => {
    const { fetchFn, calls } = routedFetch([]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { auth, getSchema } = makeAuth({ password: '  ab  ' });

    await expect(source.connect(auth)).rejects.toThrow(/valid long-lived Instagram access token/);

    const schema = getSchema() as {
      required: string[];
      'x-steps': Array<{ title: string; link?: string }>;
      properties: Record<
        string,
        { title?: string; format?: string; examples?: string[] }
      >;
    };
    expect(schema.required).toEqual(['password']);
    expect(Object.keys(schema.properties)).toEqual(['password']);
    expect(schema.properties.password.title).toBe('Instagram access token');
    expect(schema.properties.password.format).toBe('password');
    expect(schema['x-steps']).toHaveLength(2);
    expect(schema['x-steps'][0].link).toBe('https://developers.facebook.com/apps');
    expect(schema.properties.password.examples?.[0]).toBe('Long-lived token…');
    expect(calls).toHaveLength(0);
  });

  it('validates via GET /me and returns { identifier: username, config: { ig_user_id } }', async () => {
    const { fetchFn, calls } = routedFetch([
      { match: '/me?', res: jsonResponse(200, { id: '178', username: 'test_user' }) },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { auth } = makeAuth({ password: '  IGQVJtest-token  ' });

    const result = await source.connect(auth);

    expect(result).toEqual({ identifier: 'test_user', config: { ig_user_id: '178' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('graph.instagram.com/v21.0/me?');
    expect(calls[0]).toContain('access_token=IGQVJtest-token');
  });

  it('falls back to ig_user_id as the identifier when Instagram returns no username', async () => {
    const { fetchFn } = routedFetch([
      { match: '/me?', res: jsonResponse(200, { id: '178' }) },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { auth } = makeAuth({ password: 'IGQVJtest-token' });

    expect(await source.connect(auth)).toEqual({
      identifier: '178',
      config: { ig_user_id: '178' },
    });
  });

  it('propagates an auth failure (401 → InstagramAuthError) from /me', async () => {
    const { fetchFn, calls } = routedFetch([
      {
        match: '/me?',
        res: jsonResponse(401, { error: { code: 190, message: 'bad token' } }),
      },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { auth } = makeAuth({ password: 'IGQVJtest-token' });

    await expect(source.connect(auth)).rejects.toBeInstanceOf(InstagramAuthError);
    expect(calls).toHaveLength(1); // auth errors are never retried
  });

  it('propagates a network failure once the client retries are exhausted', async () => {
    const { fetchFn, calls } = routedFetch([
      { match: '/me?', res: Array.from({ length: 5 }, () => new Error('offline')) },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { auth } = makeAuth({ password: 'IGQVJtest-token' });

    await expect(source.connect(auth)).rejects.toThrow('offline');
    expect(calls).toHaveLength(5);
  });
});

describe('pull — sweep and cursor', () => {
  it('fresh account (null cursor = epoch): one live batch per active thread with the cursor UNCHANGED, then a final live batch advancing it to the newest observed activity', async () => {
    const { fetchFn } = routedFetch([
      {
        match: '/me/conversations',
        res: jsonResponse(200, {
          data: [threadJson('t1', T2, ['alice']), threadJson('t2', T1, ['bob'])],
        }),
      },
      { match: '/t1/messages', res: jsonResponse(200, { data: [msgJson('m1', T2, 'alice', 'hi')] }) },
      { match: '/t2/messages', res: jsonResponse(200, { data: [msgJson('m2', T1, 'bob', 'yo')] }) },
    ]);
    const { host, queryCalls } = makeHost(fetchFn);
    const source = createInstagramSource(host, instantClock);
    const { session } = makeSession({ password: 'IGQVJtest-token' });

    const batches = await drain(source, session, null);

    expect(batches).toHaveLength(3);
    expect(batches.every((b) => b.phase === 'live')).toBe(true); // no true backfill

    // per-thread batches ride the OLD cursor — a crash mid-sweep re-sweeps idempotently
    expect(batches[0].cursor).toEqual({ last_activity_iso: EPOCH_ISO });
    expect(batches[1].cursor).toEqual({ last_activity_iso: EPOCH_ISO });
    const day1 = batches[0].items[0] as ChatDayItem;
    expect(day1.kind).toBe('chat_day');
    expect(day1.thread).toEqual({ id: 't1', name: 'alice', participants: ['alice'] });
    expect(day1.messages.map((m) => m.id)).toEqual(['m1']);
    expect((batches[1].items[0] as ChatDayItem).thread.id).toBe('t2');

    // final batch: empty items, cursor advanced to the sweep's newest activity
    expect(batches[2]).toEqual({
      phase: 'live',
      items: [],
      cursor: { last_activity_iso: T2 },
    });

    // the merge read used the session's account id and the chat-day type
    expect(queryCalls[0]).toEqual({
      account: ACCOUNT_ID,
      externalId: `thread:t1:${dayKey(Date.parse(T2))}`,
      type: CHAT_DAY_DOC_TYPE,
    });
  });

  it('tolerates a thread with an unparseable updated_time: it sorts as never-active (no message fetch, no NaN) and the final cursor still advances from healthy threads', async () => {
    const { fetchFn, calls } = routedFetch([
      {
        match: '/me/conversations',
        res: jsonResponse(200, {
          data: [
            { id: 'tbad', updated_time: 'not-a-date' }, // Date.parse → NaN territory
            threadJson('t1', T2),
          ],
        }),
      },
      { match: '/t1/messages', res: jsonResponse(200, { data: [msgJson('m1', T2, 'alice', 'hi')] }) },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { session } = makeSession({ password: 'IGQVJtest-token' });

    const batches = await drain(source, session, null);

    // the garbage thread gated out as never-active — no /tbad/messages call
    expect(calls.some((u) => u.includes('/tbad/messages'))).toBe(false);
    expect(batches).toHaveLength(2); // t1's batch + the final cursor batch
    expect((batches[0].items[0] as ChatDayItem).thread.id).toBe('t1');
    // no NaN poisoning: the final cursor is a valid ISO from the healthy thread
    expect(batches[1]).toEqual({
      phase: 'live',
      items: [],
      cursor: { last_activity_iso: T2 },
    });
  });

  it('skips a message with an unparseable created_time with a warn; the rest of the thread still emits', async () => {
    const { fetchFn } = routedFetch([
      { match: '/me/conversations', res: jsonResponse(200, { data: [threadJson('t1', T2)] }) },
      {
        match: '/t1/messages',
        res: jsonResponse(200, {
          data: [
            msgJson('mBad', 'garbage-time', 'alice', 'lost to NaN'),
            msgJson('m1', T2, 'alice', 'kept'),
          ],
        }),
      },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { session, warnings } = makeSession({ password: 'IGQVJtest-token' });

    const batches = await drain(source, session, null);

    const dayItem = batches[0].items[0] as ChatDayItem;
    expect(dayItem.messages.map((m) => m.id)).toEqual(['m1']); // bad message dropped
    expect(dayItem.day).not.toContain('NaN');
    expect(warnings.some((w) => w.includes('mBad') && w.includes('created_time'))).toBe(true);
    // sweep completed normally: final cursor advanced, toDocument renders
    expect(batches[1].cursor).toEqual({ last_activity_iso: T2 });
    const doc = source.toDocument(dayItem) as DocumentInput;
    expect(doc.externalId).toBe(`thread:t1:${dayKey(Date.parse(T2))}`);
    expect(doc.markdown).toContain('kept');
    expect(doc.markdown).not.toContain('lost to NaN');
  });

  it('second run: threads at or below the committed cursor are gated out without fetching their messages', async () => {
    const { fetchFn, calls } = routedFetch([
      {
        match: '/me/conversations',
        res: jsonResponse(200, { data: [threadJson('t1', T3), threadJson('t2', T1)] }),
      },
      { match: '/t1/messages', res: jsonResponse(200, { data: [msgJson('m3', T3, 'alice', 'new')] }) },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { session } = makeSession({ password: 'IGQVJtest-token' });

    const batches = await drain(source, session, { last_activity_iso: T2 });

    expect(calls.filter((u) => u.includes('/messages'))).toHaveLength(1);
    expect(calls.some((u) => u.includes('/t2/messages'))).toBe(false);
    expect(batches).toHaveLength(2);
    expect(batches[0].cursor).toEqual({ last_activity_iso: T2 }); // unchanged mid-sweep
    expect(batches[1].cursor).toEqual({ last_activity_iso: T3 }); // advanced at the end
  });

  it('empty inbox still yields the final batch with the cursor floored at epoch (delta never sees null)', async () => {
    const { fetchFn } = routedFetch([
      { match: '/me/conversations', res: jsonResponse(200, { data: [] }) },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { session } = makeSession({ password: 'IGQVJtest-token' });

    const batches = await drain(source, session, null);

    expect(batches).toEqual([
      { phase: 'live', items: [], cursor: { last_activity_iso: EPOCH_ISO } },
    ]);
  });

  it('merges with the existing chat-day doc: a ledger message the ~20-message window scrolled past is kept', async () => {
    const day = dayKey(Date.parse(T2));
    const scrolledOut = {
      id: 'm0',
      from_id: 'uid-alice',
      from_name: 'alice',
      text: 'older, no longer in the API window',
      ts_ms: Date.parse(T_OLD),
      attachments: [],
    };
    const priorDocs = new Map<string, Document>([
      [`thread:t1:${day}|${CHAT_DAY_DOC_TYPE}`, priorDoc([scrolledOut])],
    ]);
    const { fetchFn } = routedFetch([
      { match: '/me/conversations', res: jsonResponse(200, { data: [threadJson('t1', T2)] }) },
      { match: '/t1/messages', res: jsonResponse(200, { data: [msgJson('m1', T2, 'alice', 'current')] }) },
    ]);
    const { host } = makeHost(fetchFn, priorDocs);
    const source = createInstagramSource(host, instantClock);
    const { session } = makeSession({ password: 'IGQVJtest-token' });

    const batches = await drain(source, session, null);

    const item = batches[0].items[0] as ChatDayItem;
    expect(item.messages.map((m) => m.id)).toEqual(['m0', 'm1']); // union, ts-sorted

    // the rendered doc carries BOTH the old and the new message — and the
    // metadata ledger the NEXT merge will read
    const doc = source.toDocument(item) as DocumentInput;
    expect(doc.markdown).toContain('older, no longer in the API window');
    expect(doc.markdown).toContain('current');
    expect((doc.metadata.messages as unknown[]).length).toBe(2);
  });

  it('skips one broken thread with a warning and keeps sweeping — durably: the final cursor still covers it', async () => {
    const { fetchFn } = routedFetch([
      {
        match: '/me/conversations',
        res: jsonResponse(200, { data: [threadJson('t1', T3), threadJson('t2', T1)] }),
      },
      // non-auth, non-retryable failure
      { match: '/t1/messages', res: jsonResponse(400, { error: { code: 100, message: 'nope' } }) },
      { match: '/t2/messages', res: jsonResponse(200, { data: [msgJson('m2', T1, 'bob', 'yo')] }) },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { session, warnings } = makeSession({ password: 'IGQVJtest-token' });

    const batches = await drain(source, session, null);

    expect(warnings.some((w) => w.includes('thread t1 skipped'))).toBe(true);
    expect(batches).toHaveLength(2); // t2's batch + the final cursor batch
    expect((batches[0].items[0] as ChatDayItem).thread.id).toBe('t2');
    // per-container rule: the failed thread's activity still advances the
    // final cursor (durable skip; its messages return on its next activity)
    expect(batches[1].cursor).toEqual({ last_activity_iso: T3 });
  });

  it('propagates a 401 from listThreads as InstagramAuthError (engine flips to needsReauth)', async () => {
    const { fetchFn } = routedFetch([
      {
        match: '/me/conversations',
        res: jsonResponse(401, { error: { code: 190, message: 'expired' } }),
      },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { session } = makeSession({ password: 'IGQVJtest-token' });

    await expect(drain(source, session, null)).rejects.toBeInstanceOf(InstagramAuthError);
  });

  it('propagates a body error.code 190 from listMessages instead of skipping the thread', async () => {
    const { fetchFn } = routedFetch([
      { match: '/me/conversations', res: jsonResponse(200, { data: [threadJson('t1', T2)] }) },
      { match: '/t1/messages', res: jsonResponse(400, { error: { code: 190, message: 'expired' } }) },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { session, warnings } = makeSession({ password: 'IGQVJtest-token' });

    await expect(drain(source, session, null)).rejects.toThrow(/— reconnect the account$/);
    expect(warnings).toEqual([]); // not demoted to a per-thread skip
  });

  it('throws before any fetch when the vault has no credentials', async () => {
    const { fetchFn, calls } = routedFetch([]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { session } = makeSession(null);

    await expect(drain(source, session, null)).rejects.toThrow(/reconnect the account/);
    expect(calls).toHaveLength(0);
  });
});

describe('pull — media', () => {
  const JPEG = new Uint8Array(2048).fill(0x7f);

  it('eagerly downloads a photo and emits the media item in the SAME batch as its parent chat-day', async () => {
    const { fetchFn } = routedFetch([
      { match: '/me/conversations', res: jsonResponse(200, { data: [threadJson('t1', T2)] }) },
      {
        match: '/t1/messages',
        res: jsonResponse(200, {
          data: [msgJson('m1', T2, 'alice', '', [{ image_data: { url: 'https://cdn.example/pic.jpg?sig=1' } }])],
        }),
      },
      {
        match: 'cdn.example/pic.jpg',
        res: bytesResponse(200, JPEG, { 'content-type': 'image/jpeg' }),
      },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { session } = makeSession({ password: 'IGQVJtest-token' });

    const batches = await drain(source, session, null);

    const day = dayKey(Date.parse(T2));
    expect(batches[0].items).toHaveLength(2);
    const [dayItem, mediaItem] = batches[0].items as [ChatDayItem, MediaItem];
    expect(dayItem.kind).toBe('chat_day');
    expect(mediaItem).toEqual({
      kind: 'media',
      externalId: 'live-media:t1:m1:0',
      threadId: 't1',
      messageId: 'm1',
      day,
      filename: 'pic.jpg',
      mime: 'image/jpeg',
      bytes: JPEG,
      sentAtMs: Date.parse(T2),
    });

    // the media doc parents onto the day doc emitted in the same batch
    const doc = source.toDocument(mediaItem) as DocumentInput;
    expect(doc.parent).toEqual({ externalId: `thread:t1:${day}`, type: CHAT_DAY_DOC_TYPE });
  });

  it('skips the CDN fetch entirely when the file doc already exists (idempotent re-polls)', async () => {
    const priorDocs = new Map<string, Document>([
      [`live-media:t1:m1:0|${FILE_DOC_TYPE}`, { metadata: {} } as unknown as Document],
    ]);
    const { fetchFn, calls } = routedFetch([
      { match: '/me/conversations', res: jsonResponse(200, { data: [threadJson('t1', T2)] }) },
      {
        match: '/t1/messages',
        res: jsonResponse(200, {
          data: [msgJson('m1', T2, 'alice', '', [{ image_data: { url: 'https://cdn.example/pic.jpg' } }])],
        }),
      },
    ]);
    const { host, queryCalls } = makeHost(fetchFn, priorDocs);
    const source = createInstagramSource(host, instantClock);
    const { session } = makeSession({ password: 'IGQVJtest-token' });

    const batches = await drain(source, session, null);

    expect(calls.some((u) => u.includes('cdn.example'))).toBe(false);
    expect(batches[0].items.filter((i) => i.kind === 'media')).toHaveLength(0);
    expect(queryCalls).toContainEqual({
      account: ACCOUNT_ID,
      externalId: 'live-media:t1:m1:0',
      type: FILE_DOC_TYPE,
    });
  });

  it('tolerates an expired CDN URL: warn + keep the day item, never fatal', async () => {
    const { fetchFn } = routedFetch([
      { match: '/me/conversations', res: jsonResponse(200, { data: [threadJson('t1', T2)] }) },
      {
        match: '/t1/messages',
        res: jsonResponse(200, {
          data: [msgJson('m1', T2, 'alice', '', [{ image_data: { url: 'https://cdn.example/expired.jpg' } }])],
        }),
      },
      { match: 'cdn.example/expired.jpg', res: new Error('410 Gone') },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { session, warnings } = makeSession({ password: 'IGQVJtest-token' });

    const batches = await drain(source, session, null);

    expect(batches[0].items.map((i) => i.kind)).toEqual(['chat_day']);
    expect(warnings.some((w) => w.includes('live-media:t1:m1:0'))).toBe(true);
    expect(batches[1].cursor).toEqual({ last_activity_iso: T2 }); // sweep completed
  });

  it('never downloads videos — they stay text placeholders in the day markdown', async () => {
    const { fetchFn, calls } = routedFetch([
      { match: '/me/conversations', res: jsonResponse(200, { data: [threadJson('t1', T2)] }) },
      {
        match: '/t1/messages',
        res: jsonResponse(200, {
          data: [msgJson('m1', T2, 'alice', '', [{ video_data: { url: 'https://cdn.example/clip.mp4' } }])],
        }),
      },
    ]);
    const source = createInstagramSource(makeHost(fetchFn).host, instantClock);
    const { session } = makeSession({ password: 'IGQVJtest-token' });

    const batches = await drain(source, session, null);

    expect(calls.some((u) => u.includes('cdn.example'))).toBe(false);
    const dayItem = batches[0].items[0] as ChatDayItem;
    const doc = source.toDocument(dayItem) as DocumentInput;
    expect(doc.markdown).toContain('[video]');
  });
});

describe('toDocument', () => {
  const deadHost = () =>
    makeHost(async () => {
      throw new Error('toDocument must never touch the network');
    }).host;

  it('renders a chat-day document — pure, exact shape', () => {
    const source = createInstagramSource(deadHost());
    const ts1 = Date.parse(T1);
    const ts2 = Date.parse(T2);
    const day = dayKey(ts1);
    const item: ChatDayItem = {
      kind: 'chat_day',
      thread: { id: 't1', name: 'alice', participants: ['alice', 'me'] },
      day,
      messages: [
        { id: 'm1', from_id: 'u1', from_name: 'alice', text: 'hi', ts_ms: ts1, attachments: [] },
        { id: 'm2', from_id: 'u2', from_name: 'me', text: 'yo', ts_ms: ts2, attachments: [] },
      ],
    };

    const doc = source.toDocument(item) as DocumentInput;

    expect(doc).toEqual({
      externalId: `thread:t1:${day}`,
      type: CHAT_DAY_DOC_TYPE,
      title: expect.stringMatching(/^alice — \w{3} \d{1,2}, \d{4}$/),
      markdown: expect.stringContaining('**alice**'),
      url: 'https://www.instagram.com/direct/t/t1/',
      metadata: {
        thread_id: 't1',
        thread_name: 'alice',
        participants: ['alice', 'me'],
        last_message_at: T2,
        messages: item.messages,
      },
      createdAt: T1,
    });
    expect((doc.markdown as string).split('\n\n')).toHaveLength(2);
  });

  it('renders a media file document — binary bytes, null markdown, chat-day parent', () => {
    const source = createInstagramSource(deadHost());
    const bytes = new Uint8Array([1, 2, 3]);
    const item: MediaItem = {
      kind: 'media',
      externalId: 'live-media:t1:m1:0',
      threadId: 't1',
      messageId: 'm1',
      day: '2026-06-13',
      filename: 'pic.jpg',
      mime: 'image/jpeg',
      bytes,
      sentAtMs: Date.parse(T2),
    };

    const doc = source.toDocument(item) as DocumentInput;

    expect(doc).toEqual({
      externalId: 'live-media:t1:m1:0',
      type: FILE_DOC_TYPE,
      title: 'pic.jpg',
      markdown: null, // null → the engine's OCR/VLM pipeline enrolls it
      binary: { bytes, mime: 'image/jpeg', filename: 'pic.jpg' },
      parent: { externalId: 'thread:t1:2026-06-13', type: CHAT_DAY_DOC_TYPE },
      metadata: {
        thread_id: 't1',
        message_id: 'm1',
        mime_type: 'image/jpeg',
        size_bytes: 3,
      },
      createdAt: T2,
    });
  });

  it('exposes the v2 descriptor exactly as specced', () => {
    const source = createInstagramSource(deadHost());
    expect(source.descriptor).toEqual({
      id: 'instagram',
      name: 'Instagram',
      documentTypes: ['instagram.chat_day', 'file'],
      auth: 'password',
      multiAccount: true,
      cadence: { every: '15m' },
    });
    expect(source.fetchBytes).toBeUndefined(); // CDN URLs expire — bytes ride ingest
    expect(source.reconcile).toBeUndefined(); // no deletion/full listing in the API
  });
});
