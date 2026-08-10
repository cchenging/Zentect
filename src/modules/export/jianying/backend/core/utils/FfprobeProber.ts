// 📁 路径：src/modules/export/jianying/backend/core/utils/FfprobeProber.ts
// ffprobe 视频元数据探针：读取 width / height / has_audio / duration 等。
//
// 设计：遵循 FrameExtractionDeps 风格，ffprobe 路径由外部 deps 注入，
// 不直接依赖 electron 主进程 PathManager，保持模块化可测试。
// 遵循原则 1/2：ffprobe 缺失时严格 fail-fast（抛错），不兜底 0x0。

import * as fs from 'fs';
import * as child_process from 'child_process';

/** 剪映导出侧的二进制依赖注入接口 */
export interface ExportBinDeps {
  /** 返回 ffprobe.exe 的绝对路径 */
  getFfprobePath: () => string;
}

/** 视频元数据探针结果 */
export interface VideoProbeResult {
  /** 视频像素宽（px） */
  width: number;
  /** 视频像素高（px） */
  height: number;
  /** 是否存在音频流 */
  hasAudio: boolean;
  /** 总时长（秒） */
  durationSec: number;
  /** 容器格式名（如 mov/mp4/matroska），未知时空串 */
  formatName: string;
  /** 视频编码名（如 h264），未知时空串 */
  codecName: string;
  /** 帧率（如 30.0），未知时 0 */
  fps: number;
}

/**
 * 探针失败错误类：区分"文件不存在 / ffprobe 缺省 / 解析失败 / 无视频流"
 */
export class ProbeError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'FILE_NOT_FOUND'
      | 'FFPROBE_MISSING'
      | 'FFPROBE_CRASHED'
      | 'NO_VIDEO_STREAM'
      | 'PARSE_FAILED',
  ) {
    super(message);
    this.name = 'ProbeError';
  }
}

/**
 * 探测单个视频的元数据。严格模式，失败抛 ProbeError，绝不兜底返回 0x0。
 *
 * @param deps - 二进制依赖
 * @param filePath - 视频文件绝对路径（Windows 下支持正反斜杠）
 * @returns 探针结果（width / height 一定大于 0）
 * @throws ProbeError 文件不可读 / ffprobe 不可用 / 无视频流 / 返回解析失败
 */
export function probeVideoSync(deps: ExportBinDeps, filePath: string): VideoProbeResult {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new ProbeError(`[probeVideo] 文件不存在：${filePath}`, 'FILE_NOT_FOUND');
  }
  const ffprobe = deps.getFfprobePath();
  if (!ffprobe || !fs.existsSync(ffprobe)) {
    throw new ProbeError(`[probeVideo] ffprobe 不可用：${ffprobe}`, 'FFPROBE_MISSING');
  }

  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    filePath,
  ];
  let stdout: string;
  try {
    stdout = child_process.execFileSync(ffprobe, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e: any) {
    const stderr = e?.stderr ? String(e.stderr).slice(0, 400) : '';
    throw new ProbeError(
      `[probeVideo] ffprobe 执行失败（exit=${e?.status ?? 'unknown'}）：${stderr || String(e?.message ?? e)}`,
      'FFPROBE_CRASHED',
    );
  }

  let data: any;
  try {
    data = JSON.parse(stdout);
  } catch (e) {
    throw new ProbeError('[probeVideo] ffprobe stdout 不是合法 JSON', 'PARSE_FAILED');
  }
  const streams: any[] = data?.streams || [];
  const format: any = data?.format || {};
  const videoStream = streams.find((s) => s && s.codec_type === 'video');
  if (!videoStream) {
    throw new ProbeError(`[probeVideo] 文件中未检测到视频流：${filePath}`, 'NO_VIDEO_STREAM');
  }
  const hasAudio = streams.some((s) => s && s.codec_type === 'audio');
  const width = Number(videoStream.width) || 0;
  const height = Number(videoStream.height) || 0;
  if (width === 0 || height === 0) {
    throw new ProbeError(
      `[probeVideo] 分辨率无效（${width}x${height}）：${filePath}`,
      'NO_VIDEO_STREAM',
    );
  }
  const durationSec = Number(format?.duration) ?? NaN;
  let fps = 0;
  const rframe = String(videoStream.r_frame_rate || '');
  if (rframe && rframe.includes('/')) {
    const [num, den] = rframe.split('/').map((x) => parseInt(x, 10));
    if (num && den && !isNaN(num) && !isNaN(den) && den !== 0) fps = num / den;
  }
  return {
    width,
    height,
    hasAudio,
    durationSec: isNaN(durationSec) ? 0 : durationSec,
    formatName: String(format?.format_name || ''),
    codecName: String(videoStream.codec_name || ''),
    fps,
  };
}

/**
 * 批量探针：按 path 去重，每个文件只 probe 一次，返回 Map<absPath, VideoProbeResult>。
 * 任何一个文件 probe 失败立即抛错（fail-fast）。
 */
export function probeVideoBatchSync(
  deps: ExportBinDeps,
  filePaths: string[],
): Map<string, VideoProbeResult> {
  const unique = Array.from(new Set((filePaths || []).filter(Boolean)));
  const result = new Map<string, VideoProbeResult>();
  for (const p of unique) result.set(p, probeVideoSync(deps, p));
  return result;
}
