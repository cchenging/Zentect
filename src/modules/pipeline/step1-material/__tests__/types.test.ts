// Module: pipeline/step1-material - Types 单元测试

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

describe('Step1 Types', () => {
  describe('Step1Input', () => {
    it('合法输入应包含 projectId / mediaPath / config', () => {
      const input: Step1Input = {
        projectId: 'proj_001',
        mediaPath: 'C:/media/video.mp4',
        config: {
          targetLanguage: 'zh-CN',
          frames: { enabled: true, mode: 'VLM_OPTIMIZED', sceneThreshold: 0.28, quality: 3, scale: 1024, fps: 2 },
          audio: { enabled: true, engine: 'mdx-net' },
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
        audio: { enabled: false, engine: 'spleeter' },
        whisper: { enabled: false, engine: 'whisper-v3', language: 'en' },
        faces: { enabled: false, engine: 'mediapipe' },
      };
      expect(config.frames.enabled).toBe(false);
      expect(config.audio.engine).toBe('spleeter');
      expect(config.whisper.engine).toBe('whisper-v3');
      expect(config.faces.engine).toBe('mediapipe');
    });
  });

  describe('Step1Output', () => {
    it('应包含所有输出字段', () => {
      const output: Step1Output = {
        asrLines: [{ id: '1', text: '你好', start: 0, end: 1.5 }],
        framePaths: ['/frames/f1.jpg', '/frames/f2.jpg'],
        frameCount: 2,
        audioSeparated: true,
        roles: [{ id: 'r1', name: '角色A', facePath: '/faces/r1.jpg' }],
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
    it('应支持 mdx-net 和 spleeter 引擎', () => {
      const engines: AudioConfig['engine'][] = ['mdx-net', 'spleeter'];
      expect(engines).toHaveLength(2);
    });
  });

  describe('WhisperConfig', () => {
    it('应支持 sensevoice 和 whisper-v3 引擎', () => {
      const engines: WhisperConfig['engine'][] = ['sensevoice', 'whisper-v3'];
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
        subStepStatuses: {},
        subStepProgresses: {},
        extractionConfig: {
          targetLanguage: 'zh-CN',
          frames: { enabled: true, mode: 'VLM_OPTIMIZED', sceneThreshold: 0.28, quality: 3, scale: 1024, fps: 2 },
          audio: { enabled: true, engine: 'mdx-net' },
          whisper: { enabled: true, engine: 'sensevoice' },
          faces: { enabled: true, engine: 'insightface' },
        },
      };
      expect(state.asrLines).toHaveLength(0);
      expect(state.frameCount).toBe(0);
      expect(state.subStepStatuses).toEqual({});
    });

    it('进度应反映子步骤完成状态', () => {
      const state: Step1State = {
        asrLines: [{ id: '1', text: '测试', start: 0, end: 1 }],
        frameCount: 10,
        audioSeparated: true,
        roles: [{ id: 'r1', name: '角色', facePath: '/f.jpg' }],
        subStepStatuses: { frames: 'completed', asr: 'completed' },
        subStepProgresses: { frames: 100, asr: 100 },
        extractionConfig: {
          targetLanguage: 'zh-CN',
          frames: { enabled: true, mode: 'UNIFORM_FPS', sceneThreshold: 0.3, quality: 3, scale: 1024, fps: 2 },
          audio: { enabled: true, engine: 'mdx-net' },
          whisper: { enabled: true, engine: 'whisper-v3' },
          faces: { enabled: true, engine: 'insightface' },
        },
      };
      expect(state.subStepStatuses.frames).toBe('completed');
      expect(state.subStepProgresses.frames).toBe(100);
    });
  });

  describe('StepMaterialAnalysisViewProps', () => {
    it('应包含所有回调函数', () => {
      const props: StepMaterialAnalysisViewProps = {
        asrLines: [],
        frameCount: 0,
        audioSeparated: false,
        mediaItems: [],
        roles: [],
        subStepStatuses: {},
        subStepProgresses: {},
        extractionConfig: null,
        extractedData: null,
        onUpdateAsrLine: () => {},
        onSetAsrLines: () => {},
        onSetCurrentTime: () => {},
        onSetActivePlaySource: () => {},
        onUpdateRole: () => {},
        onSetSubStepStatus: () => {},
        onRetrySubStep: () => {},
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
        mediaItems: [],
        roles: [],
        subStepStatuses: {},
        subStepProgresses: {},
        extractionConfig: {
          targetLanguage: 'zh-CN',
          frames: { enabled: true, mode: 'VLM_OPTIMIZED', sceneThreshold: 0.28, quality: 3, scale: 1024, fps: 2 },
          audio: { enabled: true, engine: 'mdx-net' },
          whisper: { enabled: true, engine: 'sensevoice' },
          faces: { enabled: true, engine: 'insightface' },
        },
        extractedData: {
          videoPath: '/media/v.mp4',
          vocalPath: '/audio/vocals.wav',
          backgroundPath: '/audio/bgm.wav',
          asrLines: [{ id: '1', text: '测试', start: 0, end: 1 }],
          frameCount: 5,
          framePaths: ['/frames/1.jpg'],
        },
        onUpdateAsrLine: () => {},
        onSetAsrLines: () => {},
        onSetCurrentTime: () => {},
        onSetActivePlaySource: () => {},
        onUpdateRole: () => {},
        onSetSubStepStatus: () => {},
        onRetrySubStep: () => {},
        onUpdateExtractionConfig: () => {},
      };
      expect(props.extractedData!.videoPath).toBe('/media/v.mp4');
      expect(props.extractedData!.vocalPath).toBe('/audio/vocals.wav');
      expect(props.extractedData!.frameCount).toBe(5);
    });
  });
});
