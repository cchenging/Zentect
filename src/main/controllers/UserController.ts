// 📁 路径: src/main/controllers/UserController.ts
import { IpcRouter } from '../core/IpcRouter';
import { UserService } from '../services/UserService';
import { AppError, ErrorCode } from '../../shared/utils/AppError';

/**
 * 用户相关 IPC 频道常量
 * 后续合并到 IpcConstants.ts
 */
const USER_IPC_CHANNELS = {
  REGISTER: 'user:register',
  LOGIN: 'user:login',
  LOGOUT: 'user:logout',
  GET_PROFILE: 'user:getProfile',
  UPDATE_PROFILE: 'user:updateProfile',
  CHANGE_PASSWORD: 'user:changePassword',
  CHECK_SESSION: 'user:checkSession',
  ACTIVATE_VIP: 'user:activateVip',
  GET_VIP_INFO: 'user:getVipInfo'
} as const;

export class UserController {
  private userService = new UserService();

  /**
   * 注册所有用户相关 IPC 处理器
   */
  public register(): void {
    // 用户注册
    IpcRouter.handle(USER_IPC_CHANNELS.REGISTER, async (_, username: string, password: string) => {
      if (!username || !password) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '用户名和密码不能为空');
      }
      return await this.userService.register(username, password);
    });

    // 用户登录
    IpcRouter.handle(USER_IPC_CHANNELS.LOGIN, async (_, username: string, password: string, rememberMe: boolean = false) => {
      if (!username || !password) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '用户名和密码不能为空');
      }
      return await this.userService.login(username, password, rememberMe);
    });

    // 用户登出
    IpcRouter.handle(USER_IPC_CHANNELS.LOGOUT, async (_, token: string) => {
      return await this.userService.logout(token);
    });

    // 获取用户信息
    IpcRouter.handle(USER_IPC_CHANNELS.GET_PROFILE, async (_, userId: string) => {
      if (!userId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '用户 ID 不能为空');
      }
      return this.userService.getProfile(userId);
    });

    // 更新个人资料（当前仅支持头像更新）
    IpcRouter.handle(USER_IPC_CHANNELS.UPDATE_PROFILE, async (_, userId: string, data: { avatar?: string }) => {
      if (!userId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '用户 ID 不能为空');
      }
      if (data.avatar) {
        return this.userService.updateAvatar(userId, data.avatar);
      }
      return this.userService.getProfile(userId);
    });

    // 修改密码
    IpcRouter.handle(USER_IPC_CHANNELS.CHANGE_PASSWORD, async (_, userId: string, oldPassword: string, newPassword: string) => {
      if (!userId || !oldPassword || !newPassword) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '用户 ID、旧密码和新密码不能为空');
      }
      return await this.userService.changePassword(userId, oldPassword, newPassword);
    });

    // 检查登录状态
    IpcRouter.handle(USER_IPC_CHANNELS.CHECK_SESSION, async (_, token: string) => {
      return this.userService.checkSession(token);
    });

    // VIP 激活码激活
    IpcRouter.handle(USER_IPC_CHANNELS.ACTIVATE_VIP, async (_, userId: string, code: string) => {
      if (!userId || !code) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '用户 ID 和激活码不能为空');
      }
      return this.userService.activateVip(userId, code);
    });

    // 获取 VIP 信息
    IpcRouter.handle(USER_IPC_CHANNELS.GET_VIP_INFO, async (_, userId: string) => {
      if (!userId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '用户 ID 不能为空');
      }
      return this.userService.getVipInfo(userId);
    });
  }
}
