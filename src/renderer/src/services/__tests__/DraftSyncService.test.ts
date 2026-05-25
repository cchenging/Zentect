import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockUseStoreSubscribe, mockSaveCanvasDraft } = vi.hoisted(() => ({
  mockUseStoreSubscribe: vi.fn(),
  mockSaveCanvasDraft: vi.fn(),
}));

vi.mock('../../store/useStore', () => ({
  useStore: { subscribe: mockUseStoreSubscribe },
}));
vi.mock('../DraftService', () => ({
  DraftService: { saveCanvasDraft: mockSaveCanvasDraft },
}));

import { DraftSyncService } from '../DraftSyncService';

describe('DraftSyncService', () => {
  let service: DraftSyncService;

  beforeEach(() => {
    DraftSyncService['instance'] = undefined as any;
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockUseStoreSubscribe.mockImplementation((_selector: any, _onChange: any) => {
      return () => {};
    });

    service = DraftSyncService.getInstance();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it('is a singleton', () => {
    const s2 = DraftSyncService.getInstance();
    expect(s2).toBe(service);
  });

  it('subscribes to store on start', () => {
    service.start();
    expect(mockUseStoreSubscribe).toHaveBeenCalled();
  });

  it('is idempotent on multiple starts', () => {
    service.start();
    service.start();
    expect(mockUseStoreSubscribe).toHaveBeenCalledTimes(1);
  });

  it('reports isRunning=true after start', () => {
    service.start();
    expect(service.isRunning).toBe(true);
  });

  it('stop clears subscription', () => {
    service.start();
    service.stop();
    expect(service.isRunning).toBe(false);
  });
});
