import { IpcRouter } from '../core/IpcRouter';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import { ApiProfileRepository } from '../database/repositories/ApiProfileRepository';
import { ProfileBindingRepository } from '../database/repositories/ProfileBindingRepository';

export class ApiProfileController {
  public register() {
    IpcRouter.handle(IPC_CHANNELS.API_PROFILE_GET_ALL, async () => {
      return ApiProfileRepository.getAll();
    });

    IpcRouter.handle(IPC_CHANNELS.API_PROFILE_GET_BY_PROVIDER, async (_, provider: string) => {
      return ApiProfileRepository.getByProvider(provider);
    });

    IpcRouter.handle(IPC_CHANNELS.API_PROFILE_CREATE, async (_, profile: any) => {
      return ApiProfileRepository.create(profile);
    });

    IpcRouter.handle(IPC_CHANNELS.API_PROFILE_UPDATE, async (_, id: string, patch: any) => {
      return ApiProfileRepository.update(id, patch);
    });

    IpcRouter.handle(IPC_CHANNELS.API_PROFILE_DELETE, async (_, id: string) => {
      // 🔧 修复 Bug3：先清理引用此 Profile 的绑定，再删除 Profile 本身
      ProfileBindingRepository.clearByProfileId(id);
      return ApiProfileRepository.delete(id);
    });

    // 🔧 修复 Bug3：独立暴露的清理接口（供前端在 profile 已被外部删除后调用）
    IpcRouter.handle(IPC_CHANNELS.BINDING_CLEAR_BY_PROFILE, async (_, profileId: string) => {
      return ProfileBindingRepository.clearByProfileId(profileId);
    });

    // 初始化配置：清理所有无效绑定（启动时或用户主动触发时调用）
    IpcRouter.handle(IPC_CHANNELS.BINDING_CLEANUP_INVALID, async () => {
      return ProfileBindingRepository.cleanupInvalid();
    });

    IpcRouter.handle(IPC_CHANNELS.API_PROFILE_ACTIVATE, async (_, id: string, provider: string) => {
      return ApiProfileRepository.activate(id, provider);
    });

    IpcRouter.handle(IPC_CHANNELS.API_PROFILE_TOGGLE_ENABLED, async (_, id: string, enabled: boolean) => {
      return ApiProfileRepository.toggleEnabled(id, enabled);
    });

    IpcRouter.handle(IPC_CHANNELS.BINDING_GET_ALL, async () => {
      return ProfileBindingRepository.getAll();
    });

    IpcRouter.handle(IPC_CHANNELS.BINDING_GET_BY_TASK, async (_, taskType: string) => {
      return ProfileBindingRepository.getByTaskType(taskType);
    });

    IpcRouter.handle(IPC_CHANNELS.BINDING_UPSERT, async (_, taskType: string, profileId: string | null, modelName: string) => {
      ProfileBindingRepository.upsert(taskType, profileId, modelName);
      return true;
    });
  }
}
