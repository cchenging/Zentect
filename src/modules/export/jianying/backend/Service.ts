// 📁 路径：src/modules/export/jianying/backend/Service.ts
// 剪映草稿编译服务：将时间线编译为剪映 Project JSON（§3.6.1）
//
// 职责：保持公共静态 API（buildCompileShots / compileDraft / export）不变，
// 具体实现委托给 core 子模块（resolvers / assemblers / writers / JianyingExporter）。
// 设计原则：编排器只做数据转换与委托，不实现格式细节，便于维护与扩展。

import type { CompileShot } from '../types';
import type { JianyingExportInput, JianyingExportOutput, SubtitleStyle } from '../types';
import { DEFAULT_SUBTITLE_STYLE } from '../types';
import { assembleDraftContent } from './core/assemblers/DraftContentAssembler';
import { exportJianying } from './core/JianyingExporter';

// ──────────────────────────────────────────────
// 服务实现
// ──────────────────────────────────────────────

export class JianyingExportService {
  /**
   * 组装编译镜头：以 scriptParagraphs 为主数据源，matchResults/ttsResults 按 shotId 补充切片与配音
   *
   * @param input 剪映导出输入
   * @returns CompileShot 数组（与 scriptParagraphs 一一对应）
   */
  static buildCompileShots(input: JianyingExportInput): CompileShot[] {
    const matchByShotId = new Map<string, any>(
      (input.matchResults || []).map((m) => [m.shotId, m]),
    );
    const ttsByShotId = new Map<string, any>(
      (input.ttsResults || []).map((t) => [t.shotId, t]),
    );

    return (input.scriptParagraphs || []).map((p) => {
      // 子句被 breakLongParagraphs 切分后 id 唯一、shotId 共享父级，配音需按唯一 id 匹配
      const m = matchByShotId.get(p.shotId || p.id);
      const t = ttsByShotId.get(p.id || p.shotId || '');
      // 时长优先取 TTS 真实时长，其次段落 duration，最后兜底 3s
      const durationSec = (t?.duration && !t._failed ? t.duration : 0) || p.duration || 3;
      return {
        id: p.id,
        mediaId: m?.mediaId || '',
        imagePath: m?.thumbnail || '',
        text: p.text || '',
        originalText: p.text || '',
        aiText: p.text || m?.text || '',
        start: m?.chunkData ? Math.round(m.chunkData.startMs) / 1000 : 0,
        end: m?.chunkData ? Math.round(m.chunkData.endMs) / 1000 : durationSec,
        duration: durationSec,
        audioDuration: durationSec,
        audioPath: t?.audioUrl && !t._failed ? t.audioUrl : undefined,
        chunkData: m?.chunkData || null,
        appliedSpeedFactor: m?.appliedSpeedFactor,
        videoTimelineStartMs: m?.videoTimelineStartMs,
        videoTimelineEndMs: m?.videoTimelineEndMs,
      } as CompileShot;
    });
  }

  /**
   * 编译镜头数组为剪映 v360000 草稿 JSON（委托 core 的 assembleDraftContent）。
   *
   * @param shots     - 编译后的镜头数据
   * @param mediaPath - 源视频文件路径（chunkData 缺失时回退源）
   * @param bgmPath   - 背景音乐路径（可选）
   * @param subtitleStyle - 字幕样式（可选）
   * @returns 剪映 v360000 草稿 JSON 对象
   */
  static compileDraft(
    shots: CompileShot[],
    mediaPath: string,
    bgmPath?: string,
    subtitleStyle: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
  ): object {
    return assembleDraftContent(shots, mediaPath, bgmPath, subtitleStyle);
  }

  /**
   * 完整导出流程：编译草稿 → 写入文件系统（委托 core 的 exportJianying）。
   *
   * @param input        - 导出输入参数
   * @param jianyingRoot - 剪映草稿根目录（由调用方提供，避免 Electron 依赖）
   * @param ffmpegPath   - FFmpeg 可执行文件路径（封面生成用，可选）
   * @param subtitleStyle - 字幕样式（可选）
   * @returns 导出结果（文件夹路径 + 名称）
   */
  static export(
    input: JianyingExportInput,
    jianyingRoot: string,
    ffmpegPath?: string,
    subtitleStyle?: SubtitleStyle,
  ): JianyingExportOutput {
    void ffmpegPath;
    // 编译草稿内容（以 scriptParagraphs 为主数据源）
    const compileShots = JianyingExportService.buildCompileShots(input);
    return exportJianying(input, jianyingRoot, compileShots, subtitleStyle);
  }
}