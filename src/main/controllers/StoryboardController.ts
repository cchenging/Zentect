// 📁 路径: src/main/controllers/StoryboardController.ts
// 🎬 分镜单（S2 ShotSpec 工单）只读查询控制器。
// 前端分镜单面板（editor left 分镜单 tab）通过本控制器幂等拉取当前项目工单，
// 工单本体由 S2 分镜师 Agent（StoryboardAgent.openOrders）落盘到 data/projects/<pid>/storyboard_orders.json。
import fs from 'fs';
import path from 'path';
import { IpcRouter } from '../core/IpcRouter';
import { PathManager } from '../utils/pathManager';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import { AppLogger } from '../../modules/infra/logger/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

/** 工单缓存文件名（与 StoryboardAgent.loadCache 保存路径严格一致）。 */
const STORYBOARD_ORDERS_FILE = 'storyboard_orders.json';

export class StoryboardController {
  /**
   * 注册回调查询：读取当前项目 storyboard_orders.json。
   * 幂等设计：文件缺失 / JSON 解析失败 / 字段不完整一律返回 `{ orders: [] }`，绝不抛错，
   * 前端据此渲染空态（沿用工程"读不到就空"惯例）。
   */
  public register() {
    IpcRouter.handle(IPC_CHANNELS.STORYBOARD_LOAD, async (_event: unknown, projectId?: string) => {
      if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
        return { orders: [] as unknown[] };
      }

      try {
        const file = path.join(PathManager.getProjectDir(projectId.trim()), STORYBOARD_ORDERS_FILE);
        if (!fs.existsSync(file)) {
          return { orders: [] as unknown[] };
        }
        const raw = fs.readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw) as { orders?: unknown[] };
        const orders = Array.isArray(parsed?.orders) ? parsed.orders : [];
        return { orders };
      } catch {
        // 解析失败不阻断面板：返回空态并写一条 debug 日志（供排查，不影响正常流程）
        AppLogger.debug(LOG_TAGS.AI_AGENT,
          `[storyboard] 读取工单失败，返回空态 projectId=${projectId}`);
        return { orders: [] as unknown[] };
      }
    });
  }
}