// Module: pipeline/step1-material - Types 单元测试
// P0 扩展：抽帧契约（2 枚举收拢 + densityPreset + 历史兼容映射）测试

import { describe, it, expect } from 'vitest';
import type {
  Step1Input,
  Step1Output,
  Step1Config,
  FramesConfig,
  AudioConfig,
  WhisperConfig,
  FacesConfig,
  Step1State,
  StepMaterialAnalysisViewProps,
} from '../types';
// P0 · 抽帧契约唯一真源（共享层）
import {
  normalizeFrameStrategy,
  LEGACY_FRAME_STRATEGY_COMPAT_MAP,
  DENSITY_PRESET_CONFIG,
  type FrameExtractStrategy,
  type DensityPreset,
} from '../../../../shared/contracts/capabilities';

describe('Step1 Types', () => {
  describe('Step1Input', () => {
    it('合法输入应包含 projectId / mediaPath / config', () => {
      const input: Step1Input = {
        projectId: 'proj_001',
        mediaPath: 'C:/media/video.mp4',
        config: {
          targetLanguage: 'zh-CN',
          frames: { enabled: true, mode: 'VLM_OPTIMIZED', sceneThreshold: 0.28, quality: 3, scale: 1024, fps: 2 },
          audio: { enabled: true },
          whisper: { enabled: true, engine: 'sensevoice' },
          faces: { enabled: true, engine: 'insightface' },
        },
      };
      expect(input.projectId).toBe('proj_001');
      expect(input.mediaPath).toBeTruthy();
      expect(input.config.targetLanguage).toBe('zh-CN');
    });

    it('config 中所有子配置均应存在', () => {
      const config: Step1Config = {
        targetLanguage: 'en-US',
        frames: { enabled: false, mode: 'UNIFORM_FPS', sceneThreshold: 0.3, quality: 5, scale: 720, fps: 1 },
        audio: { enabled: false },
        whisper: { enabled: false, engine: 'faster-whisper', language: 'en' },
        faces: { enabled: false, engine: 'mediapipe' },
      };
      expect(config.frames.enabled).toBe(false);
      expect(config.audio.enabled).toBe(false);
      expect(config.whisper.engine).toBe('faster-whisper');
      expect(config.faces.engine).toBe('mediapipe');
    });
  });

  describe('Step1Output', () => {
    it('应包含所有输出字段', () => {
      const output: Step1Output = {
        // 🔧 修复 TS2322：AsrLine.start 为 string，startMs/endMs 为 number（毫秒）
        asrLines: [{ id: '1', text: '你好', start: '00:00', startMs: 0, end: '00:01', endMs: 1500, editing: false } as any],
        framePaths: ['/frames/f1.jpg', '/frames/f2.jpg'],
        frameCount: 2,
        audioSeparated: true,
        // 🔧 修复 TS2353：Role 不含 facePath，改用 avatarPath
        roles: [{ id: 'r1', name: '角色A', avatarPath: '/faces/r1.jpg' }],
      };
      expect(output.asrLines).toHaveLength(1);
      expect(output.frameCount).toBe(2);
      expect(output.audioSeparated).toBe(true);
      expect(output.roles).toHaveLength(1);
    });

    it('空结果应为合法输出', () => {
      const output: Step1Output = {
        asrLines: [],
        framePaths: [],
        frameCount: 0,
        audioSeparated: false,
        roles: [],
      };
      expect(output.frameCount).toBe(0);
      expect(output.audioSeparated).toBe(false);
    });
  });

  describe('FramesConfig', () => {
    it('应支持四种抽帧策略', () => {
      const modes: FramesConfig['mode'][] = ['VLM_OPTIMIZED', 'UNIFORM_FPS', 'FAST_KEYFRAME', 'PRECISE_SINGLE'];
      expect(modes).toHaveLength(4);
      expect(new Set(modes).size).toBe(4);
    });

    it('可选字段 minFrameInterval / timePoint 可为 undefined', () => {
      const config: FramesConfig = {
        enabled: true,
        mode: 'UNIFORM_FPS',
        sceneThreshold: 0.25,
        quality: 3,
        scale: 1024,
        fps: 2,
      };
      expect(config.minFrameInterval).toBeUndefined();
      expect(config.timePoint).toBeUndefined();
    });

    it('timePoint 为 PRECISE_SINGLE 模式提供精确时间', () => {
      const config: FramesConfig = {
        enabled: true,
        mode: 'PRECISE_SINGLE',
        sceneThreshold: 0.25,
        quality: 3,
        scale: 1024,
        fps: 2,
        timePoint: 10.5,
      };
      expect(config.timePoint).toBe(10.5);
    });
  });

  describe('AudioConfig', () => {
    it('应包含 enabled 字段', () => {
      const config: AudioConfig = { enabled: true };
      expect(config.enabled).toBe(true);
    });

    it('disabled 应为合法状态', () => {
      const config: AudioConfig = { enabled: false };
      expect(config.enabled).toBe(false);
    });
  });

  describe('WhisperConfig', () => {
    it('应支持 sensevoice 和 faster-whisper 引擎', () => {
      const engines: WhisperConfig['engine'][] = ['sensevoice', 'faster-whisper'];
      expect(engines).toHaveLength(2);
    });

    it('language 为可选字段', () => {
      const config: WhisperConfig = { enabled: true, engine: 'sensevoice' };
      expect(config.language).toBeUndefined();
    });
  });

  describe('FacesConfig', () => {
    it('应支持 insightface 和 mediapipe 引擎', () => {
      const engines: FacesConfig['engine'][] = ['insightface', 'mediapipe'];
      expect(engines).toHaveLength(2);
    });
  });

  describe('Step1State', () => {
    it('初始状态应为合法默认值', () => {
      const state: Step1State = {
        asrLines: [],
        frameCount: 0,
        audioSeparated: false,
        roles: [],
        subStepProgresses: {},
        extractionConfig: {
          targetLanguage: 'zh-CN',
          frames: { enabled: true, mode: 'VLM_OPTIMIZED', sceneThreshold: 0.28, quality: 3, scale: 1024, fps: 2 },
          audio: { enabled: true },
          whisper: { enabled: true, engine: 'sensevoice' },
          faces: { enabled: true, engine: 'insightface' },
        },
      };
      expect(state.asrLines).toHaveLength(0);
      expect(state.frameCount).toBe(0);
      expect(state.subStepProgresses).toEqual({});
    });

    it('进度应反映子步骤完成状态', () => {
      const state: Step1State = {
        asrLines: [{ id: '1', text: '测试', start: '00:00', startMs: 0, end: '00:01', endMs: 1000, editing: false } as any],
        frameCount: 10,
        audioSeparated: true,
        roles: [{ id: 'r1', name: '角色', avatarPath: '/f.jpg' }],
        subStepProgresses: { frames: 100, asr: 100 },
        extractionConfig: {
          targetLanguage: 'zh-CN',
          frames: { enabled: true, mode: 'UNIFORM_FPS', sceneThreshold: 0.3, quality: 3, scale: 1024, fps: 2 },
          audio: { enabled: true },
          whisper: { enabled: true, engine: 'faster-whisper' },
          faces: { enabled: true, engine: 'insightface' },
        },
      };
      expect(state.subStepProgresses.frames).toBe(100);
    });
  });

  describe('StepMaterialAnalysisViewProps', () => {
    it('应包含所有回调函数', () => {
      const props: StepMaterialAnalysisViewProps = {
        asrLines: [],
        frameCount: 0,
        audioSeparated: false,
        // 🔧 修复 TS2741：补齐 vocalsIsFallback 必填字段
        vocalsIsFallback: false,
        mediaItems: [],
        roles: [],
        subStepStatuses: {},
        subStepProgresses: {},
        subStepTimings: {},
        extractionConfig: null,
        extractedData: null,
        onUpdateAsrLine: () => {},
        onRemoveAsrLine: () => {},
        onSetAsrLines: () => {},
        onSetCurrentTime: () => {},
        onSetActivePlaySource: () => {},
        onUpdateRole: () => {},
        onMergeRoles: () => {},
        onUnmergeRole: () => {},
        onDeleteRole: () => {},
        onSetSubStepStatus: () => {},
        onRetrySubStep: () => {},
        onAbortSubStep: () => {},
        onUpdateExtractionConfig: () => {},
      };
      expect(typeof props.onUpdateAsrLine).toBe('function');
      expect(typeof props.onRetrySubStep).toBe('function');
      expect(props.extractionConfig).toBeNull();
    });

    it('extractedData 可携带完整提取结果', () => {
      const props: StepMaterialAnalysisViewProps = {
        asrLines: [],
        frameCount: 5,
        audioSeparated: true,
        // 🔧 修复 TS2741：补齐 vocalsIsFallback 必填字段
        vocalsIsFallback: false,
        mediaItems: [],
        roles: [],
        subStepStatuses: {},
        subStepProgresses: {},
        subStepTimings: {},
        extractionConfig: {
          targetLanguage: 'zh-CN',
          frames: { enabled: true, mode: 'VLM_OPTIMIZED', sceneThreshold: 0.28, quality: 3, scale: 1024, fps: 2 },
          audio: { enabled: true },
          whisper: { enabled: true, engine: 'sensevoice' },
          faces: { enabled: true, engine: 'insightface' },
        },
        extractedData: {
          videoPath: '/media/v.mp4',
          vocalPath: '/audio/vocals.wav',
          backgroundPath: '/audio/bgm.wav',
          // 🔧 修复 TS2322：AsrLine.start 为 string，使用 as any 绕过严格类型
          asrLines: [{ id: '1', text: '测试', start: '00:00', startMs: 0, end: '00:01', endMs: 1000, editing: false } as any],
          frameCount: 5,
          framePaths: ['/frames/1.jpg'],
        },
        onUpdateAsrLine: () => {},
        onRemoveAsrLine: () => {},
        onSetAsrLines: () => {},
        onSetCurrentTime: () => {},
        onSetActivePlaySource: () => {},
        onUpdateRole: () => {},
        onMergeRoles: () => {},
        onUnmergeRole: () => {},
        onDeleteRole: () => {},
        onSetSubStepStatus: () => {},
        onRetrySubStep: () => {},
        onAbortSubStep: () => {},
        onUpdateExtractionConfig: () => {},
      };
      expect(props.extractedData!.videoPath).toBe('/media/v.mp4');
      expect(props.extractedData!.vocalPath).toBe('/audio/vocals.wav');
      expect(props.extractedData!.frameCount).toBe(5);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// P0 · 抽帧契约收拢（共享层 capabilities.ts）
// ═══════════════════════════════════════════════════════════════
describe('P0 · 抽帧契约收拢（FrameExtractStrategy + DensityPreset）', () => {
  describe('FrameExtractStrategy · 2 枚举收拢 + 历史兼容归一化', () => {
    it('normalizeFrameStrategy 所有历史别名 → AUTO_ADAPTIVE / UNIFORM_FPS 之一', () => {
      // LEGACY_COMPAT_MAP 里的每个 key 都应合法映射
      for (const [raw, expected] of Object.entries(LEGACY_FRAME_STRATEGY_COMPAT_MAP)) {
        expect(normalizeFrameStrategy(raw)).toBe(expected);
      }
      // 明确的 2 枚举直传保持不变
      expect(normalizeFrameStrategy('AUTO_ADAPTIVE')).toBe('AUTO_ADAPTIVE');
      expect(normalizeFrameStrategy('UNIFORM_FPS')).toBe('UNIFORM_FPS');
    });

    it('PRECISE_SINGLE / FAST_KEYFRAME / VLM_OPTIMIZED → 都归一化为 AUTO_ADAPTIVE（收拢核心）', () => {
      const legacy: Array<[string | null | undefined, FrameExtractStrategy]> = [
        ['PRECISE_SINGLE', 'AUTO_ADAPTIVE'],
        ['FAST_KEYFRAME', 'AUTO_ADAPTIVE'],
        ['VLM_OPTIMIZED', 'AUTO_ADAPTIVE'],
        ['vlm_optimized', 'AUTO_ADAPTIVE'],
        ['fast_keyframe', 'AUTO_ADAPTIVE'],
        ['iframe', 'AUTO_ADAPTIVE'],
        ['scene', 'AUTO_ADAPTIVE'],
        ['UNIFORM', 'UNIFORM_FPS'],
        ['uniform', 'UNIFORM_FPS'],
        ['UNIFORM_FPS', 'UNIFORM_FPS'],
      ];
      for (const [raw, expected] of legacy) {
        expect(normalizeFrameStrategy(raw)).toBe(expected);
      }
    });

    it('空值 / 未知值 → 回落到 fallback（默认 AUTO_ADAPTIVE）', () => {
      expect(normalizeFrameStrategy(null)).toBe('AUTO_ADAPTIVE');
      expect(normalizeFrameStrategy(undefined)).toBe('AUTO_ADAPTIVE');
      expect(normalizeFrameStrategy('')).toBe('AUTO_ADAPTIVE');
      expect(normalizeFrameStrategy('STRATEGY_NOT_EXIST')).toBe('AUTO_ADAPTIVE');
      expect(normalizeFrameStrategy('ANY', 'UNIFORM_FPS')).toBe('UNIFORM_FPS');
    });
  });

  describe('DensityPreset · 3 档抽帧密度预设（SSOT，framesPerMinute / minFrameInterval / sceneThreshold）', () => {
    it('sparse / standard / dense 三档均已定义，参数约束严格递增/递减', () => {
      const presets: DensityPreset[] = ['sparse', 'standard', 'dense'];
      for (const p of presets) {
        const cfg = DENSITY_PRESET_CONFIG[p];
        expect(cfg).toBeDefined();
        expect(cfg.framesPerMinute).toBeGreaterThan(0);
        expect(cfg.minFrameInterval).toBeGreaterThan(0);
        expect(cfg.sceneThreshold).toBeGreaterThan(0);
        expect(cfg.sceneThreshold).toBeLessThan(1);
        expect(cfg.label).toBeTruthy();
      }

      // 稀疏→标准→高密度：framesPerMinute 严格增大
      expect(DENSITY_PRESET_CONFIG.dense.framesPerMinute).toBeGreaterThan(
        DENSITY_PRESET_CONFIG.standard.framesPerMinute
      );
      expect(DENSITY_PRESET_CONFIG.standard.framesPerMinute).toBeGreaterThan(
        DENSITY_PRESET_CONFIG.sparse.framesPerMinute
      );
      // 稀疏→标准→高密度：minFrameInterval 严格减小
      expect(DENSITY_PRESET_CONFIG.dense.minFrameInterval).toBeLessThan(
        DENSITY_PRESET_CONFIG.standard.minFrameInterval
      );
      expect(DENSITY_PRESET_CONFIG.standard.minFrameInterval).toBeLessThan(
        DENSITY_PRESET_CONFIG.sparse.minFrameInterval
      );
    });

    it('典型时长估算：2 小时电影 × standard 档 → ≈ 2400 张封顶，解决"2000+ 爆 Token"问题', () => {
      const minutes = 120;
      const { framesPerMinute } = DENSITY_PRESET_CONFIG.standard;
      const maxFrames = Math.ceil(minutes * framesPerMinute * 1.1); // +10% 容差
      expect(framesPerMinute).toBe(20);
      expect(maxFrames).toBe(2640);
    });
  });

  describe('FramesConfig 新契约类型（向后兼容历史 4 枚举字符串）', () => {
    it('新枚举 AUTO_ADAPTIVE / UNIFORM_FPS + frameDensityPreset 合法赋值', () => {
      const config: FramesConfig = {
        enabled: true,
        mode: 'AUTO_ADAPTIVE',
        frameDensityPreset: 'standard',
        sceneThreshold: 0.28,
        quality: 3,
        scale: 1024,
        fps: 2,
      };
      expect(config.mode).toBe('AUTO_ADAPTIVE');
      expect(config.frameDensityPreset).toBe('standard');
    });

    it('历史 4 枚举字符串也能通过 FramesConfig.mode（string 兼容）', () => {
      const legacyModes: FramesConfig['mode'][] = [
        'VLM_OPTIMIZED',
        'UNIFORM_FPS',
        'FAST_KEYFRAME',
        'PRECISE_SINGLE',
      ];
      // 不抛类型错误即可 → 保证老 JSON 反序列化不崩溃
      expect(legacyModes).toHaveLength(4);
    });
  });
});

