/**
 * InstagramClient over a scripted host `net.fetch` — retry predicate and
 * loop (v1 bearer-fetch parity), the v2 auth-error fix (401 / body-190 →
 * InstagramAuthError, never retried), Retry-After handling, token-as-query-
 * param transport, and the response mappings ported from the v1 suite.
 * All offline; the injected `sleep` records backoff delays instead of waiting.
 */
import {
  GRAPH_BASE,
  InstagramAuthError,
  InstagramClient,
  isAuthErrorGraph,
  isRetryableGraph,
  type NetFetch,
} from '../client';

const TEST_TOKEN = 'IGQVJtest-token-not-real';

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

interface RecordedCall {
  url: string;
  init: unknown;
}

function scriptedFetch(responses: unknown[]): {
  fetchFn: NetFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchFn: NetFetch = async (url, init) => {
    calls.push({ url, init });
    const res = responses[i];
    i += 1;
    if (res === undefined) {
      throw new Error(`scriptedFetch: no response queued for call #${i} (${url})`);
    }
    if (res instanceof Error) throw res;
    return res;
  };
  return { fetchFn, calls };
}

function makeClient(responses: unknown[]) {
  const { fetchFn, calls } = scriptedFetch(responses);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const client = new InstagramClient({
    fetch: fetchFn,
    token: TEST_TOKEN,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (msg) => {
      logs.push(msg);
    },
  });
  return { client, calls, sleeps, logs };
}

describe('isRetryableGraph (v1 predicate, verbatim)', () => {
  it('retries on 429, 5xx, and Graph throttle codes in the body', () => {
    expect(isRetryableGraph(429, '')).toBe(true);
    expect(isRetryableGraph(503, '')).toBe(true);
    // throttle codes carried inside a 400 body
    expect(isRetryableGraph(400, JSON.stringify({ error: { code: 4 } }))).toBe(true);
    expect(isRetryableGraph(400, JSON.stringify({ error: { code: 17 } }))).toBe(true);
    expect(isRetryableGraph(400, JSON.stringify({ error: { code: 32 } }))).toBe(true);
    expect(isRetryableGraph(200, JSON.stringify({ error: { code: 613 } }))).toBe(true);
  });

  it('does not retry plain 400s, auth errors, or non-JSON bodies', () => {
    expect(isRetryableGraph(400, JSON.stringify({ error: { code: 100 } }))).toBe(false);
    expect(isRetryableGraph(401, JSON.stringify({ error: { code: 190 } }))).toBe(false);
    expect(isRetryableGraph(400, 'not json')).toBe(false);
  });
});

describe('isAuthErrorGraph', () => {
  it('flags HTTP 401 and body error.code 190 (any status), nothing else', () => {
    expect(isAuthErrorGraph(401, '')).toBe(true);
    expect(isAuthErrorGraph(400, JSON.stringify({ error: { code: 190 } }))).toBe(true);
    expect(isAuthErrorGraph(400, JSON.stringify({ error: { code: 100 } }))).toBe(false);
    expect(isAuthErrorGraph(429, '')).toBe(false);
    expect(isAuthErrorGraph(400, 'not json')).toBe(false);
  });
});

