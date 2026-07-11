// 📁 路径: src/main/services/UserService.ts
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { UserRepository, SessionRepository, VipActivationRepository } from '../database/repositories/UserRepository';
import type { UserRecord } from '../database/repositories/UserRepository';
import { AppError, ErrorCode } from '../../modules/infra/error/AppError';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';

/** 登录失败次数上限，超过后锁定账户 */
const MAX_FAILED_ATTEMPTS = 5;
/** 账户锁定时长（毫秒）：30 分钟 */
const LOCK_DURATION_MS = 30 * 60 * 1000;
/** 短期会话有效期（毫秒）：2 小时 */
const SHORT_SESSION_MS = 2 * 60 * 60 * 1000;
/** 长期会话有效期（毫秒）：30 天 */
const LONG_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** 安全用户信息（不含密码哈希） */
type SafeUser = Omit<UserRecord, 'password_hash'>;

/** 登录结果 */
interface LoginResult {
  token: string;
  expiresAt: string;
  user: SafeUser;
}

/** VIP 激活结果 */
interface VipActivationResult {
  vipLevel: string;
  vipExpireAt: string;
}

/** VIP 信息 */
interface VipInfoResult {
  vipLevel: string;
  vipExpireAt: string | null;
}

/**
 * 从用户记录中移除密码哈希，返回安全用户信息
 * @param user 完整用户记录
 * @returns 不含密码哈希的用户信息
 */
function toSafeUser(user: UserRecord): SafeUser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password_hash: _ph, ...rest } = user;
  return rest;
}

export class UserService {
  private userRepo = new UserRepository();
  private sessionRepo = new SessionRepository();
  private vipRepo = new VipActivationRepository();

