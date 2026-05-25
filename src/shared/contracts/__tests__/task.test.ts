import { describe, it, expect } from 'vitest';
import {
  TASK_EVENT_TYPE,
  TASK_EVENT_PAYLOAD_SCHEMA,
  TASK_STATUS,
  TASK_STATUS_SCHEMA,
} from '../task';

describe('TASK_EVENT_TYPE', () => {
  it('has all required event types', () => {
    expect(TASK_EVENT_TYPE).toContain('created');
    expect(TASK_EVENT_TYPE).toContain('started');
    expect(TASK_EVENT_TYPE).toContain('progress');
    expect(TASK_EVENT_TYPE).toContain('completed');
    expect(TASK_EVENT_TYPE).toContain('failed');
    expect(TASK_EVENT_TYPE).toContain('degraded');
    expect(TASK_EVENT_TYPE).toContain('cancelled');
    expect(TASK_EVENT_TYPE).toContain('recovery_detected');
    expect(TASK_EVENT_TYPE).toContain('suspended');
    expect(TASK_EVENT_TYPE).toContain('resumed');
  });

  it('has no duplicates', () => {
    expect(new Set(TASK_EVENT_TYPE).size).toBe(TASK_EVENT_TYPE.length);
  });
});

describe('TASK_EVENT_PAYLOAD_SCHEMA', () => {
  it('validates minimal created event', () => {
    const r = TASK_EVENT_PAYLOAD_SCHEMA.parse({
      taskId: 't1', type: 'created', timestamp: 100,
    });
    expect(r.taskId).toBe('t1');
    expect(r.type).toBe('created');
  });

  it('validates progress event', () => {
    const r = TASK_EVENT_PAYLOAD_SCHEMA.parse({
      taskId: 't1', type: 'progress', timestamp: 200,
      progress: 50, message: '处理中...',
    });
    expect(r.progress).toBe(50);
    expect(r.message).toBe('处理中...');
  });

  it('rejects progress > 100', () => {
    expect(() =>
      TASK_EVENT_PAYLOAD_SCHEMA.parse({
        taskId: 't1', type: 'progress', timestamp: 1, progress: 200,
      })
    ).toThrow();
  });

  it('validates failed event with error', () => {
    const r = TASK_EVENT_PAYLOAD_SCHEMA.parse({
      taskId: 't1', type: 'failed', timestamp: 300,
      error: { code: 'E001', message: 'crashed', recoverable: true },
    });
    expect(r.error!.recoverable).toBe(true);
    expect(r.error!.code).toBe('E001');
  });

  it('validates event with optional fields', () => {
    const r = TASK_EVENT_PAYLOAD_SCHEMA.parse({
      taskId: 't1', type: 'completed', timestamp: 400,
      projectId: 'prj1', pipelineId: 'p1',
      data: { result: 'ok' },
    });
    expect(r.projectId).toBe('prj1');
    expect(r.pipelineId).toBe('p1');
    expect(r.data).toEqual({ result: 'ok' });
  });

  it('rejects invalid event type', () => {
    expect(() =>
      TASK_EVENT_PAYLOAD_SCHEMA.parse({
        taskId: 't1', type: 'invalid_type', timestamp: 1,
      })
    ).toThrow();
  });
});

describe('TASK_STATUS', () => {
  it('has all required statuses', () => {
    expect(TASK_STATUS).toContain('idle');
    expect(TASK_STATUS).toContain('running');
    expect(TASK_STATUS).toContain('paused');
    expect(TASK_STATUS).toContain('completed');
    expect(TASK_STATUS).toContain('failed');
    expect(TASK_STATUS).toContain('cancelled');
  });
});

describe('TASK_STATUS_SCHEMA', () => {
  it('validates valid status', () => {
    expect(TASK_STATUS_SCHEMA.parse('running')).toBe('running');
  });

  it('rejects invalid status', () => {
    expect(() => TASK_STATUS_SCHEMA.parse('unknown')).toThrow();
  });
});
