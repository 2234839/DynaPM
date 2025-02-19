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
  ],
});
