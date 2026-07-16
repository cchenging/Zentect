/**
 * magic:// 协议处理器
 *
 * 职责：拦截所有 magic:// 请求，解析为物理文件并返回。
 *
 * 处理流程：
 *   URL 解析 → 路径推演 → 安全校验 → 格式/编码检测 → 流式转码 或 原生透传
 *
 * 流式转码触发条件：
 *   - 容器格式非 Chromium 原生支持（.mkv .avi .mov .wmv .flv .ts .rmvb .rm .3gp .vob）
 *   - 容器为 .mp4 但编码为 HEVC/H.265（Chromium 不支持 HEVC 解码）
 *   以上两类均通过 FFmpeg 实时转码为 H.264 + AAC / mp4
 */
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { spawn, exec } from 'child_process';
import { PathManager } from '../utils/pathManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';

// ─── 常量 ────────────────────────────────────────────────

/** MIME 类型映射：仅覆盖已知媒体格式，其余 fallback 到 octet-stream */
const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

/**
 * 非原生容器格式集合
 * Chromium 无法直接解析这些容器结构，必须经 FFmpeg 实时转码为 mp4
 */
const NON_STANDARD_CONTAINER_EXTS = new Set([
  '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.rmvb', '.rm', '.3gp', '.vob',
]);

/** HEVC/H.265 编解码器标识符（ffprobe codec_name 输出） */
const HEVC_CODEC_SIGNATURES = ['hevc', 'h265'];

// ─── 缓存 ────────────────────────────────────────────────

/**
 * HEVC 编码检测结果缓存
 * key: 文件绝对路径；value: 是否为 HEVC
 *
 * 缓存存在原因：
 *   Chromium 媒体播放时会发出大量分段 Range 请求（≥ 3 个），
 *   每个请求都经协议处理器，若不做缓存则同一文件多次 ffprobe。
 */
const hevcCodecCache = new Map<string, boolean>();

/**
 * 正在进行的 HEVC 检测 Promise 缓存
 *
 * 防止并发 Range 请求同时触发 ffprobe，取第一个请求的 pending Promise 共享结果。
 * 检测完成后将结果写入 hevcCodecCache 并从本缓存中移除。
 */
const pendingDetections = new Map<string, Promise<boolean>>();

// ─── 辅助函数 ────────────────────────────────────────────

/**
 * 将 Node.js ReadStream 包装为 Web ReadableStream
 *
 * 两个调用点共享：Range 分片请求 & 完整文件请求
 */
function wrapNodeStream(stream: fs.ReadStream): ReadableStream<Uint8Array> {
  let destroyed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer) => {
        if (!destroyed) controller.enqueue(new Uint8Array(chunk));
      });
      stream.on('end', () => {
        if (!destroyed) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      });
      stream.on('error', (err) => {
        if (!destroyed) controller.error(err);
      });
    },
    cancel() {
      destroyed = true;
      stream.destroy();
    },
  });
}

// ─── 路径解析 ────────────────────────────────────────────

/** 允许直通的根路径：越界路径返回 403 */
type ResolvePathResult = {
  ok: true; path: string;
} | {
  ok: false; status: number; message: string;
}

