/**
 * Smoke test for the bundled dist/index.js — the CJS/ESM interop in
 * src/index.ts (`export default mod; module.exports = mod;`) is exactly what
 * silently breaks on an esbuild upgrade, so it is exercised against actual
 * esbuild output (notion-kia-connector parity).
 */
import { join } from 'node:path';
import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the instagram source', async () => {
    await bundleLoadSmoke({
      root: join(__dirname, '..', '..'),
      selfId: 'instagram',
      sourceIds: ['instagram'],
    });
  }, 30_000);
});
