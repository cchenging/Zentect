import { describe, it, expect } from 'vitest';
import { FEATURE_FLAGS, isFeatureEnabled } from '../feature-flags';

describe('FEATURE_FLAGS', () => {
  it('has all required flags', () => {
    expect(FEATURE_FLAGS.USE_V1_PIPELINE_ADAPTER).toBe(true);
    expect(FEATURE_FLAGS.USE_SIMPLE_PIPELINE_RUNNER).toBe(true);
    expect(FEATURE_FLAGS.USE_PIPELINE_ENGINE).toBe(true);    // V1.1 DAG 引擎已激活
    expect(FEATURE_FLAGS.RENDERER_DIRECT_DAEMON).toBe(false);
  });

  it('Phase 0 核心基建已全部激活', () => {
    expect(FEATURE_FLAGS.USE_CHECKPOINT_REPOSITORY).toBe(true);
    expect(FEATURE_FLAGS.USE_PIPELINE_RECOVERY_SERVICE).toBe(true);
    expect(FEATURE_FLAGS.USE_TASK_EVENT_BUS).toBe(true);
    expect(FEATURE_FLAGS.USE_DATABASE_WRITE_QUEUE).toBe(true);
  });

  it('Phase 1-2 扩展模块已启用', () => {
    expect(FEATURE_FLAGS.USE_LOCAL_AI_GATEWAY).toBe(true);
    expect(FEATURE_FLAGS.USE_PROVIDER_GATEWAY).toBe(true);
    expect(FEATURE_FLAGS.USE_CREDENTIAL_MANAGER).toBe(true);
    expect(FEATURE_FLAGS.USE_FRAME_EXTRACTOR_MODULE).toBe(true);
    expect(FEATURE_FLAGS.USE_COMPUTE_RESOURCE_MANAGER).toBe(true);
  });

  it('Phase 3-4 高级特性', () => {
    expect(FEATURE_FLAGS.ENABLE_SUSPEND_RESUME).toBe(true);
    expect(FEATURE_FLAGS.ENABLE_JOB_QUEUE).toBe(false);
    expect(FEATURE_FLAGS.ENABLE_MULTI_ROLE_VOICE_BINDING).toBe(false);
  });

  it('has no undefined values', () => {
    const entries = Object.entries(FEATURE_FLAGS);
    entries.forEach(([, val]) => {
      expect([true, false]).toContain(val);
    });
  });
});

describe('isFeatureEnabled', () => {
  it('returns correct boolean for enabled flags', () => {
    expect(isFeatureEnabled('USE_V1_PIPELINE_ADAPTER')).toBe(true);
  });

  it('returns correct boolean for disabled flags', () => {
    expect(isFeatureEnabled('USE_PIPELINE_ENGINE')).toBe(true);    // V1.1 DAG 引擎已激活
    expect(isFeatureEnabled('RENDERER_DIRECT_DAEMON')).toBe(false);
  });
});
