// 📁 路径：src/modules/export/jianying/backend/Service.ts
// 剪映草稿编译服务：将时间线编译为剪映 Project JSON（§3.6.1）
//
// 核心流程：
//   1. 接收 JianyingExportInput（matchResults + ttsResults + scriptParagraphs）
//   2. 编译为剪映 4 轨草稿（视频/BGM/TTS/字幕）
//   3. 输出 draft_content.json
//
// 剪映草稿格式：version 6，微秒单位，support BGM 降音铺底

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CompileShot } from '../types';
import type { JianyingExportInput, JianyingExportOutput } from '../types';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';

// ──────────────────────────────────────────────
// 服务实现
// ──────────────────────────────────────────────

export class JianyingExportService {
  private static readonly MICRO_SECOND = 1_000_000;

  /**
   * 核心：生成符合剪映标准的文本内容 JSON
   * 剪映要求 text content 是字符串化的 JSON
   */
  private static formatTextContent(text: string): string {
    const textObj = {
      text,
      styles: [
        {
          fill: { alpha: 1.0, color: [1.0, 1.0, 1.0] },
          size: 8.0,
        },
      ],
    };
    return JSON.stringify(textObj);
  }

  /**
   * 编译镜头数组为剪映草稿 JSON
   *
   * @param shots     - 镜头数据列表
   * @param mediaPath - 媒体文件路径
   * @param bgmPath   - 背景音乐路径（可选）
   * @returns 剪映草稿 JSON 对象
   */
  static compileDraft(
    shots: CompileShot[],
    mediaPath: string,
    bgmPath?: string,
  ): object {
    const draftId = crypto.randomUUID().toUpperCase();
    const safeMediaPath = (mediaPath || '').replace(/\\/g, '/');

    // 1. 真相源：物理/虚拟材质容器
    const materials: Record<string, unknown[]> = {
      videos: [],
      audios: [],
      texts: [],
      material_animations: [],
      material_colors: [],
    };

    // 2. 轨道逻辑：4 轨（视频 + BGM + TTS + 字幕）
    const videoTrack = {
      id: crypto.randomUUID(),
      type: 'video',
      segments: [] as unknown[],
    };
    const bgmTrack = {
      id: crypto.randomUUID(),
      type: 'audio',
      segments: [] as unknown[],
    };
    const ttsTrack = {
      id: crypto.randomUUID(),
      type: 'audio',
      segments: [] as unknown[],
    };
    const textTrack = {
      id: crypto.randomUUID(),
      type: 'text',
      segments: [] as unknown[],
    };

    let globalOffset = 0;

    // -- BGM 轨道（整片铺底，降音至 30%） --
    if (bgmPath) {
      const bgmMatId = crypto.randomUUID();
      const totalDuration = shots.reduce(
        (sum, s) =>
          sum +
          Math.round(
            (s.audioDuration || (s.end - s.start)) *
              JianyingExportService.MICRO_SECOND,
          ),
        0,
      );
      (materials.audios as unknown[]).push({
        id: bgmMatId,
        path: (bgmPath || '').replace(/\\/g, '/'),
        type: 'audio',
        duration: totalDuration,
      });
      (bgmTrack.segments as unknown[]).push({
        id: crypto.randomUUID(),
        material_id: bgmMatId,
        target_timerange: { start: 0, duration: totalDuration },
        source_timerange: { start: 0, duration: totalDuration },
        extra_material_refs: [bgmMatId],
        volume: 0.3,
      });
    }

    for (const shot of shots) {
      const durationUs = Math.round(
        (shot.audioDuration || (shot.end - shot.start)) *
          JianyingExportService.MICRO_SECOND,
      );

      const vMatId = crypto.randomUUID();
      const aMatId = crypto.randomUUID();
      const tMatId = crypto.randomUUID();

      // --- A. 视频材质 ---
      (materials.videos as unknown[]).push({
        id: vMatId,
        path: safeMediaPath,
        type: 'video',
        duration: durationUs,
        local_id: '',
      });
      (videoTrack.segments as unknown[]).push({
        id: crypto.randomUUID(),
        material_id: vMatId,
        target_timerange: { start: globalOffset, duration: durationUs },
        source_timerange: { start: 0, duration: durationUs },
        track_id: videoTrack.id,
        extra_material_refs: [vMatId],
      });

      // --- B. AI 配音音频 (TTS 轨) ---
      if (shot.audioPath) {
        const cleanAudioPath = shot.audioPath
          .replace('file://', '')
          .replace(/\\/g, '/');
        (materials.audios as unknown[]).push({
          id: aMatId,
          path: cleanAudioPath,
          type: 'audio',
          duration: durationUs,
        });
        (ttsTrack.segments as unknown[]).push({
          id: crypto.randomUUID(),
          material_id: aMatId,
          target_timerange: { start: globalOffset, duration: durationUs },
          source_timerange: { start: 0, duration: durationUs },
          extra_material_refs: [aMatId],
        });
      }

      // --- C. AI 字幕 ---
      const contentText = shot.aiText || shot.originalText || '';
      if (contentText) {
        (materials.texts as unknown[]).push({
          id: tMatId,
          content: JianyingExportService.formatTextContent(contentText),
          type: 'text',
        });
        (textTrack.segments as unknown[]).push({
          id: crypto.randomUUID(),
          material_id: tMatId,
          target_timerange: { start: globalOffset, duration: durationUs },
          extra_material_refs: [tMatId],
        });
      }

      globalOffset += durationUs;
    }

    return {
      version: 6,
      id: draftId,
      fps: 30,
      duration: globalOffset,
      materials,
      tracks: [videoTrack, bgmTrack, ttsTrack, textTrack],
      canvas_config: { height: 1080, width: 1920, ratio: '16:9' },
    };
  }

  /**
   * 完整导出流程：编译草稿 → 写入文件系统
   *
   * @param input       - 导出输入参数
   * @param jianyingRoot - 剪映草稿根目录（由调用方提供，避免 Electron 依赖）
   * @returns 导出结果（文件夹路径 + 名称）
   */
  static export(
    input: JianyingExportInput,
    jianyingRoot: string,
  ): JianyingExportOutput {
    if (!fs.existsSync(jianyingRoot)) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '未找到剪映草稿目录，请在设置中手动指定。');
    }

    const draftName = `Zentect_${Date.now()}`;
    const draftFolder = path.join(jianyingRoot, draftName);
    fs.mkdirSync(draftFolder, { recursive: true });

    // 编译草稿内容
    const draftContent = JianyingExportService.compileDraft(
      input.scriptParagraphs.map((p) => ({
        id: p.shotId || p.id,
        mediaId: '',
        imagePath: '',
        text: p.text,
        originalText: p.text,
        start: 0,
        end: p.duration || 10,
        duration: p.duration || 10,
        audioDuration: p.duration,
      })) as unknown as CompileShot[],
      input.outputDir,
      input.bgmPath,
    );

    fs.writeFileSync(
      path.join(draftFolder, 'draft_content.json'),
      JSON.stringify(draftContent, null, 2),
    );

    // 写入 meta 文件
    const meta = {
      draft_name: draftName,
      draft_id: (draftContent as Record<string, unknown>).id,
      draft_type: 'short_video',
    };
    fs.writeFileSync(
      path.join(draftFolder, 'draft_meta.json'),
      JSON.stringify(meta),
    );

    return { filePath: draftFolder, fileName: draftName };
  }
}
