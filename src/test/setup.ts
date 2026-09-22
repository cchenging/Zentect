// Global mocks for Electron-specific modules used across the project
//
// ⚠️ 本文件原来没有被挂上（`vitest.config.ts` 缺 `setupFiles`）⇒ 是「死文件」，后果：
//   node 环境下 `import { app } from 'electron'` 拿到 undefined，而 `AppLogger.ts` 顶层
//   有 `app.isReady()` ⇒ 凡间接 import 到 AppLogger 的测试**全部在 import 阶段崩**（实测 13 个套件）。
// 注意：`vitest.config.ts` 里 `globals: false`，所以这里必须**显式 import { vi }**（不能靠全局 vi）。
import { vi } from 'vitest';

// Mock electron-log used by AppLogger
vi.mock('electron-log', () => {
  // `AppLogger` 实际用到：transports.file.{level,maxSize,resolvePathFn}、transports.console.{level,writeFn}、
  // 以及 `log.scope(tag).{info,warn,error,debug}`（曾漏 `scope` ⇒ `MigrationManager` 等用例报
  // "default.scope is not a function"，属 mock 不完整而非业务缺陷）。
  // scope 返回**同一个稳定对象**，便于用例对 `log.scope('x').warn` 做断言。
  const scopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  };
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    scope: vi.fn(() => scopedLogger),
    transports: {
      file: {
        level: 'info' as const,
        maxSize: 1024 * 1024,
        format: '',
        resolvePathFn: undefined as unknown,
      },
      console: {
        level: 'debug' as const,
        format: '',
        writeFn: undefined as unknown,
      },
    },
  };
  return { default: mockLogger };
});

// Mock simple electron module usage
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/app/path'),
    getName: vi.fn(() => 'Zentect'),
    getVersion: vi.fn(() => '1.0.0'),
    // 顶层 `if (app.isReady())` / `app.whenReady()` 需要它们存在（缺失即在 import 阶段崩）
    isReady: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  BrowserWindow: vi.fn(),
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
  },
  ipcRenderer: {
    on: vi.fn(),
    send: vi.fn(),
    invoke: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  safeStorage: {
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
}));
