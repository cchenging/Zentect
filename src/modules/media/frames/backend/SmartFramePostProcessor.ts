// 📁 路径：src/modules/media/frames/backend/SmartFramePostProcessor.ts
// 关键帧追加式后处理：在 FFmpeg 抽帧落盘后，用 sharp 做像素级质检与精简
//
// 设计原则（追加式，不破坏 FFmpeg 抽帧核心与 framePaths 契约）：
//   1. 清晰度门禁：拉普拉斯方差打分，剔除运动撕裂/失焦的模糊帧
//   2. 黑屏检测：平均亮度过低（残影/溶接/黑场）的帧直接丢弃 —— 处理转场残影
//   3. 感知去重：aHash（8x8 灰度平均哈希）汉明距离判断，剔除重复静态帧
//   4. 时序元数据：按策略推断 timeMs，供下游步骤5绑定时间轴
//
// 依赖：sharp（已安装 ^0.34.5），无需 OpenCV 绑定

import sharp from 'sharp';

/** 单帧质检与元数据结果 */
export interface FrameAssetDetail {
  /** 图片落盘绝对路径 */
  framePath: string;
  /** 该帧在原视频中的毫秒时间戳 */
  timeMs: number;
  /** 格式化时间戳（如 "00:04.25"） */
  timeStr: string;
  /** 清晰度得分（拉普拉斯方差，越大越清晰） */
  clarityScore: number;
  /** 平均亮度（0-255，黑屏检测依据） */
  lumaScore: number;
  /** 所属物理镜头序号（本实现为保留帧的递增序号） */
  sceneIndex: number;
  /** 时间戳是否为估算值（非均匀抽帧策略下可能不精确） */
  estimatedTime?: boolean;
}

/** 后处理选项 */
export interface SmartFramePostProcessOptions {
  /** 抽帧策略，决定 timeMs 推断方式 */
  strategy: 'VLM_OPTIMIZED' | 'UNIFORM_FPS' | 'FAST_KEYFRAME' | 'PRECISE_SINGLE';
  /** 均匀抽帧帧率（UNIFORM_FPS 用） */
  fps?: number;
  /** 精准截图时间点（秒，PRECISE_SINGLE 用） */
  timePoint?: number;
  /** 清晰度下限，低于此值视为模糊帧丢弃，默认 100 */
  minClarity?: number;
  /** 平均亮度下限（0-255），低于此值视为黑屏丢弃，默认 16 */
  minLuma?: number;
  /** aHash 汉明距离上限，<= 此值视为重复静态帧，默认 5 */
  dedupThreshold?: number;
  /** 可选：每帧精确 PTS（毫秒，与 files 顺序对齐）。
   *  由 FFmpeg showinfo 捕获；提供时优先使用，否则按策略推断 */
  ptsMs?: number[];
}

/** 后处理结果 */
export interface SmartFramePostProcessResult {
  /** 保留下来的精选帧（含元数据） */
  kept: FrameAssetDetail[];
  /** 被丢弃的帧及其原因 */
  dropped: { framePath: string; reason: string; clarityScore: number; lumaScore: number }[];
}

/**
 * 追加式关键帧后处理器
 * 纯静态工具，可在 Node 测试环境直接调用（sharp 依赖完成拉普拉斯/哈希计算）
 */
export class SmartFramePostProcessor {
  /** 3x3 拉普拉斯卷积核：检测边缘锐度，用于衡量画面清晰度 */
  private static readonly LAPLACIAN_KERNEL = {
    width: 3,
    height: 3,
    kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
    scale: 1,
    offset: 0,
  };

  /**
   * 计算单帧清晰度得分（拉普拉斯方差）
   * 灰度图过 3x3 拉普拉斯核 → 统计输出标准差 → 方差
   * @param filePath 图片绝对路径
   * @returns 清晰度得分（越大越清晰，模糊/运动撕裂画面得分低）
   */
  static async assessClarity(filePath: string): Promise<number> {
    // 转灰度 + 缩小到 512 宽，加速卷积与统计而不失真
    const convolved = await sharp(filePath)
      .greyscale()
      .resize({ width: 512 })
      .convolve(this.LAPLACIAN_KERNEL)
      .toBuffer();
    const stats = await sharp(convolved).stats();
    const stddev = stats.channels[0].stddev ?? 0;
    return Math.round(stddev * stddev);
  }

  /**
   * 计算单帧平均亮度（0-255），用于黑屏/残影检测
   * @param filePath 图片绝对路径
   * @returns 平均亮度
   */
  static async assessLuma(filePath: string): Promise<number> {
    const pixel = await sharp(filePath).greyscale().resize({ width: 64 }).stats();
    return Math.round(pixel.channels[0].mean ?? 0);
  }

