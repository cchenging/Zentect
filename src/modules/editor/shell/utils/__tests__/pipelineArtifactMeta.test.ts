// Module: editor/shell/utils/pipelineArtifactMeta - 单元测试
// 阶段0/4/5 回归：输入键变化矩阵（哪改该变、哪改不该变）+ legacy/stale/unverified 语义 +
// 步骤1 四子步骤独立版本 + 依赖图向下游传播。

import { describe, it, expect } from 'vitest';
import {
  KEY_VERSION,
  createEmptyArtifactMeta,
  computeInputKey,
  evaluateArtifact,
  evaluateStep1Artifact,
  normalizeArtifactMeta,
  readArtifactRev,
  type ArtifactInputContext,
  type ArtifactKey,
  type ArtifactMeta,
  type ArtifactStamp,
  type Step1SubStepKey,
} from '../pipelineArtifactMeta';

type ExtractionConfig = NonNullable<ArtifactInputContext['extractionConfig']>;

const baseExtractionConfig = (): ExtractionConfig => ({
  targetLanguage: 'zh-CN',
  frames: {
    enabled: true,
    mode: 'AUTO_ADAPTIVE',
    frameDensityPreset: 'standard',
    sceneThreshold: 0.25,
    fps: 2,
    minFrameInterval: 3.5,
    matrixMode: 'auto',
  },
  audio: { enabled: true, separationMode: 'quality', engine: 'mdx' },
  whisper: { enabled: true, engine: 'paraformer', language: 'zh', modelSize: 'large-v3' },
  faces: { enabled: true, engine: 'insightface' },
});

const baseCtx = (): ArtifactInputContext => ({
  media: { id: 'm1', filePath: 'C:/media/a.mp4' },
  extractionConfig: baseExtractionConfig(),
  revs: {
    '1.frames': 1, '1.audio': 1, '1.whisper': 1, '1.faces': 1,
    2: 1, 3: 1, 4: 1,
  },
  scriptConfig: {
    style: '爆款短视频',
    speechRate: 5.2,
    pipelineParams: { emotionTone: 'epic', narrationRatio: 0.7 },
  },
  ttsConfig: { engine: 'edge', voiceId: 'v1', speechRate: 1.0 },
  asrLines: [{ startMs: 0, endMs: 1000, text: '第一句' }],
  roles: [{ name: '梦梦' }],
  bgm: { id: 'bgm1', filePath: 'C:/media/bgm.mp3' },
});

const keyOf = (key: ArtifactKey, ctx: ArtifactInputContext = baseCtx()) =>
  computeInputKey(key, ctx);

