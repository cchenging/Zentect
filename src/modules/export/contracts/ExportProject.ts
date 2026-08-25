// 📁 路径：src/modules/export/contracts/ExportProject.ts
// 契约层：装配好的中间数据模型（所有出口共同消费），避免数据源读取分散

/** 编译后的镜头（中间模型，供各出口消费） */
export interface ExportShot {
  /** 镜头/段落唯一 ID */
  id: string;
  /** 关联的素材 ID（可选） */
  mediaId?: string;
  /** 原始文案 */
  text?: string;
  /** AI 修正文案（字幕优先取此） */
  aiText?: string;
  /** 起始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
  /** 时长（秒） */
  duration: number;
  /** 该段配音音频路径（TTS，已脱水） */
  audioPath?: string;
  /** 视频切片数据（含毫秒级 startMs/endMs/filePath；body 切片内坐标，配 filePath 切片素材消费） */
  chunkData?: Record<string, unknown>;
  /** 源视频坐标起始（毫秒，OP/ED 裁剪体系 P1-4 回写；对源视频 mediaPath 定位唯一正确） */
  videoTimelineStartMs?: number;
  /** 源视频坐标结束（毫秒） */
  videoTimelineEndMs?: number;
  /** 变速因子（1.0=正常） */
  appliedSpeedFactor?: number;
  /** 是否保留原片原声（true=原声段，不配 TTS 配音，剪映导出时视频段音量开足） */
  keepOriginalAudio?: boolean;
  /**
   * 🎬 阶段 A：所属物理镜头父 ID（由 enrichMatchRelations 解析 chunkData.parentChunkId）。
   * 同一物理镜头内被细分/拆分出的连续子段共享同一 parentChunkId。
   */
  parentChunkId?: string;
  /** 🎬 阶段 A：与前一段的时间线关系（FIRST / SCENE_SWITCH / SAME_SCENE_CONTINUOUS） */
  prevRelation?: 'FIRST' | 'SCENE_SWITCH' | 'SAME_SCENE_CONTINUOUS';
  /** 🎬 阶段 A：同物理镜头连续兄弟段的合并组 id（命中 SAME_SCENE_CONTINUOUS 且形成组时设置），
   *  导出层据此把组内兄弟段合并为单个 clip/截取段，消除假转场与物理接缝 */
  sceneGroupId?: string;
}

/**
 * 装配好的中间数据模型：所有出口（剪映/成片/字幕）消费同一结构，
 * 由 ExportAssembler 统一产出，避免每个出口各自读取分散的数据源。
 */
export interface ExportProject {
  /** 项目 ID */
  projectId: string;
  /** 项目名称 */
  projectName: string;
  /** 源视频干净的文件系统路径（已脱水 magic://） */
  mediaPath?: string;
  /** 背景音乐路径（可选） */
  bgmPath?: string;
  /** 编译镜头（含切片/变速/配音/字幕） */
  shots: ExportShot[];
  /** 字幕样式（各出口按需消费） */
  subtitleStyle?: Record<string, unknown>;
  /** 画幅比例（16:9 / 9:16） */
  ratio?: string;
  /** 分辨率档（4k / 2k / 1080p / 720p） */
  resolution?: string;
  /** 帧率（30 / 60） */
  fps?: number;
  /** 是否预览模式（低码率快速导出） */
  preview?: boolean;
}