// Global mocks for Electron-specific modules used across the project

// Mock electron-log used by AppLogger
vi.mock('electron-log', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    transports: {
      file: { level: 'info' as const, format: '' },
      console: { level: 'debug' as const, format: '' },
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
