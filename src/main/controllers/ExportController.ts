// 📁 路径: src/main/controllers/ExportController.ts
import { IpcRouter } from '../core/IpcRouter';
import { ExportService } from '../services/ExportService';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';

export class ExportController {
  private exportService = new ExportService();

  public register() {
    IpcRouter.handle(IPC_CHANNELS.EXPORT_LOCAL_VIDEO, async (event, payload) => {
      // 触发导出时，将 sender 传递给 Service 以便回调进度
      return await this.exportService.exportVideo(payload, event.sender);
    });

    IpcRouter.handle(IPC_CHANNELS.EXPORT_JIANYING, async (_, payload) => {
      return await this.exportService.exportToJianYing(payload);
    });
  }
}