describe('transport', () => {
  it('sends the token as an access_token QUERY PARAM (v1-authoritative), never a header', async () => {
    const { client, calls } = makeClient([jsonResponse(200, { id: '178' })]);
    await client.getMe();
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH_BASE}/me`);
    expect(url.searchParams.get('access_token')).toBe(TEST_TOKEN);
    expect(url.searchParams.get('fields')).toBe('id,username');
    expect(calls[0].init).toBeUndefined(); // no headers at all
  });
});

describe('response mappings (v1 parity)', () => {
  it('getMe returns id + username from /me', async () => {
    const { client } = makeClient([
      jsonResponse(200, { id: '178', username: 'test_user' }),
    ]);
    expect(await client.getMe()).toEqual({ id: '178', username: 'test_user' });
  });

  it('listThreads maps conversations to InstagramThread with participant-name fallback', async () => {
    const { client, calls } = makeClient([
      jsonResponse(200, {
        data: [
          { id: 't1', updated_time: '2026-06-13T10:00:00+0000' },
          {
            id: 't2',
            updated_time: '2026-06-13T11:00:00+0000',
            participants: { data: [{ username: 'alice' }, { username: 'bob' }] },
          },
        ],
      }),
    ]);
    const threads = await client.listThreads();
    expect(calls[0].url).toContain('/me/conversations');
    expect(calls[0].url).toContain('platform=instagram');
    expect(threads).toEqual([
      {
        id: 't1',
        name: 't1', // no name, no participants → id fallback
        participants: [],
        last_activity_ms: Date.parse('2026-06-13T10:00:00+0000'),
      },
      {
        id: 't2',
        name: 'alice, bob',
        participants: ['alice', 'bob'],
        last_activity_ms: Date.parse('2026-06-13T11:00:00+0000'),
      },
    ]);
  });

  it('listMessages maps messages and derives attachment kinds from *_data blocks', async () => {
    const { client, calls } = makeClient([
      jsonResponse(200, {
        data: [
          {
            id: 'm1',
            created_time: '2026-06-13T10:00:00+0000',
            from: { id: 'u1', username: 'alice' },
            message: 'hi',
            attachments: {
              data: [
                { image_data: { url: 'https://cdn.example/p.jpg' } },
                { video_data: { url: 'https://cdn.example/v.mp4' } },
              ],
            },
          },
        ],
      }),
    ]);
    const msgs = await client.listMessages('t1');
    expect(calls[0].url).toContain('/t1/messages');
    expect(msgs).toEqual([
      {
        id: 'm1',
        from_id: 'u1',
        from_name: 'alice',
        text: 'hi',
        ts_ms: Date.parse('2026-06-13T10:00:00+0000'),
        attachments: [
          { type: 'photo', url: 'https://cdn.example/p.jpg', id: undefined },
          { type: 'video', url: 'https://cdn.example/v.mp4', id: undefined },
        ],
      },
    ]);
  });
});

describe('retry loop (v1 bearer-fetch parity)', () => {
  it('retries a 429 honoring Retry-After (seconds), then succeeds', async () => {
    const { client, calls, sleeps } = makeClient([
      jsonResponse(429, {}, { 'retry-after': '7' }),
      jsonResponse(200, { id: '178' }),
    ]);
    expect(await client.getMe()).toEqual({ id: '178' });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([7000]);
  });

  it('retries 5xx with capped exponential backoff and exhausts after 5 requests total', async () => {
    const { client, calls, sleeps } = makeClient(
      Array.from({ length: 5 }, () => jsonResponse(500, { error: { message: 'boom' } })),
    );
    await expect(client.getMe()).rejects.toThrow(/^instagram-graph 500 /);
    // v1 loop parity: retries while attempt < 4 → 5 requests, 4 backoffs.
    expect(calls).toHaveLength(5);
    expect(sleeps).toHaveLength(4);
    sleeps.forEach((ms, n) => {
      const base = Math.min(60_000, 1000 * 2 ** n);
      expect(ms).toBeGreaterThanOrEqual(base);
      expect(ms).toBeLessThan(base + 251); // + jitter
    });
  });

  it('retries a body throttle code (error.code 4 inside a 400)', async () => {
    const { client, calls } = makeClient([
      jsonResponse(400, { error: { code: 4, message: 'rate limited' } }),
      jsonResponse(200, { id: '178' }),
    ]);
    expect(await client.getMe()).toEqual({ id: '178' });
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a plain 400 — throws the v1 error contract immediately', async () => {
    const { client, calls, sleeps } = makeClient([
      jsonResponse(400, { error: { code: 100, message: 'bad field' } }),
    ]);
    await expect(client.getMe()).rejects.toThrow(/^instagram-graph 400 /);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('retries network errors, then succeeds', async () => {
    const { client, calls, sleeps } = makeClient([
      new Error('socket hang up'),
      jsonResponse(200, { id: '178' }),
    ]);
    expect(await client.getMe()).toEqual({ id: '178' });
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it('propagates the network error once retries are exhausted', async () => {
    const { client, calls } = makeClient(
      Array.from({ length: 5 }, () => new Error('socket hang up')),
    );
    await expect(client.getMe()).rejects.toThrow('socket hang up');
    expect(calls).toHaveLength(5);
  });

  it('never leaks the token into thrown messages or retry logs', async () => {
    const { client, logs } = makeClient([
      jsonResponse(500, {}),
      jsonResponse(400, { error: { code: 100, message: 'bad' } }),
    ]);
    let error: Error | undefined;
    try {
      await client.getMe();
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).not.toContain(TEST_TOKEN);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(TEST_TOKEN);
  });
});

describe('auth errors (v2 fix — v1 had no auth handling)', () => {
  it('HTTP 401 → InstagramAuthError, never retried, message ends "— reconnect the account"', async () => {
    const { client, calls, sleeps } = makeClient([
      jsonResponse(401, {
        error: { code: 190, message: 'Error validating access token' },
      }),
    ]);
    let error: unknown;
    try {
      await client.getMe();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InstagramAuthError);
    expect((error as InstagramAuthError).httpStatus).toBe(401);
    expect((error as InstagramAuthError).graphCode).toBe(190);
    expect((error as Error).message).toMatch(/— reconnect the account$/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('body error.code 190 inside a 400 → InstagramAuthError, not retried', async () => {
    const { client, calls } = makeClient([
      jsonResponse(400, { error: { code: 190, message: 'Session has expired' } }),
    ]);
    let error: unknown;
    try {
      await client.getMe();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InstagramAuthError);
    expect((error as Error).message).toMatch(/— reconnect the account$/);
    expect(calls).toHaveLength(1);
  });
});
