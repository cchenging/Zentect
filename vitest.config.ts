import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^(\.\.\/)*renderer\/src/,
        replacement: resolve('src/renderer/src'),
      },
      {
        find: /^@modules\/(.*)$/,
        replacement: resolve('src/modules/$1'),
      },
      {
        find: /^@renderer\/(.*)$/,
        replacement: resolve('src/renderer/src/$1'),
      },
    ],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'out'],
    server: {
      deps: {
        inline: ['better-sqlite3'],
      },
    },
  },
});