  /**
   * 用户注册
   * 校验用户名唯一性，哈希密码后写入数据库
   * @param username 用户名
   * @param password 明文密码
   * @returns 新用户记录（不含密码哈希）
   */
  public async register(username: string, password: string): Promise<SafeUser> {
    // 校验参数
    if (!username || username.trim().length < 2) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '用户名长度不能少于2个字符');
    }
    if (!password || password.length < 6) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '密码长度不能少于6个字符');
    }

    // 检查用户名是否已存在
    const existing = this.userRepo.findByUsername(username.trim());
    if (existing) {
      throw new AppError(ErrorCode.PROJECT_NAME_DUPLICATE, '用户名已存在');
    }

    // 哈希密码
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // 生成用户 ID 并写入数据库
    const userId = `user_${uuidv4().replace(/-/g, '')}`;
    const user = this.userRepo.insert({
      id: userId,
      username: username.trim(),
      password_hash: passwordHash
    });

    AppLogger.info(LOG_TAGS.DATABASE, `用户注册成功: ${username}`);

    return toSafeUser(user);
  }

  /**
   * 用户登录
   * 验证密码、检查账户锁定、生成会话令牌
   * @param username 用户名
   * @param password 明文密码
   * @param rememberMe 是否记住登录（延长会话有效期）
   * @returns 登录结果（含 token 和用户信息）
   */
  public async login(username: string, password: string, rememberMe: boolean = false): Promise<LoginResult> {
    // 查找用户
    const user = this.userRepo.findByUsername(username.trim());
    if (!user) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, '用户名或密码错误');
    }

    // 检查账户是否被锁定
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remainingMinutes = Math.ceil(
        (new Date(user.locked_until).getTime() - Date.now()) / 60000
      );
      throw new AppError(ErrorCode.SYS_UNKNOWN, `账户已被锁定，请${remainingMinutes}分钟后再试`);
    }

    // 验证密码
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      // 增加失败次数
      this.userRepo.incrementFailedAttempts(user.id);

      // 检查是否达到锁定阈值
      const updatedUser = this.userRepo.findById(user.id);
      if (updatedUser && (updatedUser.failed_login_attempts ?? 0) >= MAX_FAILED_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOCK_DURATION_MS).toISOString();
        this.userRepo.lockUser(user.id, lockedUntil);
        AppLogger.warn(LOG_TAGS.DATABASE, `账户已锁定: ${username}`, { lockedUntil });
        throw new AppError(ErrorCode.SYS_UNKNOWN, `连续登录失败${MAX_FAILED_ATTEMPTS}次，账户已锁定30分钟`);
      }

      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, '用户名或密码错误');
    }

    // 登录成功：重置失败次数，更新最后登录时间
    this.userRepo.resetFailedAttempts(user.id);
    this.userRepo.updateLastLogin(user.id);

    // 生成会话令牌
    const token = uuidv4();
    const sessionId = `sess_${uuidv4().replace(/-/g, '')}`;
    const expiresAt = new Date(
      Date.now() + (rememberMe ? LONG_SESSION_MS : SHORT_SESSION_MS)
    ).toISOString();

    this.sessionRepo.createSession({
      id: sessionId,
      user_id: user.id,
      token,
      expires_at: expiresAt,
      remember_me: rememberMe ? 1 : 0
    });

    AppLogger.info(LOG_TAGS.DATABASE, `用户登录成功: ${username}`);

    return {
      token,
      expiresAt,
      user: toSafeUser(user)
    };
  }

  /**
   * 用户登出
   * 删除指定会话令牌
   * @param token 会话令牌
   */
  public logout(token: string): void {
    if (!token) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '令牌不能为空');
    }
    this.sessionRepo.deleteSession(token);
    AppLogger.info(LOG_TAGS.DATABASE, '用户登出成功');
  }

  /**
   * 获取用户信息
   * @param userId 用户 ID
   * @returns 用户信息（不含密码哈希）
   */
  public getProfile(userId: string): SafeUser {
    const user = this.userRepo.findById(userId);
    if (!user) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, '用户不存在');
    }
    return toSafeUser(user);
  }

  /**
   * 更新用户头像
   * @param userId 用户 ID
   * @param avatar 头像路径或 URL
   * @returns 更新后的用户信息
   */
  public updateAvatar(userId: string, avatar: string): SafeUser {
    if (!avatar) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '头像不能为空');
    }
    const user = this.userRepo.findById(userId);
    if (!user) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, '用户不存在');
    }
    this.userRepo.updateAvatar(userId, avatar);
    return this.getProfile(userId);
  }

  /**
   * 修改密码
   * 验证旧密码后更新为新密码
   * @param userId 用户 ID
   * @param oldPassword 旧密码
   * @param newPassword 新密码
   */
  public async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    if (!oldPassword || !newPassword) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '旧密码和新密码不能为空');
    }
    if (newPassword.length < 6) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '新密码长度不能少于6个字符');
    }

    const user = this.userRepo.findById(userId);
    if (!user) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, '用户不存在');
    }

    // 验证旧密码
    const isOldPasswordValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isOldPasswordValid) {
      throw new AppError(ErrorCode.SYS_UNKNOWN, '旧密码错误');
    }

    // 哈希新密码并更新
    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);
    this.userRepo.updatePassword(userId, newPasswordHash);

    AppLogger.info(LOG_TAGS.DATABASE, `用户修改密码成功: ${userId}`);
  }

  /**
   * 检查会话有效性
   * @param token 会话令牌
   * @returns 会话关联的用户信息，无效时返回 null
   */
  public checkSession(token: string): SafeUser | null {
    if (!token) {
      return null;
    }

    const session = this.sessionRepo.findSessionByToken(token);
    if (!session) {
      return null;
    }

    // 检查会话是否过期
    if (new Date(session.expires_at) < new Date()) {
      this.sessionRepo.deleteSession(token);
      return null;
    }

    // 获取用户信息
    const user = this.userRepo.findById(session.user_id);
    if (!user) {
      return null;
    }

    return toSafeUser(user);
  }

  /**
   * VIP 激活码激活
   * 校验激活码有效性后更新用户 VIP 等级和过期时间
   * @param userId 用户 ID
   * @param code 激活码
   * @returns 激活结果（含新的 VIP 信息）
   */
  public activateVip(userId: string, code: string): VipActivationResult {
    if (!code || !code.trim()) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '激活码不能为空');
    }

    // 查找激活码
    const activationCode = this.vipRepo.findByCode(code.trim());
    if (!activationCode) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, '激活码不存在');
    }

    // 校验激活码是否可用
    if (!activationCode.is_active) {
      throw new AppError(ErrorCode.SYS_UNKNOWN, '激活码已失效');
    }
    if (activationCode.used_count >= activationCode.max_uses) {
      throw new AppError(ErrorCode.SYS_UNKNOWN, '激活码已达到最大使用次数');
    }

    // 计算新的 VIP 过期时间
    const user = this.userRepo.findById(userId);
    if (!user) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, '用户不存在');
    }

    // 如果当前 VIP 未过期，在现有基础上延长；否则从当前时间开始计算
    const baseDate = (user.vip_expire_at && new Date(user.vip_expire_at) > new Date())
      ? new Date(user.vip_expire_at)
      : new Date();
    const vipExpireAt = new Date(
      baseDate.getTime() + activationCode.duration_days * 24 * 60 * 60 * 1000
    ).toISOString();

    // 更新用户 VIP 等级
    this.userRepo.updateVipLevel(userId, 'vip', vipExpireAt);

    // 增加激活码使用次数
    this.vipRepo.incrementUsedCount(code.trim());

    AppLogger.info(LOG_TAGS.DATABASE, `VIP 激活成功: 用户 ${userId}, 激活码 ${code}`);

    return {
      vipLevel: 'vip',
      vipExpireAt
    };
  }

  /**
   * 获取用户 VIP 信息
   * @param userId 用户 ID
   * @returns VIP 等级和过期时间
   */
  public getVipInfo(userId: string): VipInfoResult {
    const user = this.userRepo.findById(userId);
    if (!user) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, '用户不存在');
    }

    // 检查 VIP 是否已过期
    let vipLevel = user.vip_level || 'free';
    let vipExpireAt: string | null = user.vip_expire_at || null;

    if (vipLevel === 'vip' && vipExpireAt && new Date(vipExpireAt) < new Date()) {
      // VIP 已过期，降级为 free
      this.userRepo.updateVipLevel(userId, 'free', '');
      vipLevel = 'free';
      vipExpireAt = null;
    }

    return {
      vipLevel,
      vipExpireAt
    };
  }
}
