/**
 * 📁 TrimmedSourceResolver.ts — OP/ED 裁剪「源头执行层」
 * 策略层（MediaTrimPolicy）负责解析 + 结果后处理；本模块负责在**源头**喂给下游
 * 引擎「已裁剪素材」，让 ASR / 音频分离 / 抽帧 / 人脸 / 场景检测等消费方天然规避 OP/ED。
 *
 * 用法（消费适配层）：
 *   const src = await TrimmedSourceResolver.resolve({
 *     projectId, mediaId, mediaPath: targetAudio,
 *     mode: 'body', ext: '.wav', ar: 16000, ac: 1,
 *     getFfmpegPath: () => PathManager.getBinPath('ffmpeg.exe'),
 *   });
 *   if (src.shouldTrim) { 用 src.trimmedPath 喂引擎，产出时间戳为 body 坐标 }
 *   需回写源坐标时：src.toSource(bodySec)
 *
 * 坐标契约：
 *   · 裁剪后素材内部时间轴从 0 开始 = body 坐标（正剧段）
 *   · 源素材坐标 = source 坐标；sourceSec = bodySec + window.offsetSec
 *   · 消费方若需把结果落库为源坐标（与既有数据流一致），必须调用 toSource 换算
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { resolveForMedia, toMediaWindow, type MediaWindow } from './MediaTrimPolicy';

const TAG = 'TrimmedSourceResolver';

/** .trim_cache 单媒体（同一 trimFingerprint 前缀）最多保留的产物数，按 mtime 淘汰旧指纹 */
const TRIM_CACHE_KEEP_LATEST = 2;
/** .trim_cache 单目录容量告警阈值（超出即触发节流 warn） */
const TRIM_CACHE_WARN_BYTES = 1024 * 1024 * 1024; // 1GB
/** 容量告警节流间隔 */
const TRIM_CACHE_WARN_INTERVAL_MS = 5 * 60 * 1000;
let lastCacheWarnAt = 0;

export type MediaConsumeMode = 'whole' | 'body';

export interface TrimmedSourceInput {
  projectId: string;
  mediaId: string;
  /** 源素材文件路径（视频或音频） */
  mediaPath: string;
  /** 消费模式：body = 只消费正剧段（默认）；whole = 整段（不切） */
  mode?: MediaConsumeMode;
  /** 输出扩展名（决定编码方式）：'.wav' 音频窗口 / '.mp4' 视频窗口 */
  ext?: '.wav' | '.mp4';
  /** 音频窗口采样率（仅 '.wav'，缺省保持输入） */
  ar?: number;
  /** 音频窗口声道数（仅 '.wav'，缺省保持输入） */
  ac?: number;
  getFfmpegPath: () => string;
}

export interface TrimmedSource {
  window: MediaWindow;
  shouldTrim: boolean;
  /** 应喂给下游引擎的素材路径（无裁剪时 = 原路径） */
  trimmedPath: string;
  /** body 坐标 → 源坐标 */
  toSource(bodySec: number): number;
  /** 源坐标 → body 坐标 */
  toBody(sourceSec: number): number;
}

export class TrimmedSourceResolver {
  static async resolve(input: TrimmedSourceInput): Promise<TrimmedSource> {
    const trim = resolveForMedia(input.projectId, input.mediaId);
    const window = toMediaWindow(trim);
    const shouldTrim = input.mode !== 'whole' && (trim.trimStartMs > 0 || trim.trimEndMs > 0);
    const passthrough: TrimmedSource = {
      window,
      shouldTrim: false,
      trimmedPath: input.mediaPath,
      toSource: (b) => window.toSource(b),
      toBody: (s) => window.toBody(s),
    };
    if (!shouldTrim) return passthrough;

    const ext = input.ext || '.wav';
    const key = `${input.mediaId.slice(-8)}_o${window.offsetSec.toFixed(2)}` +
      (window.endSec !== undefined ? `_e${window.endSec.toFixed(2)}` : '_end');
    const cacheDir = path.join(path.dirname(input.mediaPath), '.trim_cache');
    const trimmedPath = path.join(cacheDir, `${key}${ext}`);
    if (!fs.existsSync(trimmedPath)) {
      try {
        await cutBody(input.mediaPath, trimmedPath, window, input);
        // 🧹 LRU：同一媒体（trimFingerprint 前缀）只保留最新 N 个产物，防止无界膨胀
        pruneCacheDir(cacheDir, `${input.mediaId.slice(-8)}_`, TRIM_CACHE_KEEP_LATEST);
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.MEDIA,
          `[${TAG}] 裁剪切片失败，回退整段: ${e.message}`, { mediaId: input.mediaId });
        return passthrough;
      }
    }
    warnIfCacheOversized(cacheDir);
    AppLogger.debug(LOG_TAGS.MEDIA,
      `[${TAG}] ${ext === '.wav' ? '音频' : '视频'}窗口: 偏移${window.offsetSec.toFixed(1)}s` +
      `${window.endSec !== undefined ? ` / 正剧${window.durationSec?.toFixed(1)}s` : ''} → ${trimmedPath}`);
    return {
      window,
      shouldTrim: true,
      trimmedPath,
      toSource: (b) => window.toSource(b),
      toBody: (s) => window.toBody(s),
    };
  }
}

