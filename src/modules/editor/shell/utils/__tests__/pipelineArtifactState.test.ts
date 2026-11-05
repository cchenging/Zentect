// Module: editor/shell/utils/pipelineArtifactState - 单元测试（阶段1 写入 API 语义）

import { beforeEach, describe, expect, it } from 'vitest';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';
import {
  ARTIFACT_KEYS,
  KEY_VERSION,
  computeInputKey,
  createEmptyArtifactMeta,
  evaluateArtifact,
  type ArtifactKey,
  type ArtifactMeta,
  type ArtifactStamp,
} from '../pipelineArtifactMeta';
import {
  beginStepRun,
  buildArtifactInputContext,
  commitArtifacts,
  failStepRun,
  getArtifactState,
  isStepArtifactValid,
  markArtifactsStale,
  touchArtifact,
} from '../pipelineArtifactState';

const seedStamp = (overrides: Partial<ArtifactStamp> = {}): ArtifactStamp => ({
  rev: 2,
  fromKey: 'seed-key',
  keyVersion: KEY_VERSION,
  valid: true,
  source: 'renderer',
  ...overrides,
});

const metaOf = (): ArtifactMeta => usePipelineStore.getState().artifactMeta;

const currentKey = (key: '3' | '5') => computeInputKey(key, buildArtifactInputContext());

const evaluate = (key: '3' | '5') => evaluateArtifact({
  key,
  status: 'completed',
  meta: metaOf(),
  currentInputKey: currentKey(key),
});

beforeEach(() => {
  usePipelineStore.setState({
    artifactMeta: createEmptyArtifactMeta(),
    stepStatuses: ['completed', 'completed', 'completed', 'completed', 'completed'],
  });
  useProjectStore.setState({
    // projectId 置空：版本落盘在测试环境跳过，仅验证内存态语义
    projectId: '',
    mediaItems: [{ id: 'm1', filePath: 'C:/media/a.mp4' }] as any,
    roles: [{ name: '梦梦' }] as any,
  });
  useStep1Store.setState({ extractionConfig: null, asrLines: [] } as any);
  useStep3Store.setState({ scriptStyle: '爆款短视频', speechRate: 5.2, pipelineParams: {} } as any);
  useStep4Store.setState({ ttsEngine: 'edge', ttsVoiceId: 'v1', speechRate: 1.0 });
  useStep5Store.setState({ activeBgm: null });
});

describe('beginStepRun', () => {
  it('冻结输入指纹，且不提升 rev', async () => {
    const handle = await beginStepRun('3');
    expect(handle.fromKey).toBe(currentKey('3'));
    expect(metaOf().revs['3'] ?? 0).toBe(0);
  });

  it('已有产物标记失效但不改 rev；下游同样失效', async () => {
    usePipelineStore.setState({
      artifactMeta: {
        revs: { 3: 2, 5: 4 },
        stamps: { 3: seedStamp({ rev: 2 }), 5: seedStamp({ rev: 4 }) },
      },
    });
    await beginStepRun('3');

    expect(metaOf().revs['3']).toBe(2);
    expect(metaOf().revs['5']).toBe(4);
    expect(metaOf().stamps['3']?.valid).toBe(false);
    expect(metaOf().stamps['5']?.valid).toBe(false);
    expect(evaluate('5').exportBlocked).toBe(true);
  });
});

describe('commitArtifacts', () => {
  it('成功提交：rev+1、fromKey 保持冻结值、valid=true、source=renderer', async () => {
    const handle = await beginStepRun('3');
    await commitArtifacts(handle);

    const stamp = metaOf().stamps['3']!;
    expect(metaOf().revs['3']).toBe(1);
    expect(stamp).toMatchObject({
      rev: 1,
      fromKey: handle.fromKey,
      keyVersion: KEY_VERSION,
      valid: true,
      source: 'renderer',
    });
    expect(evaluate('3').state).toBe('valid');
  });

  it('重复提交累加 rev', async () => {
    await commitArtifacts(await beginStepRun('3'));
    await commitArtifacts(await beginStepRun('3'));
    expect(metaOf().revs['3']).toBe(2);
  });

  it('执行中上游 rev 变化：commit 不重算 fromKey，产物立即判为 stale', async () => {
    const handle = await beginStepRun('3');
    // 执行期间步骤2 重跑（rev 变化），但本次步骤3 的输入快照仍是旧值
    usePipelineStore.setState({
      artifactMeta: {
        revs: { 2: 1 },
        stamps: { 2: seedStamp({ rev: 1 }) },
      },
    });
    await commitArtifacts(handle);

    expect(evaluate('3').state).toBe('stale');
    expect(evaluate('3').exportBlocked).toBe(true);
  });

  it('配置变化后当前输入指纹与旧 fromKey 不匹配 → stale', async () => {
    await commitArtifacts(await beginStepRun('3'));
    useStep3Store.setState({ scriptStyle: '纪录片' });
    expect(evaluate('3').state).toBe('stale');
  });
});