function resolveFilePath(decodedPath: string, host: string): ResolvePathResult {
  // URL 格式 1：magic://local/D%3A/videos/test.mp4 → host=local, pathname=/D%3A/videos/test.mp4
  // URL 格式 2：magic://localhost/D%3A/videos/test.mp4 → host=localhost
  // URL 格式 3：magic://proj_xxx/thumbnails/media_xxx.jpg → host=proj_xxx

  if (decodedPath.startsWith('/')) {
    decodedPath = decodedPath.slice(1);
  }

  // 项目 ID 模式（host 不是 local/localhost 时拼接到路径前）
  if (host && host !== 'local' && host !== 'localhost' && !decodedPath.startsWith(host + '/')) {
    decodedPath = host + '/' + decodedPath;
  }

  const projectsRoot = PathManager.getProjectsRootPath();
  const cacheRoot = PathManager.getCacheRootPath?.() || path.join(projectsRoot, '..', 'zentect-cache');
  const dataRoot = PathManager.getUserDataPath();
  const homeDir = app.getPath('home');

  let resolvedPath: string;

  // 分支 1：Windows 绝对路径（如 G:/Videos/test.mp4 → G:\Videos\test.mp4）
  if (/^[A-Za-z]:[\\/]/.test(decodedPath)) {
    resolvedPath = path.resolve(decodedPath.replace(/\//g, '\\'));
    const allowedRoots = [
      path.resolve(dataRoot),
      path.resolve(projectsRoot),
      path.resolve(cacheRoot),
      path.resolve(homeDir),
      path.join(homeDir, 'Videos'),
      path.join(homeDir, 'Music'),
      path.join(homeDir, 'Pictures'),
      path.join(homeDir, 'Desktop'),
      path.join(homeDir, 'Downloads'),
    ].filter(Boolean);

    // 允许非系统盘任意路径
    const systemDrive = (process.env.SystemDrive || 'C:').toLowerCase();
    const driveLetter = resolvedPath.substring(0, 2).toLowerCase();
    const isAllowed =
      allowedRoots.some((root) =>
        resolvedPath.toLowerCase().startsWith(root.toLowerCase() + path.sep),
      ) ||
      (driveLetter !== systemDrive && /^[a-z]:[\\]/i.test(resolvedPath));

    if (!isAllowed) {
      AppLogger.warn(LOG_TAGS.SYSTEM, `[magic://] 路径越权拒绝: ${resolvedPath}`);
      return { ok: false, status: 403, message: 'Forbidden' };
    }
    return { ok: true, path: resolvedPath };
  }

  // 分支 2：类 Unix 绝对路径（/home/xxx）
  if (decodedPath.startsWith('/')) {
    resolvedPath = path.resolve(decodedPath);
    const allowedRoots = [path.resolve(projectsRoot), path.resolve(cacheRoot), path.resolve(homeDir)].filter(Boolean);
    const isAllowed = allowedRoots.some((root) =>
      resolvedPath.toLowerCase().startsWith(root.toLowerCase() + path.sep),
    );
    if (!isAllowed) return { ok: false, status: 403, message: 'Forbidden' };
    return { ok: true, path: resolvedPath };
  }

  // 分支 3：项目相对路径（projectId/relative...）
  const slashIdx = decodedPath.indexOf('/');
  if (slashIdx === -1) return { ok: false, status: 400, message: 'Missing projectId' };

  const projectId = decodedPath.substring(0, slashIdx);
  const relativePath = decodedPath.substring(slashIdx + 1);

  if (projectId.includes('..') || relativePath.includes('..')) {
    return { ok: false, status: 403, message: 'Forbidden' };
  }

  resolvedPath = path.resolve(path.join(projectsRoot, projectId, relativePath));
  const resolvedRoot = path.resolve(projectsRoot);
  if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) {
    return { ok: false, status: 403, message: 'Forbidden' };
  }

  return { ok: true, path: resolvedPath };
}

// ─── HEVC 检测 ───────────────────────────────────────────

/**
 * 异步检测文件是否包含 HEVC/H.265 视频轨道
 *
 * 使用 ffprobe 查询第一条视频流的 codec_name，不阻塞主进程事件循环。
 * 并发请求共享 pending Promise，避免重复 ffprobe。
 */
async function detectHevcCodec(filePath: string): Promise<boolean> {
  // 命中缓存：直接返回
  if (hevcCodecCache.has(filePath)) {
    return hevcCodecCache.get(filePath)!;
  }

  // 命中 pending：共享进行中的检测
  if (pendingDetections.has(filePath)) {
    return pendingDetections.get(filePath)!;
  }

  const detection = new Promise<boolean>((resolve) => {
    const ffprobeExe = PathManager.getBinPath(
      process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
    );

    if (!ffprobeExe || !fs.existsSync(ffprobeExe)) {
      AppLogger.warn(LOG_TAGS.SYSTEM, '[magic://] ffprobe 未找到，跳过 HEVC 检测');
      return resolve(false);
    }

    exec(
      `"${ffprobeExe}" -v quiet -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${filePath}"`,
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          AppLogger.warn(LOG_TAGS.SYSTEM, `[magic://] ffprobe 失败: ${error.message}`);
          return resolve(false);
        }
        const codec = stdout.trim().toLowerCase();
        resolve(HEVC_CODEC_SIGNATURES.some((sig) => codec.includes(sig)));
      },
    );
  });

  pendingDetections.set(filePath, detection);

  const result = await detection;
  hevcCodecCache.set(filePath, result);
  pendingDetections.delete(filePath);
  return result;
}

// ─── FFmpeg 流式转码 ─────────────────────────────────────

/**
 * 通过 FFmpeg 实时转码为 H.264 + AAC / mp4 并返回流式 Response
 *
 * 参数：
 *   - preset=ultrafast + crf=28：牺牲画质以换取实时速度，避免播放卡顿缓冲区欠载
 *   - frag_keyframe+empty_moov：关键帧分片 + 前置 moov，支持边下边播
 *
 * 返回 null 表示转码不可用（无 ffmpeg 或 spawn 失败）
 */
