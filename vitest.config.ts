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
    // 🔧 全局 mock Electron（曾漏挂 ⇒ `src/test/setup.ts` 是死文件，导致 AppLogger 顶层
    //    `app.isReady()` 在 node 环境下崩、凡间接 import AppLogger 的测试整文件 import 失败）
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'out'],
    server: {
      deps: {
        inline: ['better-sqlite3'],
      },
    },
  },
});
