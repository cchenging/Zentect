// 📁 路径：src/modules/export/jianying/backend/core/utils/AudioPauseProber.ts
// 音频停顿（换气）探针：用 ffmpeg silencedetect 找出配音里的真实静音区间。
//
// 用途：解说字幕按「标点 + 字数比例」算出的切点只是近似；本探针给出配音实际换气位置，
//      供字幕切点做二次吸附（切在真静音里，而不是切在半句话中间）。
//
// 设计：遵循 FfprobeProber 的 deps 注入风格；ffmpeg 缺失/执行失败 → 返回空数组（渐进增强，
//      不阻断导出，调用方回退纯比例切点）。与视频探针的 fail-fast 语义不同：视频缺元数据
//      无法生成草稿，而静音数据只是画质优化项。

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import type { ExportBinDeps } from './FfprobeProber';

/** 一段静音（单位毫秒，相对音频文件起点） */
export interface PauseInterval {
  startMs: number;
  endMs: number;
}

/** 探针参数 */
export interface ProbePauseOptions {
  /** 静音判定门限（dB），越低越宽松；默认 -30 */
  noiseDb?: number;
  /** 判定为静音的最短时长（秒）；默认 0.1 */
  minPauseSec?: number;
}

/**
 * 解析 ffmpeg silencedetect 的 stderr 输出。
 * 输出形如：
 *   [silencedetect @ ...] silence_start: 2.07
 *   [silencedetect @ ...] silence_end: 2.374 | silence_duration: 0.304
 * 末尾未闭合的静音（一直静到文件结束）没有 silence_end，直接丢弃。
 */
export function parseSilenceDetectOutput(stderr: string): PauseInterval[] {
  const starts = Array.from(stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)).map((m) => Number(m[1]));
  const ends = Array.from(stderr.matchAll(/silence_end:\s*([\d.]+)/g)).map((m) => Number(m[1]));
  const pairs = Math.min(starts.length, ends.length);
  const out: PauseInterval[] = [];
  for (let i = 0; i < pairs; i++) {
    const startMs = Math.round(Math.max(0, starts[i]) * 1000);
    const endMs = Math.round(ends[i] * 1000);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    out.push({ startMs, endMs });
  }
  return out;
}

/**
 * 解析 ffmpeg 可执行文件路径：优先 deps 显式注入，其次与 ffprobe 同目录同名替换。
 * 找不到返回空串（调用方据此跳过探针）。
 */
export function resolveFfmpegPath(deps: ExportBinDeps): string {
  const explicit = deps.getFfmpegPath?.();
  const candidate = explicit && explicit.trim()
    ? explicit
    : (() => {
        const ffprobe = deps.getFfprobePath?.();
        if (!ffprobe) return '';
        const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        return path.join(path.dirname(ffprobe), name);
      })();
  return candidate && fs.existsSync(candidate) ? candidate : '';
}

/**
 * 探测音频文件的静音区间（同步）。
 * @param deps     二进制依赖
 * @param filePath 音频文件绝对路径
 * @returns 静音区间列表；文件不存在 / ffmpeg 不可用 / 执行失败 → 空数组
 */
export function probeAudioPausesSync(
  deps: ExportBinDeps,
  filePath: string,
  options: ProbePauseOptions = {},
): PauseInterval[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const ffmpeg = resolveFfmpegPath(deps);
  if (!ffmpeg) return [];
  const noiseDb = options.noiseDb ?? -30;
  const minPauseSec = options.minPauseSec ?? 0.1;
  const result = child_process.spawnSync(
    ffmpeg,
    [
      '-hide_banner', '-nostdin',
      '-i', filePath,
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minPauseSec}`,
      '-f', 'null', '-',
    ],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) return [];
  return parseSilenceDetectOutput(String(result.stderr || ''));
}
