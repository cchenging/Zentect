// 📁 路径: src/main/database/repositories/UserRepository.ts
import Database from 'better-sqlite3';
import { SQLiteConnection } from '../core/SQLiteConnection';

/** 用户记录类型 */
export interface UserRecord {
  id: string;
  username: string;
  password_hash: string;
  avatar: string | null;
  vip_level: string;
  vip_expire_at: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  failed_login_attempts: number | null;
  locked_until: string | null;
}

/** 会话记录类型 */
export interface SessionRecord {
  id: string;
  user_id: string;
  token: string;
  created_at: string;
  expires_at: string;
  remember_me: number;
}

/** VIP 激活码记录类型 */
export interface VipCodeRecord {
  code: string;
  duration_days: number;
  max_uses: number;
  used_count: number;
  is_active: number;
  created_at: string;
}

/**
 * 用户数据仓储层
 * 负责用户表的 CRUD 操作
 */
export class UserRepository {
  private get db(): Database.Database { return SQLiteConnection.getInstance().getDB(); }

  /**
   * 按用户名查找用户
   * @param username 用户名
   * @returns 用户记录或 undefined
   */
  public findByUsername(username: string): UserRecord | undefined {
    return this.db.prepare(
      `SELECT * FROM users WHERE username = ?`
    ).get(username) as UserRecord | undefined;
  }

  /**
   * 按 ID 查找用户
   * @param id 用户 ID
   * @returns 用户记录或 undefined
   */
  public findById(id: string): UserRecord | undefined {
    return this.db.prepare(
      `SELECT * FROM users WHERE id = ?`
    ).get(id) as UserRecord | undefined;
  }

  /**
   * 插入用户记录
   * @param user 用户数据对象（id, username, password_hash, avatar, vip_level, vip_expire_at）
   * @returns 写入后的安全用户记录
   */
  public insert(user: {
    id: string;
    username: string;
    password_hash: string;
    avatar?: string;
    vip_level?: string;
    vip_expire_at?: string;
  }): UserRecord {
    const now = new Date().toISOString();
    const safeUser: UserRecord = {
      id: user.id,
      username: user.username,
      password_hash: user.password_hash,
      avatar: user.avatar || null,
      vip_level: user.vip_level || 'free',
      vip_expire_at: user.vip_expire_at || null,
      created_at: now,
      updated_at: now,
      last_login_at: null,
      failed_login_attempts: 0,
      locked_until: null
    };

    this.db.prepare(`
      INSERT INTO users (id, username, password_hash, avatar, vip_level, vip_expire_at, created_at, updated_at, last_login_at)
      VALUES (@id, @username, @password_hash, @avatar, @vip_level, @vip_expire_at, @created_at, @updated_at, @last_login_at)
    `).run(safeUser);

    return safeUser;
  }

  /**
   * 更新最后登录时间
   * @param id 用户 ID
   */
  public updateLastLogin(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`
    ).run(now, now, id);
  }

  /**
   * 更新 VIP 等级和过期时间
   * @param id 用户 ID
   * @param vipLevel VIP 等级
   * @param vipExpireAt VIP 过期时间
   */
  public updateVipLevel(id: string, vipLevel: string, vipExpireAt: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE users SET vip_level = ?, vip_expire_at = ?, updated_at = ? WHERE id = ?`
    ).run(vipLevel, vipExpireAt, now, id);
  }

  /**
   * 更新用户头像
   * @param id 用户 ID
   * @param avatar 头像路径或 URL
   */
  public updateAvatar(id: string, avatar: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE users SET avatar = ?, updated_at = ? WHERE id = ?`
    ).run(avatar, now, id);
  }

  /**
   * 更新用户密码
   * @param id 用户 ID
   * @param passwordHash 新密码哈希
   */
  public updatePassword(id: string, passwordHash: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`
    ).run(passwordHash, now, id);
  }

  /**
   * 增加登录失败次数
   * @param id 用户 ID
   */
  public incrementFailedAttempts(id: string): void {
    this.db.prepare(
      `UPDATE users SET failed_login_attempts = COALESCE(failed_login_attempts, 0) + 1, updated_at = ? WHERE id = ?`
    ).run(new Date().toISOString(), id);
  }

  /**
   * 重置登录失败次数
   * @param id 用户 ID
   */
  public resetFailedAttempts(id: string): void {
    this.db.prepare(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`
    ).run(new Date().toISOString(), id);
  }

  /**
   * 锁定用户至指定时间
   * @param id 用户 ID
   * @param lockedUntil 锁定截止时间（ISO 字符串）
   */
  public lockUser(id: string, lockedUntil: string): void {
    this.db.prepare(
      `UPDATE users SET locked_until = ?, updated_at = ? WHERE id = ?`
    ).run(lockedUntil, new Date().toISOString(), id);
  }
}

/**
 * 会话数据仓储层
 * 负责用户会话的创建、查询和清理
 */
export class SessionRepository {
  private get db(): Database.Database { return SQLiteConnection.getInstance().getDB(); }

  /**
   * 创建会话记录
   * @param session 会话数据对象（id, user_id, token, expires_at, remember_me）
   */
  public createSession(session: {
    id: string;
    user_id: string;
    token: string;
    expires_at: string;
    remember_me?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO user_sessions (id, user_id, token, created_at, expires_at, remember_me)
      VALUES (@id, @user_id, @token, @created_at, @expires_at, @remember_me)
    `).run({
      id: session.id,
      user_id: session.user_id,
      token: session.token,
      created_at: new Date().toISOString(),
      expires_at: session.expires_at,
      remember_me: session.remember_me || 0
    });
  }

  /**
   * 按 token 查找会话
   * @param token 会话令牌
   * @returns 会话记录或 undefined
   */
  public findSessionByToken(token: string): SessionRecord | undefined {
    return this.db.prepare(
      `SELECT * FROM user_sessions WHERE token = ?`
    ).get(token) as SessionRecord | undefined;
  }

  /**
   * 删除指定会话
   * @param token 会话令牌
   */
  public deleteSession(token: string): void {
    this.db.prepare(
      `DELETE FROM user_sessions WHERE token = ?`
    ).run(token);
  }

  /**
   * 清理所有过期会话
   * @returns 删除的会话数量
   */
  public deleteExpiredSessions(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `DELETE FROM user_sessions WHERE expires_at < ?`
    ).run(now);
    return result.changes;
  }
}

/**
 * VIP 激活码数据仓储层
 * 负责激活码的查询和使用次数更新
 */
export class VipActivationRepository {
  private get db(): Database.Database { return SQLiteConnection.getInstance().getDB(); }

  /**
   * 按激活码查找记录
   * @param code 激活码
   * @returns 激活码记录或 undefined
   */
  public findByCode(code: string): VipCodeRecord | undefined {
    return this.db.prepare(
      `SELECT * FROM vip_activation_codes WHERE code = ?`
    ).get(code) as VipCodeRecord | undefined;
  }

  /**
   * 增加激活码使用次数
   * @param code 激活码
   */
  public incrementUsedCount(code: string): void {
    this.db.prepare(
      `UPDATE vip_activation_codes SET used_count = used_count + 1 WHERE code = ?`
    ).run(code);
  }
}