describe('computeInputKey', () => {
  it('同一上下文稳定，且对象键顺序不影响指纹', () => {
    const a = keyOf('3');
    expect(keyOf('3')).toBe(a);

    const reordered = baseCtx();
    reordered.scriptConfig = {
      pipelineParams: { narrationRatio: 0.7, emotionTone: 'epic' },
      speechRate: 5.2,
      style: '爆款短视频',
    };
    expect(keyOf('3', reordered)).toBe(a);
  });

  describe('步骤1：四个子步骤各自独立', () => {
    it('抽帧 fps 变化 → 只影响 frames 子步骤', () => {
      const ctx = baseCtx();
      ctx.extractionConfig!.frames.fps = 3;
      expect(keyOf('1.frames', ctx)).not.toBe(keyOf('1.frames'));
      expect(keyOf('1.audio', ctx)).toBe(keyOf('1.audio'));
      expect(keyOf('1.whisper', ctx)).toBe(keyOf('1.whisper'));
      expect(keyOf('1.faces', ctx)).toBe(keyOf('1.faces'));
    });

    it('音频分离策略变化 → 影响 audio 与 whisper（ASR 输入），不影响 frames/faces', () => {
      const ctx = baseCtx();
      ctx.extractionConfig!.audio.separationMode = 'fast';
      expect(keyOf('1.audio', ctx)).not.toBe(keyOf('1.audio'));
      expect(keyOf('1.whisper', ctx)).not.toBe(keyOf('1.whisper'));
      expect(keyOf('1.frames', ctx)).toBe(keyOf('1.frames'));
      expect(keyOf('1.faces', ctx)).toBe(keyOf('1.faces'));
    });

    it('ASR 引擎/模型变化 → 只影响 whisper 子步骤', () => {
      const ctx = baseCtx();
      ctx.extractionConfig!.whisper.engine = 'faster-whisper';
      expect(keyOf('1.whisper', ctx)).not.toBe(keyOf('1.whisper'));
      expect(keyOf('1.audio', ctx)).toBe(keyOf('1.audio'));
      expect(keyOf('1.frames', ctx)).toBe(keyOf('1.frames'));
      expect(keyOf('1.faces', ctx)).toBe(keyOf('1.faces'));

      const model = baseCtx();
      model.extractionConfig!.whisper.modelSize = 'small';
      expect(keyOf('1.whisper', model)).not.toBe(keyOf('1.whisper'));
    });

    it('人脸引擎变化 → 只影响 faces 子步骤', () => {
      const ctx = baseCtx();
      ctx.extractionConfig!.faces.engine = 'mediapipe';
      expect(keyOf('1.faces', ctx)).not.toBe(keyOf('1.faces'));
      expect(keyOf('1.frames', ctx)).toBe(keyOf('1.frames'));
      expect(keyOf('1.audio', ctx)).toBe(keyOf('1.audio'));
      expect(keyOf('1.whisper', ctx)).toBe(keyOf('1.whisper'));
    });

    it('OP/ED 裁剪区间变化 → 四个子步骤全部变化', () => {
      const ctx = baseCtx();
      ctx.extractionConfig!.mediaTrim = { defaultTrimStartMs: 90_000 };
      expect(keyOf('1.frames', ctx)).not.toBe(keyOf('1.frames'));
      expect(keyOf('1.audio', ctx)).not.toBe(keyOf('1.audio'));
      expect(keyOf('1.whisper', ctx)).not.toBe(keyOf('1.whisper'));
      expect(keyOf('1.faces', ctx)).not.toBe(keyOf('1.faces'));
    });

    it('素材文件变化 → 四个子步骤全部变化', () => {
      const ctx = baseCtx();
      ctx.media = { id: 'm1', filePath: 'C:/media/b.mp4' };
      expect(keyOf('1.frames', ctx)).not.toBe(keyOf('1.frames'));
      expect(keyOf('1.audio', ctx)).not.toBe(keyOf('1.audio'));
      expect(keyOf('1.whisper', ctx)).not.toBe(keyOf('1.whisper'));
      expect(keyOf('1.faces', ctx)).not.toBe(keyOf('1.faces'));
    });

    it('拼图模式 matrixMode / 旧 density 残留 → 子步骤指纹不变（属于步骤2 输入）', () => {
      const matrix = baseCtx();
      matrix.extractionConfig!.frames.matrixMode = '3x3';
      expect(keyOf('1.frames', matrix)).toBe(keyOf('1.frames'));

      const density = baseCtx();
      density.extractionConfig!.frames.density = 'dense';
      expect(keyOf('1.frames', density)).toBe(keyOf('1.frames'));
    });
  });

  describe('步骤2：只依赖 frames + 拼图模式', () => {
    it('frames rev 变化 → 变化；whisper/audio/faces rev 变化 → 不变', () => {
      const frames = baseCtx();
      frames.revs = { ...frames.revs, '1.frames': 2 };
      expect(keyOf('2', frames)).not.toBe(keyOf('2'));

      const whisper = baseCtx();
      whisper.revs = { ...whisper.revs, '1.whisper': 2 };
      expect(keyOf('2', whisper)).toBe(keyOf('2'));

      const audio = baseCtx();
      audio.revs = { ...audio.revs, '1.audio': 2 };
      expect(keyOf('2', audio)).toBe(keyOf('2'));

      const faces = baseCtx();
      faces.revs = { ...faces.revs, '1.faces': 2 };
      expect(keyOf('2', faces)).toBe(keyOf('2'));
    });

    it('matrixMode 变化 → 变化', () => {
      const ctx = baseCtx();
      ctx.extractionConfig!.frames.matrixMode = '3x3';
      expect(keyOf('2', ctx)).not.toBe(keyOf('2'));
    });

    it('ASR 改字或角色改名 → 不变化（步骤2 只看画面）', () => {
      const asrCtx = baseCtx();
      asrCtx.asrLines = [{ startMs: 0, endMs: 1000, text: '改写后的第一句' }];
      expect(keyOf('2', asrCtx)).toBe(keyOf('2'));

      const roleCtx = baseCtx();
      roleCtx.roles = [{ name: '小美' }];
      expect(keyOf('2', roleCtx)).toBe(keyOf('2'));
    });
  });

  describe('步骤3：依赖 frames→步骤2、whisper、faces + 文案/ASR/角色', () => {
    it('rev frames / whisper / faces / 步骤2 任一变化 → 变化', () => {
      for (const key of ['1.frames', '1.whisper', '1.faces', '2'] as const) {
        const ctx = baseCtx();
        ctx.revs = { ...ctx.revs, [key]: (ctx.revs?.[key] ?? 0) + 1 };
        expect(keyOf('3', ctx)).not.toBe(keyOf('3'));
      }
    });

    it('audio 配置变化（通过 whisper 依赖）→ 变化', () => {
      const ctx = baseCtx();
      ctx.extractionConfig!.audio.engine = 'demucs';
      expect(keyOf('3', ctx)).not.toBe(keyOf('3'));
    });

    it('文案风格 / 基准语速 / 融合参数变化 → 变化', () => {
      const style = baseCtx();
      style.scriptConfig = { ...style.scriptConfig, style: '纪录片' };
      expect(keyOf('3', style)).not.toBe(keyOf('3'));

      const rate = baseCtx();
      rate.scriptConfig = { ...rate.scriptConfig, speechRate: 4.5 };
      expect(keyOf('3', rate)).not.toBe(keyOf('3'));

      const params = baseCtx();
      params.scriptConfig = {
        ...params.scriptConfig,
        pipelineParams: { emotionTone: 'warm', narrationRatio: 0.7 },
      };
      expect(keyOf('3', params)).not.toBe(keyOf('3'));
    });

    it('ASR 改字 / 删行 / 改时间轴、角色改名 → 变化', () => {
      const text = baseCtx();
      text.asrLines = [{ startMs: 0, endMs: 1000, text: '第一句（改字）' }];
      expect(keyOf('3', text)).not.toBe(keyOf('3'));

      const removed = baseCtx();
      removed.asrLines = [];
      expect(keyOf('3', removed)).not.toBe(keyOf('3'));

      const timing = baseCtx();
      timing.asrLines = [{ startMs: 0, endMs: 1200, text: '第一句' }];
      expect(keyOf('3', timing)).not.toBe(keyOf('3'));

      const role = baseCtx();
      role.roles = [{ name: '小美' }];
      expect(keyOf('3', role)).not.toBe(keyOf('3'));
    });
  });

  describe('步骤4：上游 rev3 + TTS 引擎/音色/语速', () => {
    it('rev3 变化 → 变化（段落手改走 touchArtifact 抬 rev）', () => {
      const ctx = baseCtx();
      ctx.revs = { ...ctx.revs, 3: 2 };
      expect(keyOf('4', ctx)).not.toBe(keyOf('4'));
    });

    it('引擎 / 音色 / 合成语速变化 → 变化', () => {
      const engine = baseCtx();
      engine.ttsConfig = { ...engine.ttsConfig, engine: 'doubao' };
      expect(keyOf('4', engine)).not.toBe(keyOf('4'));

      const voice = baseCtx();
      voice.ttsConfig = { ...voice.ttsConfig, voiceId: 'v2' };
      expect(keyOf('4', voice)).not.toBe(keyOf('4'));

      const rate = baseCtx();
      rate.ttsConfig = { ...rate.ttsConfig, speechRate: 1.2 };
      expect(keyOf('4', rate)).not.toBe(keyOf('4'));
    });

    it('BGM 变化不影响步骤4 输入键', () => {
      const ctx = baseCtx();
      ctx.bgm = null;
      expect(keyOf('4', ctx)).toBe(keyOf('4'));
    });
  });

  describe('步骤5：上游 rev4 + ASR + 角色名 + BGM', () => {
    it('rev4 变化 → 变化', () => {
      const ctx = baseCtx();
      ctx.revs = { ...ctx.revs, 4: 2 };
      expect(keyOf('5', ctx)).not.toBe(keyOf('5'));
    });

    it('换 BGM / 删 BGM → 变化', () => {
      const changed = baseCtx();
      changed.bgm = { id: 'bgm2', filePath: 'C:/media/bgm2.mp3' };
      expect(keyOf('5', changed)).not.toBe(keyOf('5'));

      const removed = baseCtx();
      removed.bgm = null;
      expect(keyOf('5', removed)).not.toBe(keyOf('5'));
    });

    it('ASR 改字 / 角色改名 → 变化', () => {
      const text = baseCtx();
      text.asrLines = [{ startMs: 0, endMs: 1000, text: '改字' }];
      expect(keyOf('5', text)).not.toBe(keyOf('5'));

      const role = baseCtx();
      role.roles = [{ name: '小美' }];
      expect(keyOf('5', role)).not.toBe(keyOf('5'));
    });
  });

  it('KEY_VERSION 参与指纹', () => {
    expect(keyOf('1.frames')).toContain(`kv${KEY_VERSION}`);
    expect(keyOf('5')).toContain(`kv${KEY_VERSION}`);
  });
});

