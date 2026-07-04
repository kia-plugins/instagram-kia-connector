import type { ExtensionModule } from './kiagent-contracts';
import { createInstagramSource } from './source';

const mod = {
  async activate(host) {
    return { sources: [createInstagramSource(host)] };
  },
} satisfies ExtensionModule<'net' | 'query'>;

export default mod;
module.exports = mod;
