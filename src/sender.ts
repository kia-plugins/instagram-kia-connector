/**
 * Instagram Sender — a reply DM to the one other person of a 1:1 thread.
 * Reachable only from kiagent-core's confirmation-gated send pipeline; the
 * recipient is the one frozen at sync into `metadata.outbound`
 * (source.ts recipientOf), never a model-supplied account.
 *
 * Meta allows a business account to reply only within 24 hours of the other
 * person's last message; outside it the API refuses, and the draft reports
 * "not sent". Wording contract: kiagent-core error-copy.ts.
 */
import type {
  HostFor,
  SendIntent,
  SendResult,
  Sender,
  SenderContext,
} from '@kiagent/connector-sdk';

import { InstagramClient, type NetFetch } from './client';

/** Well inside kiagent-core's 60 s sender timeout (which does not cancel). */
export const SEND_DEADLINE_MS = 40_000;

export function createInstagramSender(host: HostFor<'net'>): Sender {
  return {
    async send(intent: SendIntent, ctx?: SenderContext): Promise<SendResult> {
      // The token lives host-side in the vault; handed in at send time.
      const token = ctx?.credentials?.password;
      if (!token) throw new Error('no Instagram token — reconnect the account in Settings');
      const recipientId = (intent.outboundRef as { recipientId?: unknown } | undefined)?.recipientId;
      if (typeof recipientId !== 'string' || !/^\d+$/.test(recipientId))
        throw new Error('not sent: this draft has no Instagram recipient');
      const client = new InstagramClient({ fetch: host.net.fetch as NetFetch, token });
      const id = await client.sendText(recipientId, intent.bodyMarkdown, SEND_DEADLINE_MS);
      return id ? { externalMessageId: id } : {};
    },
  };
}
