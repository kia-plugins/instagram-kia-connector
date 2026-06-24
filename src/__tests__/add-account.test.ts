/** @jest-environment node */
import { validateInstagramToken } from '../add-account';

test('rejects empty token without a network call', async () => {
  const r = await validateInstagramToken('', (async () => {
    throw new Error('should not fetch');
  }) as unknown as typeof fetch);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe('invalid-token-format');
});

test('returns token with ig_user_id + username on success', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ id: '178', username: 'eldar' }), {
      status: 200,
    })) as unknown as typeof fetch;
  const r = await validateInstagramToken('IGQ-longtoken', fetchFn);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.token.ig_user_id).toBe('178');
    expect(r.token.username).toBe('eldar');
    expect(r.token.access_token).toBe('IGQ-longtoken');
  }
});

test('maps an auth failure to auth-failed', async () => {
  const fetchFn = (async () =>
    new Response('{"error":{}}', { status: 401 })) as unknown as typeof fetch;
  const r = await validateInstagramToken('IGQ-bad', fetchFn);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe('auth-failed');
});

test('maps a thrown fetch to network-failed', async () => {
  const fetchFn = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const r = await validateInstagramToken('IGQ-longtoken', fetchFn);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toBe('network-failed');
});