function createTranscodeResponse(filePath: string): Response | null {
  const ffmpegExe = PathManager.getBinPath(
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  );

  if (!ffmpegExe || !fs.existsSync(ffmpegExe)) {
    AppLogger.warn(LOG_TAGS.SYSTEM, '[magic://] FFmpeg 未找到，无法转码');
    return null;
  }

  try {
    const ffmpegProc = spawn(ffmpegExe, [
      '-i', filePath,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'mp4', '-pipe:1',
    ], { windowsHide: true });

    AppLogger.info(LOG_TAGS.SYSTEM, `[magic://] FFmpeg 流式转码: ${filePath}`);

    let procKilled = false;
    const webStream = new ReadableStream({
      start(ctrl) {
        ffmpegProc.stdout.on('data', (chunk: Buffer) => {
          if (!procKilled) ctrl.enqueue(new Uint8Array(chunk));
        });
        ffmpegProc.stdout.on('end', () => ctrl.close());
        ffmpegProc.stdout.on('error', (err: Error) => ctrl.error(err));
      },
      cancel() {
        procKilled = true;
        if (!ffmpegProc.killed) ffmpegProc.kill('SIGTERM');
      },
    });

    ffmpegProc.on('error', () => {
      // spawn 失败时不做额外处理，已由 catch 返回 null
    });
    ffmpegProc.on('close', (code: number | null) => {
      if (code !== 0 && code !== null) {
        AppLogger.warn(LOG_TAGS.SYSTEM, `[magic://] FFmpeg 转码退出: code=${code}`);
      }
    });

    return new Response(webStream as any, {
      headers: {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'none',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err: any) {
    AppLogger.warn(LOG_TAGS.SYSTEM, `[magic://] FFmpeg 转码异常`, err);
    return null;
  }
}

// ─── 主处理器 ────────────────────────────────────────────

export async function handleMagicProtocol(request: Request): Promise<Response> {
  try {
    // 1. 解析 URL
    const urlObj = new URL(request.url);
    const encodedPath = urlObj.pathname;

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(encodedPath);
    } catch {
      return new Response('Invalid URL encoding', { status: 400 });
    }

    // 2. 路径推演 + 安全校验
    const resolved = resolveFilePath(decodedPath, urlObj.host);
    if (!resolved.ok) {
      return new Response(resolved.message, { status: resolved.status });
    }

    const resolvedPath = resolved.path;
    const ext = path.extname(resolvedPath).toLowerCase();

    // 3. 非原生容器格式：直接转码
    if (NON_STANDARD_CONTAINER_EXTS.has(ext)) {
      const response = createTranscodeResponse(resolvedPath);
      if (response) return response;
    }

    // 4. HEVC MP4 检测：异步非阻塞
    //    首次检测结果缓存到 hevcCodecCache，避免每个 Range 请求都调 ffprobe
    if (ext === '.mp4') {
      const isHevc = await detectHevcCodec(resolvedPath);
      if (isHevc) {
        AppLogger.info(LOG_TAGS.SYSTEM, `[magic://] 检测到 HEVC，流式转码: ${resolvedPath}`);
        const response = createTranscodeResponse(resolvedPath);
        if (response) return response;
      }
    }

    // 5. 原生格式：直接提供文件（含 Range 支持）
    const stat = await fs.promises.stat(resolvedPath);
    if (!stat.isFile()) {
      return new Response('Not a file', { status: 400 });
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // 5.1 Range 请求：视频播放必须支持，否则 Chromium 无法 seek/缓冲
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

      if (start >= stat.size || start < 0 || end > stat.size - 1 || start > end) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` },
        });
      }

      const chunkSize = end - start + 1;
      const nodeStream = fs.createReadStream(resolvedPath, { start, end, highWaterMark: 256 * 1024 });

      return new Response(wrapNodeStream(nodeStream) as any, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize.toString(),
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
        },
      });
    }

    // 5.2 完整文件请求
    const fullStream = fs.createReadStream(resolvedPath, { highWaterMark: 256 * 1024 });

    return new Response(wrapNodeStream(fullStream) as any, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': stat.size.toString(),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err: any) {
    if (err.code === 'ENOENT') return new Response('Not found', { status: 404 });
    if (err.code === 'EACCES') return new Response('Forbidden', { status: 403 });
    AppLogger.warn(LOG_TAGS.SYSTEM, `[magic://] 处理异常: ${err?.message}`);
    return new Response('Internal error', { status: 500 });
  }
}