describe('failStepRun', () => {
  it('失败不提升 rev，已有产物保持 valid=false', async () => {
    usePipelineStore.setState({
      artifactMeta: {
        revs: { 3: 2 },
        stamps: { 3: seedStamp({ rev: 2, fromKey: currentKey('3') }) },
      },
    });
    const handle = await beginStepRun('3');
    await failStepRun(handle);

    expect(metaOf().revs['3']).toBe(2);
    expect(metaOf().stamps['3']?.valid).toBe(false);
    expect(evaluate('3').state).toBe('unverified');
  });

  it('首次执行失败不凭空创建 stamp', async () => {
    await failStepRun(await beginStepRun('3'));
    expect(metaOf().stamps['3']).toBeUndefined();
    expect(metaOf().revs['3'] ?? 0).toBe(0);
  });
});

describe('touchArtifact', () => {
  it('手工编辑：rev+1、按当前输入重算 fromKey、valid=true，并失效下游', async () => {
    useStep3Store.setState({ scriptStyle: '纪录片' });
    usePipelineStore.setState({
      artifactMeta: {
        revs: { 3: 1, 5: 3 },
        stamps: { 3: seedStamp({ rev: 1 }), 5: seedStamp({ rev: 3 }) },
      },
    });

    await touchArtifact('3');

    expect(metaOf().revs['3']).toBe(2);
    expect(metaOf().stamps['3']?.fromKey).toBe(currentKey('3'));
    expect(evaluate('3').state).toBe('valid');
    expect(metaOf().stamps['5']?.valid).toBe(false);
    expect(evaluate('5').exportBlocked).toBe(true);
  });
});

describe('markArtifactsStale（输入型手工改动）', () => {
  it('ASR/角色改动：只把下游标失效，不变更 rev、不认证当前产物为有效', async () => {
    usePipelineStore.setState({
      artifactMeta: {
        revs: { 3: 2, 4: 1, 5: 3 },
        stamps: {
          3: seedStamp({ rev: 2, fromKey: currentKey('3') }),
          4: seedStamp({ rev: 1 }),
          5: seedStamp({ rev: 3 }),
        },
      },
    });

    await markArtifactsStale(['3', '4', '5']);

    expect(metaOf().revs).toEqual({ 3: 2, 4: 1, 5: 3 });
    expect(metaOf().stamps['3']?.valid).toBe(false);
    expect(metaOf().stamps['4']?.valid).toBe(false);
    expect(metaOf().stamps['5']?.valid).toBe(false);
    expect(evaluate('5').exportBlocked).toBe(true);
  });

  it('无版本戳（旧项目）或已失效 → 空操作', async () => {
    usePipelineStore.setState({ artifactMeta: createEmptyArtifactMeta() });
    await markArtifactsStale(['3', '4', '5']);
    expect(metaOf().stamps).toEqual({});
  });
});

describe('单产物判定（自动跳过/UI 提示口径）', () => {
  it('仅 completed + 当前输入指纹匹配才算 valid', async () => {
    await commitArtifacts(await beginStepRun('3'));
    expect(getArtifactState('3')).toBe('valid');
    expect(isStepArtifactValid('3')).toBe(true);
  });

  it('配置变化后立即非 valid（自动流水线不得跳过）', async () => {
    await commitArtifacts(await beginStepRun('3'));
    useStep3Store.setState({ scriptStyle: '纪录片' });
    expect(getArtifactState('3')).toBe('stale');
    expect(isStepArtifactValid('3')).toBe(false);
  });

  it('状态非 completed → not-completed，不参与跳过', async () => {
    usePipelineStore.setState({
      artifactMeta: {
        revs: { 3: 1 },
        stamps: { 3: seedStamp({ rev: 1, fromKey: currentKey('3') }) },
      },
      stepStatuses: ['completed', 'completed', 'idle', 'idle', 'idle'],
    });
    expect(getArtifactState('3')).toBe('not-completed');
    expect(isStepArtifactValid('3')).toBe(false);
  });
});

