// 📁 路径：src/main/engine/export/LocalExporter.ts
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { JianyingCompiler } from './JianyingCompiler';

/**
 * 本地导出器：
 * 负责寻找剪映的本地目录，并物理创建草稿文件夹
 */
export class LocalExporter {
  /**
   * 导出到剪映草稿
   * @param projectId - 项目 ID
   * @param shots - 镜头数组
   * @param customPath - 自定义剪映草稿路径（可选）
   * @returns 导出结果
   */
  static async exportToJianying(projectId: string, shots: any[], customPath?: string, mediaPath?: string) {
    // 1. 确定剪映草稿存放路径 (Windows 标准路径)
    const jianyingRoot = customPath || path.join(
      app.getPath('home'), 
      'AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft'
    );

    if (!fs.existsSync(jianyingRoot)) {
      throw new Error('未找到剪映草稿目录，请在设置中手动指定。');
    }

    // 2. 创建本次导出的专属草稿文件夹
    const draftName = `Zentect_${Date.now()}`;
    const draftFolder = path.join(jianyingRoot, draftName);
    fs.mkdirSync(draftFolder, { recursive: true });

    // 3. 编译并写入 draft_content.json
    const draftContent = JianyingCompiler.compile(projectId, shots, mediaPath || '');
    fs.writeFileSync(
      path.join(draftFolder, 'draft_content.json'),
      JSON.stringify(draftContent, null, 2)
    );

    // 4. 写入 meta 文件 (让剪映列表能看到预览)
    const meta = {
      draft_name: draftName,
      draft_id: draftContent.id,
      draft_type: "short_video"
    };
    fs.writeFileSync(path.join(draftFolder, 'draft_meta.json'), JSON.stringify(meta));

    return { success: true, path: draftFolder };
  }
}
