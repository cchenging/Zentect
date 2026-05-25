import { describe, it, expect } from 'vitest';
import {
  PIPELINE_STEP_STATUS,
  PIPELINE_STEP_SCHEMA,
  PIPELINE_PROGRESS_PAYLOAD_SCHEMA,
  CHECKPOINT_SCHEMA,
} from '../pipeline';

describe('PIPELINE_STEP_STATUS', () => {
  it('has all required statuses', () => {
    expect(PIPELINE_STEP_STATUS).toContain('pending');
    expect(PIPELINE_STEP_STATUS).toContain('running');
    expect(PIPELINE_STEP_STATUS).toContain('completed');
    expect(PIPELINE_STEP_STATUS).toContain('failed');
    expect(PIPELINE_STEP_STATUS).toContain('degraded');
    expect(PIPELINE_STEP_STATUS).toContain('cancelled');
    expect(PIPELINE_STEP_STATUS).toContain('config_missing');
    expect(PIPELINE_STEP_STATUS).toContain('suspended');
  });

  it('has no duplicates', () => {
    expect(new Set(PIPELINE_STEP_STATUS).size).toBe(PIPELINE_STEP_STATUS.length);
  });
});

describe('PIPELINE_STEP_SCHEMA', () => {
  it('validates a minimal step', () => {
    const r = PIPELINE_STEP_SCHEMA.parse({ stepId: 's1', label: '抽帧', status: 'running' });
    expect(r.stepId).toBe('s1');
    expect(r.status).toBe('running');
  });

  it('validates step with error', () => {
    const r = PIPELINE_STEP_SCHEMA.parse({
      stepId: 's1', label: '抽帧', status: 'failed',
      error: { code: 'E001', message: 'ffmpeg crashed', recoverable: true },
    });
    expect(r.error!.recoverable).toBe(true);
  });

  it('rejects invalid status', () => {
    expect(() =>
      PIPELINE_STEP_SCHEMA.parse({ stepId: 's1', label: 'x', status: 'unknown' })
    ).toThrow();
  });

  it('validates step with timestamps', () => {
    const r = PIPELINE_STEP_SCHEMA.parse({
      stepId: 's1', label: 'x', status: 'completed',
      startedAt: 100, completedAt: 200,
    });
    expect(r.completedAt).toBe(200);
  });
});

describe('PIPELINE_PROGRESS_PAYLOAD_SCHEMA', () => {
  it('validates full payload', () => {
    const r = PIPELINE_PROGRESS_PAYLOAD_SCHEMA.parse({
      pipelineId: 'p1', projectId: 'prj1',
      currentStep: { stepId: 's1', label: '抽帧', status: 'running' },
      steps: [
        { stepId: 's1', label: '抽帧', status: 'running' },
        { stepId: 's2', label: 'ASR', status: 'pending' },
      ],
      overallProgress: 50,
    });
    expect(r.overallProgress).toBe(50);
    expect(r.steps).toHaveLength(2);
  });

  it('rejects overallProgress > 100', () => {
    expect(() =>
      PIPELINE_PROGRESS_PAYLOAD_SCHEMA.parse({
        pipelineId: 'p1', projectId: 'prj1',
        currentStep: { stepId: 's1', label: 'x', status: 'running' },
        steps: [],
        overallProgress: 150,
      })
    ).toThrow();
  });

  it('validates requireUserAction', () => {
    const r = PIPELINE_PROGRESS_PAYLOAD_SCHEMA.parse({
      pipelineId: 'p1', projectId: 'prj1',
      currentStep: { stepId: 's1', label: '选角', status: 'suspended' },
      steps: [],
      overallProgress: 60,
      requireUserAction: { type: 'confirm_cast', message: '请选择角色' },
    });
    expect(r.requireUserAction!.type).toBe('confirm_cast');
  });
});

describe('CHECKPOINT_SCHEMA', () => {
  it('validates checkpoint with data', () => {
    const r = CHECKPOINT_SCHEMA.parse({
      id: 'cp1', pipelineId: 'p1', projectId: 'prj1',
      stepId: 's1', status: 'completed', createdAt: 100,
      checkpointData: { frames: ['f1.jpg', 'f2.jpg'] },
    });
    expect(r.checkpointData!.frames).toHaveLength(2);
  });

  it('rejects invalid status', () => {
    expect(() =>
      CHECKPOINT_SCHEMA.parse({
        id: 'cp1', pipelineId: 'p1', projectId: 'prj1',
        stepId: 's1', status: 'invalid', createdAt: 100,
      })
    ).toThrow();
  });
});
