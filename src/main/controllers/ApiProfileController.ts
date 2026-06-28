import { IpcRouter } from '../core/IpcRouter';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { ApiProfileRepository } from '../database/repositories/ApiProfileRepository';
import { MigrationManager } from '../database/migrations/MigrationManager';

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
      return ApiProfileRepository.delete(id);
    });

    IpcRouter.handle(IPC_CHANNELS.API_PROFILE_ACTIVATE, async (_, id: string, provider: string) => {
      return ApiProfileRepository.activate(id, provider);
    });
  }
}