  /**
   * 计算单帧 aHash（8x8 灰度平均哈希，64 位）
   * 用于静态画面去重：相似画面哈希接近，汉明距离小
   * @param filePath 图片绝对路径
   * @returns 64 位 '0'/'1' 哈希字符串
   */
  static async computeHash(filePath: string): Promise<string> {
    // 8x8 灰度原始像素
    const { data, info } = await sharp(filePath)
      .greyscale()
      .resize(8, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = [...data];
    const mean = pixels.reduce((s, v) => s + v, 0) / pixels.length;
    // 每像素 >= 均值记为 1，否则 0
    return pixels.map((v) => (v >= mean ? '1' : '0')).join('');
  }

  /**
   * 计算两个 aHash 的汉明距离（逐位不同数）
   * @param a 哈希 A
   * @param b 哈希 B
   * @returns 汉明距离
   */
  static hammingDistance(a: string, b: string): number {
    if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) distance++;
    }
    return distance;
  }

  /**
   * 格式化毫秒时间戳为 "mm:ss.SSS" 形式
   * @param timeMs 毫秒
   * @returns 格式化字符串（如 "00:04.250"）
   */
  static formatTimeMs(timeMs: number): string {
    const totalSec = Math.max(0, timeMs) / 1000;
    const minutes = Math.floor(totalSec / 60);
    const seconds = Math.floor(totalSec % 60);
    const millis = Math.floor((totalSec % 1) * 1000);
    const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
    return `${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
  }

  /**
   * 主流程：对一批已落盘的帧做质检 + 精简 + 元数据封装
   * 会删除被丢弃的帧文件（保持磁盘与返回结果一致）
   * @param files FFmpeg 产出的帧路径列表（按时间顺序）
   * @param options 后处理选项
   * @returns 保留帧与被丢弃帧
   */
  static async process(
    files: string[],
    options: SmartFramePostProcessOptions,
  ): Promise<SmartFramePostProcessResult> {
    const {
      strategy,
      fps = 2,
      timePoint,
      minClarity = 100,
      minLuma = 16,
      dedupThreshold = 5,
      ptsMs,
    } = options;

    const kept: FrameAssetDetail[] = [];
    const dropped: SmartFramePostProcessResult['dropped'] = [];
    let lastHash = '';
    let sceneIndex = 0;

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      let clarityScore = 0;
      let lumaScore = 255;
      try {
        // 并行计算清晰度与亮度（两者独立）
        [clarityScore, lumaScore] = await Promise.all([
          this.assessClarity(filePath),
          this.assessLuma(filePath),
        ]);
      } catch (e: any) {
        // 单个文件读取失败不阻断整体，按最低分处理（交由门禁丢弃）
        clarityScore = 0;
        lumaScore = 0;
      }

      // ① 黑屏/残影门禁：亮度过低（黑场/叠化残影）
      if (lumaScore < minLuma) {
        dropped.push({ framePath: filePath, reason: `黑屏/残影 (luma=${lumaScore})`, clarityScore, lumaScore });
        this.tryUnlink(filePath);
        continue;
      }

      // ② 清晰度门禁：模糊帧（运动撕裂/失焦）
      if (clarityScore < minClarity) {
        dropped.push({ framePath: filePath, reason: `模糊帧 (clarity=${clarityScore})`, clarityScore, lumaScore });
        this.tryUnlink(filePath);
        continue;
      }

      // ③ 感知去重：与上一保留帧高度相似的静态画面折叠
      const currentHash = await this.computeHash(filePath).catch(() => '');
      if (currentHash && lastHash && this.hammingDistance(lastHash, currentHash) <= dedupThreshold) {
        dropped.push({ framePath: filePath, reason: `重复静态帧 (hamming<=${dedupThreshold})`, clarityScore, lumaScore });
        this.tryUnlink(filePath);
        continue;
      }
      if (currentHash) lastHash = currentHash;

      // ④ 时序元数据（优先用 showinfo 捕获的精确 PTS，否则按策略推断）
      const exactMs = ptsMs && ptsMs[i] !== undefined ? ptsMs[i] : undefined;
      const { timeMs, estimatedTime } = exactMs !== undefined
        ? { timeMs: exactMs, estimatedTime: false }
        : this.inferTimeMs(strategy, i, fps, timePoint);
      sceneIndex += 1;
      kept.push({
        framePath: filePath,
        timeMs,
        timeStr: this.formatTimeMs(timeMs),
        clarityScore,
        lumaScore,
        sceneIndex,
        estimatedTime,
      });
    }

    return { kept, dropped };
  }

  /**
   * 按策略推断帧时间戳
   * - UNIFORM_FPS：index / fps，精确
   * - PRECISE_SINGLE：timePoint，精确
   * - VLM_OPTIMIZED / FAST_KEYFRAME：非均匀，无法精确 → 标记 estimatedTime
   */
  private static inferTimeMs(
    strategy: 'VLM_OPTIMIZED' | 'UNIFORM_FPS' | 'FAST_KEYFRAME' | 'PRECISE_SINGLE',
    index: number,
    fps: number,
    timePoint?: number,
  ): { timeMs: number; estimatedTime: boolean } {
    switch (strategy) {
      case 'UNIFORM_FPS':
        return { timeMs: Math.round((index / fps) * 1000), estimatedTime: false };
      case 'PRECISE_SINGLE':
        return { timeMs: Math.round((timePoint ?? 0) * 1000), estimatedTime: false };
      case 'VLM_OPTIMIZED':
      case 'FAST_KEYFRAME':
      default:
        // 非均匀抽帧无精确 PTS，返回占位并明确标记为估算，避免误导下游
        return { timeMs: -1, estimatedTime: true };
    }
  }

  /** 安全删除文件（失败不抛错） */
  private static tryUnlink(filePath: string): void {
    try {
      const fs = require('fs') as typeof import('fs');
      fs.unlinkSync(filePath);
    } catch {
      /* 忽略删除失败 */
    }
  }
}