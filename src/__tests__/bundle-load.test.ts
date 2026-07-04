/**
 * Smoke test for the bundled dist/index.js — the CJS/ESM interop in
 * src/index.ts (`export default mod; module.exports = mod;`) is exactly what
 * silently breaks on an esbuild upgrade, so it is exercised against actual
 * esbuild output (notion-kia-connector parity).
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { HostFor } from '../kiagent-contracts';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the instagram source', async () => {
    const root = join(__dirname, '..', '..');
    execSync('npm run build', { cwd: root });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(join(root, 'dist', 'index.js'));
    const entry = mod.default ?? mod;
    expect(typeof entry.activate).toBe('function');

    const host: HostFor<'net' | 'query'> = {
      self: { id: 'instagram', dataDir: '/tmp' },
      log: () => {},
      net: {
        fetch: async () => {
          throw new Error('unused in this smoke test');
        },
      },
      query: {
        document: async () => null,
        children: async () => [],
        byExternalId: async () => null,
        search: async () => [],
        count: async () => 0,
        accounts: async () => [],
      },
    };
    const result = await entry.activate(host);

    expect(result.sources).toHaveLength(1);
    expect(result.sources?.[0]?.descriptor.id).toBe('instagram');
  }, 30_000);
});
