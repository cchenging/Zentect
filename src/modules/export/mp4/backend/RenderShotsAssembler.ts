// 📁 路径：src/modules/export/mp4/backend/RenderShotsAssembler.ts
// 渲染镜头装配：将 ExportProject.shots 装配为 FFmpegRenderer.RenderShot[]
//
// 职责：只负责「镜头 → 渲染镜头」的转换，不涉及渲染参数 / 分辨率 / 帧率。

import type { ExportProject } from '../../contracts/ExportProject';
import type { RenderShot } from '../../../../main/engine/media/FFmpegRenderer';

/**
 * 将 ExportProject.shots 装配为 FFmpegRenderer.RenderShot[]。
 *
 * 每个镜头映射：起止时间（秒）、配音路径、切片数据、变速因子。
 *
 * @param project 装配好的中间数据模型
 * @returns 渲染镜头数组
 */
export function assembleRenderShots(project: ExportProject): RenderShot[] {
  return project.shots.map((shot) => ({
    id: shot.id,
    startTime: shot.start,
    endTime: shot.end,
    ttsAudioPath: shot.audioPath,
    chunkData: (shot.chunkData as any) || null,
    speedFactor: shot.appliedSpeedFactor,
  }));
}