/**
 * 🧹 LRU：对 cacheDir 内以 mediaKey 前缀开头的缓存产物按 mtime 降序，保留最新 keepLatest 个。
 * mediaKey 形如 `${mediaId尾8}_`，与 cache key 前缀一致，天然按「同一媒体的 trimFingerprint」分组。
 */
function pruneCacheDir(cacheDir: string, mediaKey: string, keepLatest: number): void {
  try {
    if (!fs.existsSync(cacheDir)) return;
    const files = fs.readdirSync(cacheDir)
      .filter((f) => f.startsWith(mediaKey))
      .map((f) => path.join(cacheDir, f))
      .filter((f) => fs.statSync(f).isFile())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length <= keepLatest) return;
    for (const stale of files.slice(keepLatest)) {
      fs.unlinkSync(stale);
      AppLogger.debug(LOG_TAGS.MEDIA, `[${TAG}] LRU 淘汰旧裁剪缓存: ${stale}`);
    }
  } catch (e: any) {
    AppLogger.warn(LOG_TAGS.MEDIA, `[${TAG}] 缓存 LRU 清理失败: ${e.message}`);
  }
}

/** 📊 容量告警（节流）：.trim_cache 目录总占用超阈值时 warn 一次 */
function warnIfCacheOversized(cacheDir: string): void {
  try {
    if (!fs.existsSync(cacheDir)) return;
    let total = 0;
    for (const f of fs.readdirSync(cacheDir)) {
      const fp = path.join(cacheDir, f);
      if (fs.statSync(fp).isFile()) total += fs.statSync(fp).size;
    }
    if (total > TRIM_CACHE_WARN_BYTES) {
      const now = Date.now();
      if (now - lastCacheWarnAt > TRIM_CACHE_WARN_INTERVAL_MS) {
        lastCacheWarnAt = now;
        AppLogger.warn(LOG_TAGS.MEDIA,
          `[${TAG}] .trim_cache 占用超阈值(${(total / (1024 * 1024 * 1024)).toFixed(2)}GB)，建议清理: ${cacheDir}`);
      }
    }
  } catch { /* 只读统计，静默 */ }
}

/**
 * 🧹 级联清理：项目删除 / 工程关闭时调用。
 * 仅当媒体源文件已不存在（被删除 / 随项目目录移除）时，才清理其同目录 `.trim_cache` 中该媒体的缓存，
 * 避免误删仍在被其他项目引用的共享媒体缓存。清理后若目录为空则一并移除。
 */
export async function cleanupMediaCaches(mediaAssets: Array<{ id: string; filePath: string }>): Promise<void> {
  for (const asset of mediaAssets) {
    try {
      if (fs.existsSync(asset.filePath)) continue; // 源文件仍在 → 保留缓存（其他项目可能复用）
      const cacheDir = path.join(path.dirname(asset.filePath), '.trim_cache');
      if (!fs.existsSync(cacheDir)) continue;
      const mediaKey = `${asset.id.slice(-8)}_`;
      let removed = 0;
      for (const f of fs.readdirSync(cacheDir)) {
        if (!f.startsWith(mediaKey)) continue;
        fs.unlinkSync(path.join(cacheDir, f));
        removed++;
      }
      if (removed > 0) AppLogger.debug(LOG_TAGS.MEDIA,
        `[${TAG}] 级联清理孤儿裁剪缓存 ${removed} 个 (${asset.id} → ${cacheDir})`);
      // 目录已空则整体移除，避免残留空目录
      if (fs.readdirSync(cacheDir).length === 0) fs.rmdirSync(cacheDir);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.MEDIA, `[${TAG}] 级联清理失败: ${e.message}`, { mediaId: asset.id });
    }
  }
}

function cutBody(src: string, out: string, window: MediaWindow, input: TrimmedSourceInput): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const seg = (s: number) => s.toFixed(3);
    // ⚠️ 坐标契约：window.endSec 是 body 坐标（正剧段终点 0..end），
    //    ffmpeg 的 -ss/-to 均以「源时间轴」为参考，必须 toSource 换算成绝对位置。
    const srcEndSec = window.endSec !== undefined
      ? Math.max(0, window.toSource(window.endSec))
      : undefined;
    let args: string[];
    if (input.ext === '.mp4') {
      // 视频窗口：-ss 前置快速 seek + stream copy（不重编码），时间轴归零
      args = ['-y', '-ss', seg(window.offsetSec)];
      if (srcEndSec !== undefined) args.push('-to', seg(srcEndSec));
      args.push('-i', src, '-c', 'copy', '-avoid_negative_ts', 'make_zero');
    } else {
      // 音频窗口：-ss/-to 放在 -i 之后做精确解码 seek
      args = ['-y', '-i', src, '-ss', seg(window.offsetSec)];
      if (srcEndSec !== undefined) args.push('-to', seg(srcEndSec));
      args.push('-map', '0:a:0', '-c:a', 'pcm_s16le');
      if (input.ar) args.push('-ar', String(input.ar));
      if (input.ac) args.push('-ac', String(input.ac));
    }
    args.push('-loglevel', 'error', out);
    AppLogger.debug(LOG_TAGS.MEDIA, `[${TAG}] ffmpeg ${args.join(' ')}`);
    const child = spawn(input.getFfmpegPath(), args);
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(out)) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${errBuf.slice(-300)}`));
    });
  });
}
