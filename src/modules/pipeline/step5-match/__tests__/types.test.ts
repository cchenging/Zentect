// Module: pipeline/step5-match - Types 单元测试

import { describe, it, expect } from 'vitest';
import type {
  BgmInfo,
  Step5Input,
  Step5Output,
  StepShotMatchingProps,
  MatchResult,
} from '../types';

describe('Step5 Types', () => {
  describe('BgmInfo', () => {
    it('应包含 id 和 filePath 两个必填字段', () => {
      const bgm: BgmInfo = {
        id: 'bgm-001',
        filePath: '/music/epic.mp3',
      };
      expect(bgm.id).toBe('bgm-001');
      expect(bgm.filePath).toBe('/music/epic.mp3');
    });

    it('空字符串 id 和 filePath 应为合法值', () => {
      const bgm: BgmInfo = { id: '', filePath: '' };
      expect(bgm.id).toBe('');
      expect(bgm.filePath).toBe('');
    });
  });

  describe('Step5Input', () => {
    it('合法输入应包含所有必填字段', () => {
      const input: Step5Input = {
        scriptParagraphs: [{ id: 's1', text: '你好世界', editing: false }],
        vlmFrames: [{ url: '/frame1.jpg', description: '城市夜景', editing: false, confirmed: true }],
        ttsResults: [{ shotId: 's1', audioUrl: '/audio/1.mp3' }],
        activeBgm: { id: 'bgm-1', filePath: '/bgm/epic.mp3' },
      };
      expect(input.scriptParagraphs).toHaveLength(1);
      expect(input.vlmFrames).toHaveLength(1);
      expect(input.ttsResults).toHaveLength(1);
      expect(input.activeBgm).not.toBeNull();
    });

    it('activeBgm 为 null 应为合法输入（无 BGM 场景）', () => {
      const input: Step5Input = {
        scriptParagraphs: [],
        vlmFrames: [],
        ttsResults: [],
        activeBgm: null,
      };
      expect(input.activeBgm).toBeNull();
    });

    it('空数组应为合法输入', () => {
      const input: Step5Input = {
        scriptParagraphs: [],
        vlmFrames: [],
        ttsResults: [],
        activeBgm: null,
      };
      expect(input.scriptParagraphs).toHaveLength(0);
      expect(input.vlmFrames).toHaveLength(0);
      expect(input.ttsResults).toHaveLength(0);
    });

    it('多个 scriptParagraphs 应被接受', () => {
      const paragraphs = [
        { id: 's1', text: '第一句', editing: false },
        { id: 's2', text: '第二句', editing: false },
        { id: 's3', text: '第三句', editing: true },
      ];
      const input: Step5Input = {
        scriptParagraphs: paragraphs,
        vlmFrames: [],
        ttsResults: [],
        activeBgm: null,
      };
      expect(input.scriptParagraphs).toHaveLength(3);
    });

    it('TTS 失败结果（_failed=true）应被接受', () => {
      const input: Step5Input = {
        scriptParagraphs: [{ id: 's1', text: '测试', editing: false }],
        vlmFrames: [],
        ttsResults: [{ shotId: 's1', _failed: true, _error: 'TTS 合成失败' }],
        activeBgm: null,
      };
      expect(input.ttsResults[0]._failed).toBe(true);
    });
  });

  describe('Step5Output', () => {
    it('应包含 matchResults 数组', () => {
      const output: Step5Output = {
        matchResults: [
          { shotId: 'shot1', mediaId: 'chunk1', score: 0.95, confirmed: true },
        ],
      };
      expect(output.matchResults).toHaveLength(1);
      expect(output.matchResults[0].score).toBe(0.95);
    });

    it('空 matchResults 应为合法输出', () => {
      const output: Step5Output = { matchResults: [] };
      expect(output.matchResults).toHaveLength(0);
    });
  });

  describe('MatchResult', () => {
    it('已确认的匹配结果应含所有核心字段', () => {
      const res: MatchResult = {
        shotId: 'shot_001',
        mediaId: 'media_chunk_abc',
        thumbnail: '/thumbs/shot_001.jpg',
        score: 0.92,
        confirmed: true,
        appliedSpeedFactor: 1.0,
        audioDurationMs: 3200,
        chunkData: { startMs: 0, endMs: 5000 },
      };
      expect(res.shotId).toBe('shot_001');
      expect(res.mediaId).toBe('media_chunk_abc');
      expect(res.score).toBe(0.92);
      expect(res.confirmed).toBe(true);
      expect(res.appliedSpeedFactor).toBe(1.0);
      expect(res.audioDurationMs).toBe(3200);
      expect(res.chunkData).toBeDefined();
    });

    it('score 边界值 0 应为合法值', () => {
      const res: MatchResult = { shotId: 's', mediaId: 'm', score: 0, confirmed: false };
      expect(res.score).toBe(0);
    });

    it('score 边界值 1.0 应为合法值', () => {
      const res: MatchResult = { shotId: 's', mediaId: 'm', score: 1.0, confirmed: false };
      expect(res.score).toBe(1.0);
    });

    it('未确认状态 confirmed=false 应为合法值', () => {
      const res: MatchResult = { shotId: 's', mediaId: 'm', score: 0.75, confirmed: false };
      expect(res.confirmed).toBe(false);
    });

    it('缺少可选字段（thumbnail/chunkData 等）应被类型接受', () => {
      const res: MatchResult = { shotId: 's1', mediaId: 'm1', score: 0.5, confirmed: false };
      expect(res.thumbnail).toBeUndefined();
      expect(res.appliedSpeedFactor).toBeUndefined();
      expect(res.audioDurationMs).toBeUndefined();
      expect(res.chunkData).toBeUndefined();
    });

    it('appliedSpeedFactor 应为可选字段', () => {
      const withSpeed: MatchResult = {
        shotId: 's1', mediaId: 'm1', score: 0.8, confirmed: false,
        appliedSpeedFactor: 1.5,
      };
      expect(withSpeed.appliedSpeedFactor).toBe(1.5);

      const withoutSpeed: MatchResult = {
        shotId: 's2', mediaId: 'm2', score: 0.7, confirmed: false,
      };
      expect(withoutSpeed.appliedSpeedFactor).toBeUndefined();
    });
  });

  describe('StepShotMatchingProps', () => {
    it('应包含所有 View Props 字段', () => {
      const props: StepShotMatchingProps = {
        matchResults: [],
        videoChunks: [],
        mediaItems: [],
        hasBgm: false,
        isProcessing: false,
        onConfirm: (shotId: string) => {},
        onReplace: (shotId: string, chunkItem: any) => {},
        onRematch: () => {},
        onReorder: (reordered: MatchResult[]) => {},
      };
      expect(props.matchResults).toHaveLength(0);
      expect(props.hasBgm).toBe(false);
      expect(props.isProcessing).toBe(false);
      expect(typeof props.onConfirm).toBe('function');
      expect(typeof props.onReplace).toBe('function');
      expect(typeof props.onRematch).toBe('function');
      expect(typeof props.onReorder).toBe('function');
    });

    it('isProcessing=true 时应可传递', () => {
      const props: StepShotMatchingProps = {
        matchResults: [{ shotId: 's1', mediaId: 'm1', score: 0.9, confirmed: false }],
        videoChunks: [],
        mediaItems: [],
        hasBgm: true,
        isProcessing: true,
        onConfirm: () => {},
        onReplace: () => {},
        onRematch: () => {},
        onReorder: () => {},
      };
      expect(props.isProcessing).toBe(true);
      expect(props.hasBgm).toBe(true);
      expect(props.matchResults).toHaveLength(1);
    });

    it('onConfirm 应接收 shotId 字符串参数', () => {
      let capturedShotId = '';
      const props: StepShotMatchingProps = {
        matchResults: [],
        videoChunks: [],
        mediaItems: [],
        hasBgm: false,
        isProcessing: false,
        onConfirm: (shotId) => { capturedShotId = shotId; },
        onReplace: () => {},
        onRematch: () => {},
        onReorder: () => {},
      };
      props.onConfirm('test-shot-id');
      expect(capturedShotId).toBe('test-shot-id');
    });

    it('onReorder 应接收 MatchResult 数组', () => {
      let captured: MatchResult[] = [];
      const reordered: MatchResult[] = [
        { shotId: 's2', mediaId: 'm2', score: 0.9, confirmed: false },
        { shotId: 's1', mediaId: 'm1', score: 0.8, confirmed: true },
      ];
      const props: StepShotMatchingProps = {
        matchResults: [],
        videoChunks: [],
        mediaItems: [],
        hasBgm: false,
        isProcessing: false,
        onConfirm: () => {},
        onReplace: () => {},
        onRematch: () => {},
        onReorder: (r) => { captured = r; },
      };
      props.onReorder(reordered);
      expect(captured).toHaveLength(2);
      expect(captured[0].shotId).toBe('s2');
    });
  });
});