describe('evaluateArtifact', () => {
  const buildMeta = (stampOverrides: Partial<ArtifactStamp> = {}, rev = 3): ArtifactMeta => {
    const stamp: ArtifactStamp = {
      rev,
      fromKey: 'current-key',
      keyVersion: KEY_VERSION,
      valid: true,
      source: 'renderer',
      ...stampOverrides,
    };
    return { revs: { 5: rev }, stamps: { 5: stamp } };
  };

  const evaluate = (meta: ArtifactMeta | null | undefined, status = 'completed') =>
    evaluateArtifact({ key: '5', status, meta, currentInputKey: 'current-key' });

  it('completed + 指纹匹配 + valid + renderer → valid，可自动流转、不阻断导出', () => {
    const result = evaluate(buildMeta());
    expect(result.state).toBe('valid');
    expect(result.autoFlow).toBe(true);
    expect(result.exportBlocked).toBe(false);
  });

  it('步骤未完成（running/idle/failed）→ not-completed，不认证', () => {
    for (const status of ['running', 'idle', 'failed']) {
      const result = evaluate(buildMeta(), status);
      expect(result.state).toBe('not-completed');
      expect(result.autoFlow).toBe(false);
    }
  });

  it('输入指纹不匹配 → stale，导出阻断', () => {
    const result = evaluate(buildMeta({ fromKey: 'old-key' }));
    expect(result.state).toBe('stale');
    expect(result.autoFlow).toBe(false);
    expect(result.exportBlocked).toBe(true);
  });

  it('keyVersion 不匹配 → stale（防输入定义变更后误认证）', () => {
    const result = evaluate(buildMeta({ keyVersion: KEY_VERSION + 1 }));
    expect(result.state).toBe('stale');
    expect(result.exportBlocked).toBe(true);
  });

  it('valid=false（失败/中止后恢复旧数据）→ unverified，导出阻断', () => {
    const result = evaluate(buildMeta({ valid: false }));
    expect(result.state).toBe('unverified');
    expect(result.autoFlow).toBe(false);
    expect(result.exportBlocked).toBe(true);
  });

  it('主进程直写（source=backend）→ unverified，导出阻断', () => {
    const result = evaluate(buildMeta({ source: 'backend', valid: false }));
    expect(result.state).toBe('unverified');
    expect(result.exportBlocked).toBe(true);
  });

  it('legacy 旧项目：不认证为有效，但不阻断导出', () => {
    const result = evaluate(buildMeta({ source: 'legacy', valid: false, fromKey: '' }));
    expect(result.state).toBe('legacy');
    expect(result.autoFlow).toBe(false);
    expect(result.exportBlocked).toBe(false);
  });

  it('无元数据（缺失）→ missing，只警告不阻断', () => {
    expect(evaluate(null).state).toBe('missing');
    expect(evaluate(undefined).state).toBe('missing');
    expect(evaluate(createEmptyArtifactMeta()).state).toBe('missing');
    expect(evaluate(createEmptyArtifactMeta()).exportBlocked).toBe(false);
  });

  it('rev=0 视作无产物 → missing', () => {
    const result = evaluate(buildMeta({ rev: 0 }, 0));
    expect(result.state).toBe('missing');
    expect(result.autoFlow).toBe(false);
  });

  it('readArtifactRev 缺失返回 0', () => {
    expect(readArtifactRev(null, '5')).toBe(0);
    expect(readArtifactRev({ revs: { 5: 7 }, stamps: {} }, '5')).toBe(7);
    expect(readArtifactRev({ revs: {}, stamps: {} }, '3')).toBe(0);
  });
});

