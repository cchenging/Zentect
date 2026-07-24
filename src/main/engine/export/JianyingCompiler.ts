// 📁 路径：src/main/engine/export/JianyingCompiler.ts
/**
 * @deprecated 已迁移至 src/modules/export/jianying/backend/Service.ts
 * 请使用 JianyingExportService.compileDraft()
 */
import * as crypto from 'crypto';
import type { Shot } from '../../../shared/types';
import { JianyingExportService } from '@modules/export/jianying';

export class JianyingCompiler {
  /** @deprecated 请使用 JianyingExportService.compileDraft() */
  static compile(_projectId: string, shots: Shot[], _mediaPath: string, _bgmPath?: string) {
    return JianyingExportService.compileDraft(shots, _mediaPath, _bgmPath);
  }

  /** @deprecated 保留兼容 */
  private static readonly MICRO_SECOND = 1_000_000;
}
