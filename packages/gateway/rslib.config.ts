import { defineConfig } from '@rslib/core';

export default defineConfig({
  lib: [
    {
      format: 'esm',
      source: {
        entry: {
          test: './test/server1.ts',
        },
      },
      output: {
        distPath: {
          root: './dist/test/',
        },
      },
    },
    {
      format: 'cjs',
      dts: true,
      source: {
        entry: {
          index: './src/index.ts',
        },
      },
      output: {
        distPath: {
          root: './dist/src',
        },
      },
    },
  ],
});
