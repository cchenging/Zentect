// Module: pipeline/step5-match - Match Service
// 封装镜头匹配管线编排逻辑：构建序列 → 调用 AI 管线 → 结果映射

import { AppError, ErrorCode } from '../../../../infra/error/AppError';
import type { MatchResult, ScriptParagraph, VlmFrame, TtsResult, BgmInfo } from '../types';

/** 匹配管线输入参数 */
export interface MatchPipelineInput {
  projectId: string;
  sourceMediaPath: string;
  scriptParagraphs: ScriptParagraph[];
  vlmFrames: VlmFrame[];
  ttsResults: TtsResult[];
  activeBgm: BgmInfo | null;
}

/** 匹配管线输出 */
export interface MatchPipelineOutput {
  matchResults: MatchResult[];
}

/** 管线节点定义（与 pipelineConstants 中 STEP_SEQUENCES[5] 对齐） */
interface PipelineNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}

/** 外部 API 接口签名（与 renderer API 对齐） */
export interface PipelineAPI {
  runPipeline(input: {
    projectId: string;
    sequence: PipelineNode[];
    sourceMedia: string;
  }): Promise<{ data?: { matchResults?: MatchResult[] } } | undefined>;
}

/**
 * MatchService — 镜头匹配管线编排
 *
 * 职责：
 * 1. 构建 step5 管线节点序列
 * 2. 调用 AI 管线引擎执行匹配
 * 3. 提取并返回 MatchResult[]
 */
export class MatchService {
  private api: PipelineAPI;

  constructor(api?: PipelineAPI) {
    this.api = api ?? { runPipeline: async () => undefined };
  }

  /**
   * 执行重新匹配
   * @param input 匹配管线输入参数
   * @returns 匹配结果列表
   */
  async rematch(input: MatchPipelineInput): Promise<MatchPipelineOutput> {
    this.validateInput(input);

    const sequence = this.buildSequence(input);

    try {
      const result = await this.api.runPipeline({
        projectId: input.projectId,
        sequence,
        sourceMedia: input.sourceMediaPath,
      });

      const matchResults = this.extractMatchResults(result);
      return { matchResults };
    } catch (err: any) {
      throw new AppError(
        ErrorCode.AI_PROCESS_FAILED,
        err?.message || '镜头匹配管线执行失败',
      );
    }
  }

  /** 构建 step5 管线节点序列 */
  buildSequence(input: MatchPipelineInput): PipelineNode[] {
    const visionDescription = input.vlmFrames
      .map((f) => f.description || '')
      .filter(Boolean)
      .join('\n');

    return [
      {
        id: 'shot_match',
        type: 'shot_match',
        params: {
          mediaPath: input.sourceMediaPath,
          scriptShots: input.scriptParagraphs,
          ttsDurations: input.ttsResults,
          visionResult: {
            sceneDescriptions: visionDescription,
          },
          bgmInfo: input.activeBgm
            ? { id: input.activeBgm.id, filePath: input.activeBgm.filePath }
            : null,
        },
      },
    ];
  }

  /** 输入校验 */
  private validateInput(input: MatchPipelineInput): void {
    if (!input.projectId) {
      throw new AppError(ErrorCode.SYS_INVALID_INPUT, 'projectId 不能为空');
    }
    if (!input.sourceMediaPath) {
      throw new AppError(ErrorCode.SYS_INVALID_INPUT, 'sourceMediaPath 不能为空');
    }
  }

  /** 从管线结果中提取 matchResults */
  private extractMatchResults(
    result: { data?: { matchResults?: MatchResult[] } } | undefined,
  ): MatchResult[] {
    if (!result) return [];
    if (result.data?.matchResults) return result.data.matchResults;
    // 兼容 result 直接就是 data 的情况
    const data = result as unknown as Record<string, unknown>;
    if (Array.isArray(data.matchResults)) return data.matchResults as MatchResult[];
    return [];
  }
}
