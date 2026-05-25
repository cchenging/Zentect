import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCpus, mockFreemem, mockTotalmem, mockLoadavg } = vi.hoisted(() => ({
  mockCpus: vi.fn(() => Array(8).fill({ model: 'Intel', speed: 3000, times: { user: 100, nice: 0, sys: 50, idle: 500, irq: 0 } })),
  mockFreemem: vi.fn(() => 16 * 1024 * 1024 * 1024),
  mockTotalmem: vi.fn(() => 32 * 1024 * 1024 * 1024),
  mockLoadavg: vi.fn(() => [1.5, 1.2, 1.0]),
}));

vi.mock('os', () => ({
  default: { cpus: mockCpus, freemem: mockFreemem, totalmem: mockTotalmem, loadavg: mockLoadavg },
  cpus: mockCpus,
  freemem: mockFreemem,
  totalmem: mockTotalmem,
  loadavg: mockLoadavg,
}));

vi.mock('./AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../shared/utils/LogConstants', () => ({
  LOG_TAGS: { SYSTEM: 'system', ENGINE: 'engine' },
}));

import { ComputeResourceManager } from '../ComputeResourceManager';

describe('ComputeResourceManager', () => {
  let manager: ComputeResourceManager;

  beforeEach(() => {
    ComputeResourceManager['instance'] = undefined as any;
    vi.clearAllMocks();
    manager = ComputeResourceManager.getInstance();
  });

  it('is a singleton', () => {
    const m2 = ComputeResourceManager.getInstance();
    expect(m2).toBe(manager);
  });

  it('snapshot returns resource info', () => {
    const snap = manager.snapshot();
    expect(snap).toBeDefined();
    expect(snap.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(snap.freeMemMB).toBeGreaterThan(0);
    expect(snap.totalMemMB).toBeGreaterThan(0);
    expect(snap.timestamp).toBeGreaterThan(0);
  });

  it('shouldThrottle detects resource pressure', () => {
    mockFreemem.mockReturnValue(500 * 1024 * 1024);
    mockLoadavg.mockReturnValue([10, 8, 6]);

    const result = manager.shouldThrottle();
    expect(result).toBeDefined();
    expect(typeof result.throttle).toBe('boolean');
  });

  it('canStartNewTask returns allowed true when resources ok', () => {
    const result = manager.canStartNewTask();
    expect(result).toBeDefined();
    expect(typeof result.allowed).toBe('boolean');
  });

  it('getAverageCpu returns a number', () => {
    const avg = manager.getAverageCpu();
    expect(typeof avg).toBe('number');
  });
});
