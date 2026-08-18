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
 *
 * ⚠️ 类型守卫：导出装配/历史脏数据可能把路径字段存成对象等非字符串
 *   （如 mediaItems.filePath / tts.audioUrl 被存成对象），直接调用 startsWith 会崩溃
 *   （报错 physicalPath.startsWith is not a function）。这里对非字符串统一返回空串止损。
 */
export function dehydrateMagicPath(physicalPath: string): string {
  // 非字符串（对象/数字/undefined之外的假值）→ 返回空串，避免下游 .startsWith 崩溃
  if (typeof physicalPath !== 'string' || !physicalPath) {
    console.warn('[dehydrateMagicPath] 收到非字符串路径，已归一为空:', physicalPath);
    return '';
  }
  if (!physicalPath.startsWith('magic://')) {
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
