// 📁 路径：src/modules/export/jianying/types.ts
// 接口契约：剪映草稿工程导出模块（§3.6.1）

import type { Shot } from '../../../shared/types';

/** 剪映导出输入参数 */
export interface JianyingExportInput {
  /** 项目 ID */
  projectId: string;
  /** 镜头匹配结果 */
  matchResults: Array<{
    shotId: string;
    mediaId: string;
    thumbnail?: string;
    score: number;
    confirmed: boolean;
    appliedSpeedFactor?: number;
    audioDurationMs?: number;
    chunkData?: Record<string, unknown>;
  }>;
  /** TTS 合成结果（配音音频路径） */
  ttsResults: Array<{
    shotId: string;
    audioUrl?: string;
    _failed?: boolean;
    _error?: string;
  }>;
  /** 解说文案段落 */
  scriptParagraphs: Array<{
    id: string;
    shotId?: string;
    text: string;
    duration?: number;
    emotion?: string;
    editing: boolean;
  }>;
  /** 背景音乐路径（可选） */
  bgmPath?: string;
  /** 输出目录 */
  outputDir: string;
}

/** 剪映导出输出 */
export interface JianyingExportOutput {
  /** 导出的草稿文件夹路径 */
  filePath: string;
  /** 草稿名称 */
  fileName: string;
}

/**
 * 镜头数据（编译用，兼容旧 Shot 接口）
 * @deprecated 逐步迁移至 MatchResultItem
 */
export type CompileShot = Shot;
