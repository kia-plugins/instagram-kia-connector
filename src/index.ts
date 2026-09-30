import type { ExtensionModule } from '@kiagent/connector-sdk';
import { createInstagramSender } from './sender';
import { createInstagramSource } from './source';

const mod = {
  async activate(host) {
    return {
      sources: [createInstagramSource(host)],
      senders: { instagram: createInstagramSender(host) },
    };
  },
} satisfies ExtensionModule<'net' | 'query' | 'send'>;

export default mod;
module.exports = mod;