describe('evaluateStep1Artifact（启用子步骤聚合）', () => {
  const allKeys: Step1SubStepKey[] = ['1.frames', '1.audio', '1.whisper', '1.faces'];

  const buildStep1 = (
    currentKeys: Partial<Record<Step1SubStepKey, string>>,
    options: { legacyKeys?: Step1SubStepKey[]; invalidKeys?: Step1SubStepKey[] } = {}
  ): { meta: ArtifactMeta; currentInputKeys: Partial<Record<Step1SubStepKey, string>> } => {
    const meta: ArtifactMeta = { revs: {}, stamps: {} };
    allKeys.forEach((key) => {
      const fromKey = currentKeys[key] ?? '';
      const legacy = options.legacyKeys?.includes(key);
      const invalid = options.invalidKeys?.includes(key);
      meta.revs[key] = 1;
      meta.stamps[key] = {
        rev: 1,
        fromKey: legacy ? '' : (invalid ? 'old-key' : fromKey),
        keyVersion: legacy ? 0 : KEY_VERSION,
        valid: !legacy && !invalid,
        source: legacy ? 'legacy' : (invalid ? 'renderer' : 'renderer'),
      };
    });
    return { meta, currentInputKeys: currentKeys };
  };

  const currentKeys = (ctx: ArtifactInputContext = baseCtx()) => ({
    '1.frames': keyOf('1.frames', ctx),
    '1.audio': keyOf('1.audio', ctx),
    '1.whisper': keyOf('1.whisper', ctx),
    '1.faces': keyOf('1.faces', ctx),
  });

  it('启用子步骤全部有效 → valid、可自动流转', () => {
    const built = buildStep1(currentKeys());
    const result = evaluateStep1Artifact({
      status: 'completed', meta: built.meta, enabledKeys: allKeys, currentInputKeys: built.currentInputKeys,
    });
    expect(result.state).toBe('valid');
    expect(result.autoFlow).toBe(true);
    expect(result.exportBlocked).toBe(false);
  });

  it('任一启用子步骤 stale → 整体 stale 且导出阻断', () => {
    const built = buildStep1(currentKeys(), { invalidKeys: ['1.frames'] });
    const result = evaluateStep1Artifact({
      status: 'completed', meta: built.meta, enabledKeys: allKeys, currentInputKeys: built.currentInputKeys,
    });
    expect(result.state).toBe('stale');
    expect(result.autoFlow).toBe(false);
    expect(result.exportBlocked).toBe(true);
  });

  it('禁用的子步骤不参与聚合（其 stale 不影响整体）', () => {
    const built = buildStep1(currentKeys(), { invalidKeys: ['1.frames'] });
    const result = evaluateStep1Artifact({
      status: 'completed', meta: built.meta, enabledKeys: ['1.audio', '1.whisper', '1.faces'],
      currentInputKeys: built.currentInputKeys,
    });
    expect(result.state).toBe('valid');
    expect(result.autoFlow).toBe(true);
  });

  it('legacy 子步骤 → 整体 legacy：不阻断导出但不自动流转', () => {
    const built = buildStep1(currentKeys(), { legacyKeys: ['1.faces'] });
    const result = evaluateStep1Artifact({
      status: 'completed', meta: built.meta, enabledKeys: allKeys, currentInputKeys: built.currentInputKeys,
    });
    expect(result.state).toBe('legacy');
    expect(result.autoFlow).toBe(false);
    expect(result.exportBlocked).toBe(false);
  });

  it('步骤未完成 → not-completed', () => {
    const built = buildStep1(currentKeys());
    const result = evaluateStep1Artifact({
      status: 'running', meta: built.meta, enabledKeys: allKeys, currentInputKeys: built.currentInputKeys,
    });
    expect(result.state).toBe('not-completed');
    expect(result.autoFlow).toBe(false);
  });
});

