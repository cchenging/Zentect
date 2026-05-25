// 📁 路径: src/main/controllers/ProjectController.ts
import { IpcRouter } from '../core/IpcRouter';
import { ProjectService } from '../services/ProjectService';
import { JobRepository } from '../database/repositories/JobRepository';
import { ProjectRepository } from '../database/repositories/ProjectRepository';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { AppError, ErrorCode } from '../../shared/utils/AppError';

export class ProjectController {
  private projectService = new ProjectService();

  public register() {
    IpcRouter.handle(IPC_CHANNELS.PROJECT_CREATE, async (_, payload?: { name?: string, type?: string }) => {
      return await this.projectService.createProject(payload || { type: 'workflow' });
    });

    IpcRouter.handle(IPC_CHANNELS.PROJECT_GET_LIST, async () => {
      return await this.projectService.getList();
    });

    IpcRouter.handle(IPC_CHANNELS.PROJECT_GET_RECENT, async () => {
      return await this.projectService.getRecent();
    });

    IpcRouter.handle(IPC_CHANNELS.PROJECT_GET_BY_ID, async (_, id: string) => {
      if (!id) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID is required');
      }
      const project = await this.projectService.getById(id);
      if (!project) {
        throw new AppError(ErrorCode.DATABASE_ERROR, `Project not found: ${id}`);
      }
      return project;
    });

    IpcRouter.handle(IPC_CHANNELS.PROJECT_LOAD_DATA, async (_, id: string) => {
      if (!id) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID is required');
      }
      return await this.projectService.loadData(id);
    });

    IpcRouter.handle(IPC_CHANNELS.PROJECT_SAVE_DATA, async (_, id: string, data: any) => {
      if (!id) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID is required');
      }
      await this.projectService.saveData(id, data);
      return true;
    });

    // P1: 增量保存 — 只更新解说稿中被修改的段落，避免全量序列化
    IpcRouter.handle(IPC_CHANNELS.PROJECT_UPDATE_SCRIPT_DELTA, async (_, projectId: string, deltas: Array<{ shotId: string; text: string }>) => {
      if (!projectId || !deltas?.length) return true;
      const data = await this.projectService.loadData(projectId);
      if (!data?.shots) return true;
      const shotMap = new Map(deltas.map(d => [d.shotId, d.text]));
      for (const shot of data.shots) {
        if (shotMap.has(shot.id)) {
          shot.aiText = shotMap.get(shot.id);
          shot.dirty = 1;
        }
      }
      await this.projectService.saveData(projectId, { shots: data.shots, aiShots: data.aiShots || [] });
      return true;
    });

    IpcRouter.handle(IPC_CHANNELS.PROJECT_SAVE_CANVAS, async (_, id: string, canvasData: string) => {
      if (!id) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID is required');
      }
      new ProjectRepository().updateCanvasDataOnly(id, canvasData);
      return { success: true };
    });

    IpcRouter.handle(IPC_CHANNELS.PROJECT_DELETE, async (_, id: string) => {
      if (!id) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID is required');
      }
      await this.projectService.deleteProject(id);
      return true;
    });

    IpcRouter.handle(IPC_CHANNELS.PROJECT_RENAME, async (_, id: string, newName: string) => {
      if (!id || !newName) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID and new name are required');
      }
      await this.projectService.renameProject(id, newName);
      return true;
    });

    IpcRouter.handle(IPC_CHANNELS.PROJECT_DUPLICATE, async (_, id: string) => {
      if (!id) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID is required');
      }
      return await this.projectService.duplicateProject(id);
    });

    // 💥 实例化模板
    IpcRouter.handle(IPC_CHANNELS.PROJECT_INSTANTIATE, async (_, payload: any) => {
      const templateId = payload?.templateId;
      if (!templateId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Template ID is required');
      }
      return await this.projectService.instantiateTemplate(templateId);
    });

    IpcRouter.handle(IPC_CHANNELS.TASK_GET_ALL, (_, projectId: string) => {
      return this.projectService.getAllTasks(projectId);
    });

    IpcRouter.handle(IPC_CHANNELS.TASK_GET_ACTIVE, async (_, projectId: string) => {
      const repo = new JobRepository();
      return repo.getActiveJobsByProject(projectId).map(job => ({
        mediaId: job.targetId,
        status: job.status,
        progress: job.progress,
        text: job.message || '引擎重连中...',
        startTime: new Date(job.createdAt).getTime()
      }));
    });
  }
}
