import { defineConfig } from 'tsdown'

/**
 * Bundle the JavaScript that `tsc -p tsconfig.build.json` emitted to
 * `lib/types`. Compilation belongs to tsc alone: it inlines cordis's
 * `declare const enum FiberState`, which oxc would leave as a runtime import
 * that the host cannot resolve. This config therefore only bundles.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
