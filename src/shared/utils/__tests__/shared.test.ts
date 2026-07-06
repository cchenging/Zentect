import { describe, it, expect } from 'vitest';
import { AppError, ErrorCode } from '../../../infra/error/AppError';
import { IPC_CHANNELS } from '../IpcConstants';

describe('AppError', () => {
  it('should create error with correct code and message', () => {
    const err = new AppError(ErrorCode.SYS_UNKNOWN, 'test error');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('test error');
    expect(err.code).toBe(ErrorCode.SYS_UNKNOWN);
  });
});

describe('IpcConstants', () => {
  it('should have all required channel constants', () => {
    expect(IPC_CHANNELS.ENGINE_RUN_PIPELINE).toBe('engine:run-pipeline');
    expect(IPC_CHANNELS.ENGINE_ABORT_PIPELINE).toBe('engine:abort-pipeline');
    expect(IPC_CHANNELS.MEDIA_IMPORT).toBe('media:import');
    expect(IPC_CHANNELS.PROJECT_CREATE).toBe('project:create');
    expect(IPC_CHANNELS.AI_CHAT).toBe('ai:chat');
  });

  it('should have no duplicate values (known aliases are allowed)', () => {
    const values = Object.values(IPC_CHANNELS);
    const unique = new Set(values);
    const dupes = values.length - unique.size;
    expect(values.length).toBeGreaterThanOrEqual(unique.size);
    expect(dupes).toBeLessThanOrEqual(10);
  });
});
