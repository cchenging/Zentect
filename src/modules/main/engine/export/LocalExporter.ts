// 📁 路径：src/main/engine/export/LocalExporter.ts
/**
 * @deprecated 已迁移至 src/modules/export/jianying/backend/Service.ts
 * 请使用 JianyingExportService.export()
 */
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { JianyingCompiler } from './JianyingCompiler';

export class LocalExporter {
  /**
   * @deprecated 请使用 JianyingExportService.export()
   */
  static async exportToJianying(projectId: string, shots: any[], customPath?: string, mediaPath?: string) {
    const jianyingRoot = customPath || path.join(
      app.getPath('home'),
      'AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft'
    );

    if (!fs.existsSync(jianyingRoot)) {
      throw new Error('未找到剪映草稿目录，请在设置中手动指定。');
    }

    const draftName = `Zentect_${Date.now()}`;
    const draftFolder = path.join(jianyingRoot, draftName);
    fs.mkdirSync(draftFolder, { recursive: true });

    const draftContent = JianyingCompiler.compile(projectId, shots, mediaPath || '');
    fs.writeFileSync(
      path.join(draftFolder, 'draft_content.json'),
      JSON.stringify(draftContent, null, 2)
    );

    const meta = {
      draft_name: draftName,
      draft_id: draftContent.id,
      draft_type: "short_video"
    };
    fs.writeFileSync(path.join(draftFolder, 'draft_meta.json'), JSON.stringify(meta));

    return { success: true, path: draftFolder };
  }
}
