/**
 * @jest-environment node
 */
import { InstagramClient, isRetryableGraph } from '../client';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('listThreads maps conversations to InstagramThread', async () => {
  const fetchImpl = (async (url: string) => {
    expect(String(url)).toContain('/me/conversations');
    return jsonResponse({
      data: [{ id: 't1', updated_time: '2026-06-13T10:00:00+0000' }],
    });
  }) as unknown as typeof fetch;
  const c = new InstagramClient({ getToken: async () => 'TOK' }, fetchImpl);
  const threads = await c.listThreads();
  expect(threads[0].id).toBe('t1');
  expect(threads[0].last_activity_ms).toBe(
    Date.parse('2026-06-13T10:00:00+0000'),
  );
});

test('isRetryableGraph retries on 429, 5xx, and Graph throttle codes', () => {
  expect(isRetryableGraph(429, '')).toBe(true);
  expect(isRetryableGraph(503, '')).toBe(true);
  // throttle codes carried inside a 400 body
  expect(isRetryableGraph(400, JSON.stringify({ error: { code: 4 } }))).toBe(
    true,
  );
  expect(isRetryableGraph(400, JSON.stringify({ error: { code: 17 } }))).toBe(
    true,
  );
  expect(isRetryableGraph(200, JSON.stringify({ error: { code: 613 } }))).toBe(
    true,
  );
  // a normal auth error must NOT retry (so it surfaces as needs_reauth)
  expect(isRetryableGraph(401, JSON.stringify({ error: { code: 190 } }))).toBe(
    false,
  );
  expect(isRetryableGraph(400, 'not json')).toBe(false);
});

test('getMe returns id + username on /me', async () => {
  const fetchImpl = (async (url: string) => {
    expect(String(url)).toContain('/me');
    return jsonResponse({ id: '178', username: 'eldar' });
  }) as unknown as typeof fetch;
  const c = new InstagramClient({ getToken: async () => 'TOK' }, fetchImpl);
  expect(await c.getMe()).toEqual({ id: '178', username: 'eldar' });
});
