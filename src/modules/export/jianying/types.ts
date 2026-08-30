// 📁 路径：src/modules/export/jianying/types.ts
// 接口契约：剪映草稿工程导出模块（§3.6.1）

import type { Shot } from '../../../shared/types';

/** 剪映导出输入参数 */
export interface JianyingExportInput {
  /** 项目 ID */
  projectId: string;
  /** 项目名称（用于草稿命名，加 Z_ 前缀区分其他草稿） */
  projectName?: string;
  /** 最终镜头数据（DB shots 表完整数据，导出主数据源，含用户编辑后的文案/时间/配音路径） */
  shots: Array<Partial<Shot>>;
  /** 镜头匹配结果（按 id 补充视频切片 chunkData / 变速 / 起止时间） */
  matchResults: Array<{
    /** 身份键统一：id 为段落唯一主键，消费端一律读 id */
    id?: string;
    shotId: string;
    mediaId: string;
    thumbnail?: string;
    score: number;
    confirmed: boolean;
    appliedSpeedFactor?: number;
    audioDurationMs?: number;
    chunkData?: Record<string, unknown>;
    /** 原声段落标记：true=保留原片原声，不配 TTS 配音 */
    keepOriginalAudio?: boolean;
  }>;
  /** TTS 合成结果（配音音频路径） */
  ttsResults: Array<{
    /** 身份键统一：id 为段落唯一主键，消费端一律读 id */
    id?: string;
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
    /** 原声段落标记：true=该段保留原片原声，不配 TTS 配音 */
    keepOriginalAudio?: boolean;
    editing: boolean;
  }>;
  /** 背景音乐路径（可选） */
  bgmPath?: string;
  /** 原视频绝对路径（clipls 剪辑用，chunkData 缺失时按此源切片） */
  mediaPath?: string;
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
 * 剪映字幕样式（外部配置，存于 settings 数据库 subtitleStyle 键）
 * 由 ExportService 读取后传入，JianyingExportService 保持纯净可测
 */
export interface SubtitleStyle {
  /** 字体颜色（RGB 0~1，如 [1,1,1] 白色） */
  color: [number, number, number];
  /** 字号（剪映 text 样式 size 字段） */
  fontSize: number;
  /** 描边颜色（RGB 0~1，如 [0,0,0] 黑色） */
  strokeColor: [number, number, number];
  /** 描边宽度（0~1，0 表示不加描边） */
  strokeWidth: number;
  /** 对齐方式：0 左对齐 / 1 居中 / 2 右对齐 */
  alignment: number;
  /** 字间距 */
  letterSpacing: number;
  /** 行间距 */
  lineSpacing: number;
  /** 最大行宽（0~1，相对画布宽度占比） */
  lineMaxWidth: number;
  /**
   * 字幕垂直偏移（相对画布高度的比值，正数向下、负数向上）
   * 用于将字幕定位到屏幕指定高度，如底部居中（正数，如 0.3）
   */
  verticalOffset: number;
  /**
   * 竖屏专用的字幕垂直偏移（相对画布高度的比值）。
   * 竖屏画布更高，同一 verticalOffset 在竖屏下会抬得比横屏更高，
   * 故竖屏需单独取值（通常更小），横屏仍用 verticalOffset。
   * 缺省时由装配层按横屏值等比换算，保证距底部视觉一致。
   */
  verticalOffsetPortrait?: number;
  /**
   * 横屏专用的字幕字号（可选项）。
   * 竖屏按当前逻辑自动放大（窄画布补足占比）；横屏无线条补足，若默认 3.5 偏小，
   * 可在此单独放大而不影响竖屏。缺省时横屏用 fontSize。
   */
  fontSizeLandscape?: number;
}

/** 字幕样式默认值（按用户参数表：字号 3.5、描边 0.02、底部居中） */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  color: [1, 1, 1],
  fontSize: 3.5,
  strokeColor: [0, 0, 0],
  strokeWidth: 0.02,
  alignment: 1,
  letterSpacing: 0,
  lineSpacing: 0.02,
  lineMaxWidth: 0.82,
  verticalOffset: 0.3,
  // 横屏 1920 宽不触发竖屏窄画布放大逻辑，默认字号 3.5 会偏小，
  // 单独设横屏字号放大到接近竖屏可读性；不影响竖屏（竖屏走 fontSize）。
  fontSizeLandscape: 5.0,
};

/**
 * 编译镜头（buildCompileShots 的产出，供剪映素材/轨道装配消费）。
 * 在 DB Shot 基础上补充视频切片 / 变速 / 时间线范围等导出专属字段。
 */
export interface CompileShot extends Shot {
  /** 视频切片数据（matchResults 按 id 关联，含毫秒级 startMs/endMs/filePath） */
  chunkData?: Record<string, unknown> | null;
  /** 变速因子（1.0=正常，<1.0=慢放，>1.0=快进） */
  appliedSpeedFactor?: number;
  /** 视频时间线起始毫秒（原视频坐标） */
  videoTimelineStartMs?: number;
  /** 视频时间线结束毫秒（原视频坐标） */
  videoTimelineEndMs?: number;
  /** 是否保留原片原声（true=原声段，不配 TTS 配音，剪映导出时视频段音量开足） */
  keepOriginalAudio?: boolean;
  /**
   * 🎬 阶段 A：所属物理镜头父 ID（enrichMatchRelations 解析 chunkData.parentChunkId）。
   * 同一物理镜头内被细分/拆分出的连续子段共享同一 parentChunkId。
   */
  parentChunkId?: string;
  /** 🎬 阶段 A：与前一段的时间线关系（FIRST / SCENE_SWITCH / SAME_SCENE_CONTINUOUS） */
  prevRelation?: 'FIRST' | 'SCENE_SWITCH' | 'SAME_SCENE_CONTINUOUS';
  /** 🎬 阶段 A：同物理镜头连续兄弟段的合并组 id（命中 SAME_SCENE_CONTINUOUS 且形成组时设置），
   *  装配层据此把组内兄弟段合并为单个视频 clip（消除假转场与物理接缝） */
  sceneGroupId?: string;
}
