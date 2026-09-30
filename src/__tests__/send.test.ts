/**
 * Instagram replies: who a 1:1 thread's reply goes to (recipientOf), the
 * exact Send API request (one attempt, never retried), the failure wording
 * kiagent-core's error-copy.ts classifies, and the Sender's refusals.
 */
import type { HostFor, SendIntent } from '@kiagent/connector-sdk';
import type { PluginNetResult } from '@kiagent/connector-sdk';

import { InstagramClient, OUTSIDE_WINDOW_SUBCODE, type NetFetch } from '../client';
import { createInstagramSender } from '../sender';
import { recipientOf } from '../source';
import type { InstagramThread } from '../types';

const res = (status: number, json: unknown): PluginNetResult =>
  ({
    status,
    statusText: '',
    headers: {},
    body: new TextEncoder().encode(JSON.stringify(json)),
  }) as PluginNetResult;

function scripted(responses: Array<PluginNetResult | Error>) {
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetch: NetFetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('no response queued');
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

describe('recipientOf', () => {
  const thread = (refs: Array<{ id: string; username: string }>): InstagramThread =>
    ({ id: 't', name: 'x', participants: [], participantRefs: refs, last_activity_ms: 0 });
  const me = { id: '178', username: 'me_biz' };

  it('a 1:1 thread → the other person', () => {
    expect(recipientOf(thread([{ id: '178', username: 'me_biz' }, { id: '555', username: 'a' }]), me)).toBe('555');
  });

  it('recognises you by username when the stored id differs (Graph ids are app-scoped)', () => {
    expect(
      recipientOf(thread([{ id: '999', username: 'Me_Biz' }, { id: '555', username: 'a' }]), { id: '178', username: 'me_biz' }),
    ).toBe('555');
  });

  it('never guesses: groups, unrecognised self, or missing ids get no recipient', () => {
    expect(
      recipientOf(
        thread([
          { id: '178', username: 'me_biz' },
          { id: '555', username: 'a' },
          { id: '666', username: 'b' },
        ]),
        me,
      ),
    ).toBeUndefined();
    expect(recipientOf(thread([{ id: '1', username: 'x' }, { id: '2', username: 'y' }]), me)).toBeUndefined();
    expect(recipientOf(thread([{ id: '555', username: 'a' }]), me)).toBeUndefined();
    expect(recipientOf({ id: 't', name: 'x', participants: [], last_activity_ms: 0 }, me)).toBeUndefined();
  });
});

describe('InstagramClient.sendText', () => {
  const client = (fetch: NetFetch) => new InstagramClient({ fetch, token: 'TOK', sleep: async () => {} });

  it('POSTs one Send API request with a bearer token and returns the message id', async () => {
    const { fetch, calls } = scripted([res(200, { recipient_id: '555', message_id: 'mid.1' })]);
    await expect(client(fetch).sendText('555', 'On my way', 40_000)).resolves.toBe('mid.1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://graph.instagram.com/v21.0/me/messages');
    const init = calls[0].init as { method: string; headers: Record<string, string>; body: string; timeoutMs: number };
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer TOK');
    expect(JSON.parse(init.body)).toEqual({ recipient: { id: '555' }, message: { text: 'On my way' } });
    expect(init.timeoutMs).toBe(40_000);
    expect(calls[0].url).not.toContain('TOK'); // never in a URL that may be logged
  });

  it('an accepted send with an unreadable body still succeeds', async () => {
    const { fetch } = scripted([
      { status: 200, statusText: '', headers: {}, body: new TextEncoder().encode('<html>') } as PluginNetResult,
    ]);
    await expect(client(fetch).sendText('555', 'x', 1000)).resolves.toBeUndefined();
  });

  it('never retries: a network error or a 5xx is surfaced once, unclassified (may have been sent)', async () => {
    for (const r of [new Error('ETIMEDOUT'), res(502, { error: { message: 'bad gateway' } })]) {
      const { fetch, calls } = scripted([r, res(200, { message_id: 'dup' })]);
      const err = await client(fetch)
        .sendText('555', 'x', 1000)
        .then(() => null, (e: Error) => e);
      expect(calls).toHaveLength(1);
      expect(err?.message).not.toMatch(/^(not sent|rate-limited):/);
      expect(err?.message).not.toMatch(/reconnect .* in Settings/);
    }
  });

  it.each([
    ['token expired', res(401, { error: { code: 190, message: 'expired' } }), /reconnect the account in Settings$/],
    ['throttled', res(429, { error: { code: 4, message: 'slow down' } }), /^rate-limited: /],
    [
      'outside the 24-hour window',
      res(400, { error: { code: 10, error_subcode: OUTSIDE_WINDOW_SUBCODE, message: 'outside window' } }),
      /^not sent: .*24 hours/,
    ],
  ])('%s → the wording core classifies', async (_n, r, rx) => {
    const { fetch } = scripted([r]);
    await expect(client(fetch).sendText('555', 'x', 1000)).rejects.toThrow(rx);
  });
});

describe('instagram sender', () => {
  const intent = (ref: unknown): SendIntent => ({
    accountId: 'acc' as never,
    kind: 'reply',
    outboundRef: ref,
    bodyMarkdown: 'On my way',
  });
  const host = (fetch: NetFetch) => ({ net: { fetch } }) as unknown as HostFor<'net'>;

  it('sends to the frozen recipient with the vault token', async () => {
    const { fetch, calls } = scripted([res(200, { message_id: 'mid.9' })]);
    await expect(
      createInstagramSender(host(fetch)).send(intent({ recipientId: '555' }), { credentials: { password: 'TOK' } } as never),
    ).resolves.toEqual({ externalMessageId: 'mid.9' });
    expect(JSON.parse((calls[0].init as { body: string }).body).recipient).toEqual({ id: '555' });
  });

  it('refuses before any request without a token or a valid recipient', async () => {
    const { fetch, calls } = scripted([]);
    const s = createInstagramSender(host(fetch));
    await expect(s.send(intent({ recipientId: '555' }), {} as never)).rejects.toThrow(/reconnect the account in Settings$/);
    for (const ref of [undefined, {}, { recipientId: 'alice' }, { recipientId: 555 }])
      await expect(s.send(intent(ref), { credentials: { password: 'TOK' } } as never)).rejects.toThrow(/^not sent: /);
    expect(calls).toHaveLength(0);
  });
});
