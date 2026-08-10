// 📁 路径：src/modules/export/jianying/backend/Service.ts
// 剪映草稿编译服务：将时间线编译为剪映 Project JSON（§3.6.1）
//
// 职责：保持公共静态 API（buildCompileShots / compileDraft / export）不变，
// 具体实现委托给 core 子模块（resolvers / assemblers / writers / JianyingExporter）。
// 设计原则：编排器只做数据转换与委托，不实现格式细节；ffprobe 通过 ExportBinDeps 注入，
// 不直接耦合 Electron 主进程 PathManager（纯模块可测试）。

import * as path from 'path';
import type { CompileShot } from '../types';
import type { JianyingExportInput, JianyingExportOutput, SubtitleStyle } from '../types';
import { DEFAULT_SUBTITLE_STYLE } from '../types';
import { assembleDraftContent } from './core/assemblers/DraftContentAssembler';
import { exportJianying } from './core/JianyingExporter';
import {
  probeVideoBatchSync,
  type ExportBinDeps,
  type VideoProbeResult,
} from './core/utils/FfprobeProber';

// ──────────────────────────────────────────────
// 二进制依赖注入（FrameExtractionDeps 风格）
// 运行时 Electron 主进程接入：{ getFfprobePath: () => PathManager.getBinPath('ffprobe.exe') }
// 测试环境：mock 返回固定 stub 探针结果（不走外部进程），见 Service.test.ts
// ──────────────────────────────────────────────

/** 剪映导出侧的二进制依赖：默认空实现（ffprobe 不可用时 fail-fast） */
let binDeps: ExportBinDeps = {
  getFfprobePath: () => {
    if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
    // 兜底 Windows 打包目录下的相对路径；若真实不存在，probeVideoSync 会抛 FFPROBE_MISSING
    const root = process.cwd();
    return path.join(root, 'resources', 'bin', 'win', 'shared',
      process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  },
};

/**
 * 运行时/测试中注入二进制依赖。主进程启动时会用 PathManager 版本替换默认值；
 * 单元测试中直接传入 stub probe 结果，避免启动 ffprobe 进程。
 */
export function setExportBinDeps(deps: ExportBinDeps): void {
  binDeps = { ...deps };
}

/** 获取当前二进制依赖（导出内部使用，不在 module 外暴露） */
export function getExportBinDeps(): ExportBinDeps {
  return binDeps;
}

// ──────────────────────────────────────────────
// 镜头 → 探针路径 收集
// ──────────────────────────────────────────────

/**
 * 从镜头数组中提取所有"待 probe"的视频绝对路径（去重）。
 *   - 优先 chunkData.filePath（切片），否则回退 input.mediaPath
 *   - 协议脱水：去掉 magic://local/、file://
 *   - Windows 路径反斜杠转正斜杠（保持一致的 Map key）
 */
function collectVideoPaths(shots: CompileShot[], fallbackMediaPath: string): string[] {
  const safeMedia = (fallbackMediaPath || '')
    .replace('magic://local/', '')
    .replace('file://', '')
    .replace(/\\/g, '/');
  const paths = new Set<string>();
  for (const sh of shots) {
    const chunk = sh.chunkData as Record<string, unknown> | null | undefined;
    const raw = chunk?.filePath ? String(chunk.filePath) : safeMedia;
    if (!raw) continue;
    const p = raw
      .replace('magic://local/', '')
      .replace('file://', '')
      .replace(/\\/g, '/');
    paths.add(p);
  }
  return Array.from(paths);
}

/**
 * 探针入口：按 shots 批量收集视频路径 → probe（ffprobe 缺省 / 缺文件 / 坏视频 全 fail-fast）
 *
 * 返回 Map<absPath, VideoProbeResult>；任何一个文件探针失败都直接抛错，不兜底 0x0。
 */
export function probeCompileShotVideos(
  shots: CompileShot[],
  fallbackMediaPath: string,
  deps: ExportBinDeps = binDeps,
): Map<string, VideoProbeResult> {
  return probeVideoBatchSync(deps, collectVideoPaths(shots, fallbackMediaPath));
}

// ──────────────────────────────────────────────
// 服务实现
// ──────────────────────────────────────────────

export class JianyingExportService {
  /**
   * 组装编译镜头：以 scriptParagraphs 为主数据源，matchResults/ttsResults 按 shotId 补充切片与配音
   */
  static buildCompileShots(input: JianyingExportInput): CompileShot[] {
    const matchByShotId = new Map<string, any>(
      (input.matchResults || []).map((m) => [m.shotId, m]),
    );
    const ttsByShotId = new Map<string, any>(
      (input.ttsResults || []).map((t) => [t.shotId, t]),
    );

    return (input.scriptParagraphs || []).map((p) => {
      const m = matchByShotId.get(p.shotId || p.id);
      const t = ttsByShotId.get(p.id || p.shotId || '');
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
   * @param depsOverride - 可选：替换默认二进制依赖（测试用，避免启动外部进程）
   */
  static compileDraft(
    shots: CompileShot[],
    mediaPath: string,
    bgmPath?: string,
    subtitleStyle: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
    depsOverride?: ExportBinDeps,
  ): object {
    const probeMap = probeCompileShotVideos(shots, mediaPath, depsOverride ?? binDeps);
    return assembleDraftContent(shots, mediaPath, probeMap, bgmPath, subtitleStyle);
  }

  /**
   * 完整导出流程：探针 → 编译草稿 → 写入文件系统（委托 core 的 exportJianying）。
   *
   * @param input        - 导出输入参数
   * @param jianyingRoot - 剪映草稿根目录（由调用方提供，避免 Electron 依赖）
   * @param ffmpegPath   - FFmpeg 可执行文件路径（预留封面生成，当前未使用）
   * @param subtitleStyle - 字幕样式（可选）
   * @param depsOverride - 可选：替换默认二进制依赖（测试用）
   */
  static export(
    input: JianyingExportInput,
    jianyingRoot: string,
    ffmpegPath?: string,
    subtitleStyle?: SubtitleStyle,
    depsOverride?: ExportBinDeps,
  ): JianyingExportOutput {
    void ffmpegPath;
    const compileShots = JianyingExportService.buildCompileShots(input);
    const deps = depsOverride ?? binDeps;
    const probeMap = probeCompileShotVideos(
      compileShots,
      input.mediaPath || input.outputDir || '',
      deps,
    );
    return exportJianying(input, jianyingRoot, compileShots, probeMap, subtitleStyle);
  }
}
