// 📁 路径: src/main/engine/media/ContactSheetBuilder.ts
// 🚀 P2 动态网格拼图（Contact Sheet）：将多帧拼接为单张网格图发送给 VLM
// 收益：Token 消耗降低 70%~80%（从 N×768 tokens 降至 1×768 tokens）
// 布局：2x2（4帧，1280×720）/ 3x3（9帧，1536×864）/ 1x1（独立发送，不拼图）
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

/** 矩阵布局模式 */
export type MatrixLayout = '2x2' | '3x3' | '1x1';

/** 拼图结果：单张网格图路径 + 对应的原始帧索引 */
export interface ContactSheetResult {
  /** 拼图后的临时文件路径 */
  gridPath: string;
  /** 该网格图包含的原始帧索引列表（用于 VLM 结果回填） */
  frameIndices: number[];
  /** 实际使用的布局 */
  layout: MatrixLayout;
}

/** 布局配置：列数、行数、单元宽高、编号字号 */
interface LayoutConfig {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  labelSize: number;
}

const LAYOUT_CONFIG: Record<Exclude<MatrixLayout, '1x1'>, LayoutConfig> = {
  // 2x2: 4 帧，总图 1280×720，每子图 640×360
  '2x2': { cols: 2, rows: 2, cellW: 640, cellH: 360, labelSize: 28 },
  // 3x3: 9 帧，总图 1536×864，每子图 512×288
  '3x3': { cols: 3, rows: 3, cellW: 512, cellH: 288, labelSize: 22 },
};

/**
 * 网格拼图构建器
 * 使用 sharp 将多帧 JPEG 拼接为单张网格图，并在子图左上角烙印编号 [1][2]...
 * 用于 VLM 批量帧分析，大幅降低 Vision Token 消耗
 */
export class ContactSheetBuilder {
  /**
   * 将多帧拼接为单张网格图
   * @param frames 帧信息数组（idx: 原始帧索引, path: 帧图片路径）
   * @param layout 网格布局（'1x1' 时不拼图，返回 null）
   * @param cacheDir 临时文件目录
   * @returns 拼图结果；帧数不足或布局为 1x1 时返回 null（调用方应降级为独立发送）
   */
  static async build(
    frames: { idx: number; path: string }[],
    layout: MatrixLayout,
    cacheDir: string,
  ): Promise<ContactSheetResult | null> {
    // 1x1 模式或空批次不拼图
    if (layout === '1x1' || frames.length === 0) return null;

    const cfg = LAYOUT_CONFIG[layout];
    const cellCount = cfg.cols * cfg.rows;

    // 帧数不足整除时返回 null，调用方应降级为 1x1 独立发送
    if (frames.length < cellCount) {
      AppLogger.debug(
        LOG_TAGS.MEDIA_ENGINE,
        `[ContactSheet] 帧数 ${frames.length} 不足 ${cellCount}（${layout}），降级为 1x1`,
      );
      return null;
    }

    // 只取 cellCount 张，多余的留给下一批
    const batch = frames.slice(0, cellCount);
    const totalW = cfg.cellW * cfg.cols;
    const totalH = cfg.cellH * cfg.rows;

    try {
      // 并行读取并 resize 所有子图
      const cells = await Promise.all(
        batch.map(async (f, i) => {
          const buf = await sharp(f.path)
            .resize(cfg.cellW, cfg.cellH, { fit: 'cover', position: 'center' })
            .jpeg({ quality: 85 })
            .toBuffer();
          const col = i % cfg.cols;
          const row = Math.floor(i / cfg.cols);
          return {
            input: buf,
            left: col * cfg.cellW,
            top: row * cfg.cellH,
            label: i + 1,
          };
        }),
      );

      // 构建编号烙印 SVG（黑底白字 [1][2]...）
      const labelOverlays = cells.map((c) => {
        const w = cfg.labelSize * 2;
        const h = cfg.labelSize + 8;
        const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${w}" height="${h}" fill="black" opacity="0.65"/>
          <text x="4" y="${h - 6}" fill="white" font-size="${cfg.labelSize}" font-family="sans-serif" font-weight="bold">[${c.label}]</text>
        </svg>`;
        return {
          input: Buffer.from(svg),
          left: c.left + 4,
          top: c.top + 4,
        };
      });

      // 合成：黑底画布 + 子图 + 编号
      const compositeOps = [
        ...cells.map((c) => ({ input: c.input, left: c.left, top: c.top })),
        ...labelOverlays,
      ];

      // 确保输出目录存在
      const outDir = path.join(cacheDir, 'contact_sheets');
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const outFile = path.join(
        outDir,
        `grid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`,
      );

      await sharp({
        create: {
          width: totalW,
          height: totalH,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      })
        .composite(compositeOps)
        .jpeg({ quality: 88 })
        .toFile(outFile);

      AppLogger.debug(
        LOG_TAGS.MEDIA_ENGINE,
        `[ContactSheet] 拼图完成: ${layout} (${cellCount} 帧 → ${outFile})`,
      );

      return {
        gridPath: outFile,
        frameIndices: batch.map((f) => f.idx),
        layout,
      };
    } catch (e: any) {
      AppLogger.warn(
        LOG_TAGS.MEDIA_ENGINE,
        `[ContactSheet] 拼图失败，降级为 1x1: ${e.message}`,
      );
      return null;
    }
  }

  /**
   * 自动选择布局：基于帧间隔（代表视频节奏密度）
   * - 帧间隔 >= 1.0s（低密度抽帧，平缓内容）→ 2x2（4帧，省 Token）
   * - 帧间隔 < 1.0s（高密度抽帧，快节奏动作）→ 3x3（9帧，捕捉细节）
   * @param estimatedIntervalSec 每帧代表的视频时长（秒）
   */
  static autoSelectLayout(estimatedIntervalSec: number): MatrixLayout {
    return estimatedIntervalSec >= 1.0 ? '2x2' : '3x3';
  }

  /**
   * 清理临时拼图文件
   * @param gridPath 拼图文件路径
   */
  static cleanup(gridPath: string): void {
    try {
      if (gridPath && fs.existsSync(gridPath)) fs.unlinkSync(gridPath);
    } catch (e: any) {
      AppLogger.warn(
        LOG_TAGS.MEDIA_ENGINE,
        `[ContactSheet] 清理临时文件失败: ${e.message}`,
      );
    }
  }

  /**
   * 获取布局的单元数（每批应收集的帧数）
   * @param layout 网格布局
   */
  static getCellCount(layout: MatrixLayout): number {
    if (layout === '1x1') return 1;
    const cfg = LAYOUT_CONFIG[layout];
    return cfg.cols * cfg.rows;
  }
}
