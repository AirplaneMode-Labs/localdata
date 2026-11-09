import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  target: 'es2022',
  platform: 'browser',
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