describe('normalizeArtifactMeta（hydrate 恢复）', () => {
  it('旧项目无元数据：已完成的步骤补 legacy stamp（步骤1 展开为四个子步骤）', () => {
    const meta = normalizeArtifactMeta(undefined, [true, true, false, false, false]);
    for (const key of ['1.frames', '1.audio', '1.whisper', '1.faces'] as const) {
      expect(meta.stamps[key]).toMatchObject({ rev: 1, source: 'legacy', valid: false });
      expect(meta.revs[key]).toBe(1);
    }
    expect(meta.stamps['2']).toMatchObject({ rev: 1, source: 'legacy', valid: false });
    expect(meta.stamps['3']).toBeUndefined();

    // legacy 可查看/可导出，但不认证、不自动流转
    const legacy = evaluateArtifact({
      key: '2',
      status: 'completed',
      meta,
      currentInputKey: 'whatever-new-key',
    });
    expect(legacy.state).toBe('legacy');
    expect(legacy.autoFlow).toBe(false);
    expect(legacy.exportBlocked).toBe(false);
  });

  it('旧粗粒度键 1 展开为四个 legacy 子步骤（沿用其 rev），避免误判 stale 阻断导出', () => {
    const meta = normalizeArtifactMeta(
      {
        revs: { 1: 4 },
        stamps: { 1: { rev: 4, fromKey: 'legacy-key', keyVersion: 1, valid: true, source: 'renderer' } },
      },
      [true, false, false, false, false],
    );
    for (const key of ['1.frames', '1.audio', '1.whisper', '1.faces'] as const) {
      expect(meta.stamps[key]).toMatchObject({ rev: 4, source: 'legacy', valid: false });
    }
  });

  it('已有子步骤 stamp 原样保留，只补缺失的已完成步骤', () => {
    const raw = {
      revs: { '1.frames': 2, 3: 4 },
      stamps: {
        '1.frames': { rev: 2, fromKey: 'kf', keyVersion: KEY_VERSION, valid: true, source: 'renderer' },
        3: { rev: 4, fromKey: 'k3', keyVersion: KEY_VERSION, valid: true, source: 'renderer' },
      },
    };
    const meta = normalizeArtifactMeta(raw, [true, true, true, false, false]);
    expect(meta.stamps['1.frames']).toMatchObject({ rev: 2, fromKey: 'kf', valid: true, source: 'renderer' });
    expect(meta.stamps['1.audio']?.source).toBe('legacy');
    expect(meta.stamps['1.whisper']?.source).toBe('legacy');
    expect(meta.stamps['3']).toMatchObject({ rev: 4, fromKey: 'k3', valid: true, source: 'renderer' });
    expect(meta.revs['3']).toBe(4);
    expect(meta.stamps['2']?.source).toBe('legacy');
  });

  it('非法 stamp 降级为 legacy；rev 非数字的条目直接丢弃', () => {
    const meta = normalizeArtifactMeta(
      {
        revs: { 3: 'abc' },
        stamps: { 3: { rev: 1, fromKey: 'x', keyVersion: 1, valid: true, source: 'unknown' } },
      },
      [true],
    );
    expect(meta.stamps['3']).toMatchObject({ source: 'legacy', valid: false });
    expect(meta.revs['3']).toBe(1);

    const dropped = normalizeArtifactMeta({ stamps: { 3: { rev: 'abc' } } }, []);
    expect(dropped.stamps['3']).toBeUndefined();
  });

  it('backend 直写 stamp 恢复后仍为 unverified（导出阻断）', () => {
    const meta = normalizeArtifactMeta(
      { stamps: { 5: { rev: 1, fromKey: '', keyVersion: KEY_VERSION, valid: false, source: 'backend' } } },
      [true, true, true, true, true],
    );
    const result = evaluateArtifact({ key: '5', status: 'completed', meta, currentInputKey: 'k5' });
    // backend stamp 的 fromKey 为空 → 先判 stale；两者都属于导出阻断
    expect(result.exportBlocked).toBe(true);
    expect(result.autoFlow).toBe(false);
  });
});