describe('步骤1 子步骤粒度失效矩阵（阶段5 验收）', () => {
  const step1Config = () => ({
    targetLanguage: 'zh-CN',
    frames: {
      enabled: true, mode: 'AUTO_ADAPTIVE', frameDensityPreset: 'standard',
      sceneThreshold: 0.25, fps: 2, minFrameInterval: 3.5, matrixMode: 'auto',
    },
    audio: { enabled: true, separationMode: 'quality', engine: 'mdx' },
    whisper: { enabled: true, engine: 'paraformer', language: 'zh', modelSize: 'large-v3' },
    faces: { enabled: true, engine: 'insightface' },
  });

  const seedAllArtifacts = (): ArtifactMeta => {
    const meta: ArtifactMeta = { revs: {}, stamps: {} };
    ARTIFACT_KEYS.forEach((key) => {
      meta.revs[key] = 1;
    });
    // 用同一份 revs 计算 fromKey，避免「先写 stamp 再改 rev」导致自身直接 stale
    const ctx = { ...buildArtifactInputContext(), revs: meta.revs };
    ARTIFACT_KEYS.forEach((key) => {
      meta.stamps[key] = seedStamp({ rev: 1, fromKey: computeInputKey(key, ctx) });
    });
    return meta;
  };

  const setup = () => {
    useStep1Store.setState({
      extractionConfig: step1Config() as any,
    });
    usePipelineStore.setState({
      artifactMeta: seedAllArtifacts(),
      subStepStatuses: {
        frames: 'completed', audio: 'completed', whisper: 'completed', faces: 'completed',
      } as any,
      stepStatuses: ['completed', 'completed', 'completed', 'completed', 'completed'],
    });
  };

  const invalidatedKeys: Array<[ArtifactKey, ArtifactKey[]]> = [
    ['1.frames', ['2', '3', '4', '5']],
    ['1.audio', ['1.whisper', '3', '4', '5']],
    ['1.whisper', ['3', '4', '5']],
    ['1.faces', ['3', '4', '5']],
  ];

  it.each(invalidatedKeys)('begin %s → 自身及其依赖链失效，其余兄弟产物不受影响', async (key, downstream) => {
    setup();
    await beginStepRun(key);

    expect(metaOf().stamps[key]?.valid).toBe(false);
    downstream.forEach((dep) => expect(metaOf().stamps[dep]?.valid).toBe(false));

    const untouched = ARTIFACT_KEYS.filter((k) => k !== key && !downstream.includes(k));
    untouched.forEach((k) => expect(metaOf().stamps[k]?.valid).toBe(true));
  });

  it('改抽帧配置 → 只有 frames 链过期（步骤2~5），audio/whisper/faces 仍有效', () => {
    setup();
    const next = step1Config();
    next.frames.fps = 3;
    useStep1Store.setState({ extractionConfig: next as any });

    expect(getArtifactState('1.frames')).toBe('stale');
    expect(getArtifactState('1.audio')).toBe('valid');
    expect(getArtifactState('1.whisper')).toBe('valid');
    expect(getArtifactState('1.faces')).toBe('valid');
    for (const step of ['2', '3', '4', '5'] as const) {
      expect(getArtifactState(step)).toBe('stale');
    }
  });

  it('改 ASR 配置 → 只有 whisper 链过期（步骤3~5），步骤2 仍有效', () => {
    setup();
    const next = step1Config();
    next.whisper.engine = 'faster-whisper';
    useStep1Store.setState({ extractionConfig: next as any });

    expect(getArtifactState('1.whisper')).toBe('stale');
    expect(getArtifactState('1.frames')).toBe('valid');
    expect(getArtifactState('1.audio')).toBe('valid');
    expect(getArtifactState('1.faces')).toBe('valid');
    expect(getArtifactState('2')).toBe('valid');
    for (const step of ['3', '4', '5'] as const) {
      expect(getArtifactState(step)).toBe('stale');
    }
  });

  it('改音频配置 → audio 与 whisper 及其下游过期，步骤2 仍有效', () => {
    setup();
    const next = step1Config();
    next.audio.separationMode = 'fast';
    useStep1Store.setState({ extractionConfig: next as any });

    expect(getArtifactState('1.audio')).toBe('stale');
    expect(getArtifactState('1.whisper')).toBe('stale');
    expect(getArtifactState('1.frames')).toBe('valid');
    expect(getArtifactState('1.faces')).toBe('valid');
    expect(getArtifactState('2')).toBe('valid');
    for (const step of ['3', '4', '5'] as const) {
      expect(getArtifactState(step)).toBe('stale');
    }
  });

  it('子步骤完成提交后可被自动跳过（仅当状态 completed）', async () => {
    setup();
    usePipelineStore.setState({
      artifactMeta: createEmptyArtifactMeta(),
      subStepStatuses: { frames: 'completed' } as any,
    });
    await beginStepRun('1.frames');
    await commitArtifacts('1.frames');

    expect(metaOf().stamps['1.frames']?.valid).toBe(true);
    expect(isStepArtifactValid('1.frames')).toBe(true);

    usePipelineStore.setState({ subStepStatuses: { frames: 'idle' } as any });
    expect(isStepArtifactValid('1.frames')).toBe(false);
  });
});

