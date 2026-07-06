// Module: pipeline/step5-match - MatchService 单元测试

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MatchService } from '../backend/Service';
import type { MatchPipelineInput, PipelineAPI } from '../backend/Service';
import { AppError, ErrorCode } from '../../../../infra/error/AppError';

// ---------- helpers ----------

function makeInput(overrides: Partial<MatchPipelineInput> = {}): MatchPipelineInput {
  return {
    projectId: 'proj-001',
    sourceMediaPath: '/media/video.mp4',
    scriptParagraphs: [
      { id: 's1', text: '开场白', editing: false },
      { id: 's2', text: '核心内容', editing: false },
    ],
    vlmFrames: [
      { url: '/f1.jpg', description: '山川风景', editing: false, confirmed: true },
    ],
    ttsResults: [{ shotId: 's1', audioUrl: '/audio/1.wav' }],
    activeBgm: { id: 'bgm-1', filePath: '/bgm/epic.mp3' },
    ...overrides,
  };
}

function makeMockAPI(
  behavior: 'success' | 'empty' | 'throw' | 'custom',
  customResult?: unknown,
): PipelineAPI {
  return {
    runPipeline: vi.fn().mockImplementation(async () => {
      if (behavior === 'throw') throw new Error('网络不可达');
      if (behavior === 'empty') return undefined;
      if (behavior === 'custom') return customResult as any;
      return {
        data: {
          matchResults: [
            { shotId: 's1', mediaId: 'chunk1', score: 0.95, confirmed: false },
            { shotId: 's2', mediaId: 'chunk2', score: 0.72, confirmed: false },
          ],
        },
      };
    }),
  };
}

// ---------- tests ----------

describe('MatchService', () => {
  let service: MatchService;

  describe('rematch', () => {
    it('正常流程应返回匹配结果', async () => {
      const api = makeMockAPI('success');
      service = new MatchService(api);

      const result = await service.rematch(makeInput());

      expect(result.matchResults).toHaveLength(2);
      expect(result.matchResults[0].shotId).toBe('s1');
      expect(result.matchResults[0].score).toBe(0.95);
      expect(result.matchResults[1].shotId).toBe('s2');
      expect(api.runPipeline).toHaveBeenCalledTimes(1);
    });

    it('API 抛出异常应包装为 AppError AI_PROCESS_FAILED', async () => {
      const api = makeMockAPI('throw');
      service = new MatchService(api);

      await expect(
        service.rematch(makeInput()),
      ).rejects.toMatchObject({ code: ErrorCode.AI_PROCESS_FAILED });
    });

    it('API 返回 undefined 应返回空 matchResults', async () => {
      const api = makeMockAPI('empty');
      service = new MatchService(api);

      const result = await service.rematch(makeInput());
      expect(result.matchResults).toHaveLength(0);
    });

    it('projectId 为空应抛出 SYS_INVALID_INPUT', async () => {
      service = new MatchService(makeMockAPI('success'));

      await expect(
        service.rematch(makeInput({ projectId: '' })),
      ).rejects.toMatchObject({ code: ErrorCode.SYS_INVALID_INPUT });
    });

    it('sourceMediaPath 为空应抛出 SYS_INVALID_INPUT', async () => {
      service = new MatchService(makeMockAPI('success'));

      await expect(
        service.rematch(makeInput({ sourceMediaPath: '' })),
      ).rejects.toMatchObject({ code: ErrorCode.SYS_INVALID_INPUT });
    });

    it('activeBgm 为 null 应正常执行', async () => {
      const api = makeMockAPI('success');
      service = new MatchService(api);

      const result = await service.rematch(
        makeInput({ activeBgm: null }),
      );

      expect(result.matchResults).toHaveLength(2);
      // 验证序列中 bgmInfo 为 null
      const callArgs = (api.runPipeline as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.sequence[0].params.bgmInfo).toBeNull();
    });

    it('空 scriptParagraphs 应正常执行', async () => {
      const api = makeMockAPI('success');
      service = new MatchService(api);

      const result = await service.rematch(
        makeInput({ scriptParagraphs: [] }),
      );

      expect(result.matchResults).toHaveLength(2);
    });

    it('自定义错误消息应保留在 AppError 中', async () => {
      const api: PipelineAPI = {
        runPipeline: vi.fn().mockRejectedValue(new Error('服务端超时')),
      };
      service = new MatchService(api);

      await expect(
        service.rematch(makeInput()),
      ).rejects.toMatchObject({
        code: ErrorCode.AI_PROCESS_FAILED,
        message: '服务端超时',
      });
    });
  });

  describe('buildSequence', () => {
    it('应构建包含 shot_match 节点的序列', () => {
      service = new MatchService();
      const input = makeInput({ activeBgm: null });

      const seq = service.buildSequence(input);

      expect(seq).toHaveLength(1);
      expect(seq[0].id).toBe('shot_match');
      expect(seq[0].type).toBe('shot_match');
    });

    it('params 应包含 scriptShots 和 ttsDurations', () => {
      service = new MatchService();
      const input = makeInput();

      const seq = service.buildSequence(input);
      const params = seq[0].params!;

      expect(params.scriptShots).toEqual(input.scriptParagraphs);
      expect(params.ttsDurations).toEqual(input.ttsResults);
    });

    it('visionResult.sceneDescriptions 应从 vlmFrames 拼装', () => {
      service = new MatchService();
      const input = makeInput({
        vlmFrames: [
          { url: '/a.jpg', description: '城市', editing: false, confirmed: true },
          { url: '/b.jpg', description: '乡村', editing: false, confirmed: true },
        ],
      });

      const seq = service.buildSequence(input);
      const desc = (seq[0].params! as any).visionResult.sceneDescriptions;
      expect(desc).toContain('城市');
      expect(desc).toContain('乡村');
    });

    it('空 vlmFrames 应产生空 sceneDescriptions', () => {
      service = new MatchService();
      const input = makeInput({ vlmFrames: [] });

      const seq = service.buildSequence(input);
      const desc = (seq[0].params! as any).visionResult.sceneDescriptions;
      expect(desc).toBe('');
    });

    it('有 BGM 时 bgmInfo 应包含 id 和 filePath', () => {
      service = new MatchService();
      const input = makeInput({
        activeBgm: { id: 'custom-bgm', filePath: '/custom.mp3' },
      });

      const seq = service.buildSequence(input);
      const bgmInfo = (seq[0].params! as any).bgmInfo;
      expect(bgmInfo).toEqual({ id: 'custom-bgm', filePath: '/custom.mp3' });
    });

    it('无 BGM 时 bgmInfo 应为 null', () => {
      service = new MatchService();
      const input = makeInput({ activeBgm: null });

      const seq = service.buildSequence(input);
      expect((seq[0].params! as any).bgmInfo).toBeNull();
    });
  });

  describe('构造函数', () => {
    it('未传入 API 应使用默认空实现', () => {
      service = new MatchService();
      // 默认 api 存在但不做任何事
      expect(service).toBeDefined();
    });
  });
});
