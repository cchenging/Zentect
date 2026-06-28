// 📁 路径：src/main/engine/utils/pathUtils.ts
// 🚀 路径工具函数：处理 magic:// 协议脱水等路径操作
import * as path from 'path';
import { PathManager } from '../../utils/pathManager';

/**
 * 将 magic:// 协议路径脱水为物理磁盘绝对路径
 * 支持格式：
 *   magic://{projectId}/videos/xxx.mp4 → {projectDir}/videos/xxx.mp4
 *   magic://local/F:/Videos/test.mp4    → F:\Videos\test.mp4
 *   普通物理路径 → 原样返回
 */
export function dehydrateMagicPath(physicalPath: string): string {
  if (!physicalPath || !physicalPath.startsWith('magic://')) {
    return physicalPath;
  }

  /** 跨盘符绝对路径：magic://local/F:/Videos/test.mp4 */
  if (physicalPath.startsWith('magic://local/')) {
    return physicalPath.replace('magic://local/', '').replace(/\//g, '\\');
  }

  /** 项目内相对路径：magic://{projectId}/videos/xxx.mp4 */
  const match = physicalPath.match(/^magic:\/\/([^/]+)\/(.+)$/);
  if (match) {
    const projectId = match[1];
    const relativePath = match[2].replace(/\//g, '\\');
    try {
      const projectDir = PathManager.getProjectDir(projectId);
      return path.join(projectDir, relativePath);
    } catch {
      /** 项目目录未找到时，返回原路径处理 */
      return physicalPath;
    }
  }

  /** 无法识别的 magic:// 格式，原样返回 */
  return physicalPath;
}
