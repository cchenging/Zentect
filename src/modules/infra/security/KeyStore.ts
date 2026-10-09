// 📁 路径：src/modules/infra/security/KeyStore.ts
// ADR-004 §4.1 / §4.2（P1）：信封加密的密钥仓库
//
// 密钥层级（绝不在任何地方落明文 DEK，也不把 DEK 给用户导出）：
//
//   <data>/keys/master.key  { v:3, dekId, createdAt, wrap_os, wrap_recovery }
//        ├─ wrap_os       = safeStorage(base64(DEK))       ← KEK-A：OS 级（DPAPI），日常主路径
//        └─ wrap_recovery = AES-256-GCM(恢复密钥, DEK)      ← KEK-B：随机秘密、用户持有（P3 接 UI）
//                        │ 任一 wrap 都能解出同一把 DEK
//                        ▼
//   DEK（32B random）→ AES-256-GCM + random 12B IV + AAD → "v3:dekId:iv:tag:ct"
//
// ⚠️ 为什么 KEK-B 必须是**随机**秘密而不是机器派生（ADR-004 §3）：`username / arch / platform / 盐`
//    全是公开量，派生式 KEK 等价于把 DEK 明写；且派生逻辑必须编进二进制，而二进制与数据同机。
//
// ⚠️ 本模块**刻意不 import** crypto.ts 与 pathManager.ts：
//    - crypto.ts：crypto → KeyStore 是单向依赖，反过来会形成 crypto ↔ KeyStore 循环；
//      v3 编解码因此**在这里实现并导出**，crypto.ts 只负责「通道选择与优先级」。
//    - pathManager.ts：PathManager → SettingsRepository → CredentialManager → crypto 整条链都会被拖进来，
//      同样成环。故数据根目录由调用方通过 `init(baseDir)` **注入**（当前装配点：启动期凭据自检
//      CredentialSelfCheck；P2 接线仓储时应挪进点火序列并前置）。
//
// 失败语义（§4.3 / G5）：只要 master.key 缺失、损坏、或两个 wrap 都不可用，都**不得抛异常**，
//    一律降级为 `getDek() === null` + 可由启动自检读取的 `KeyStoreState`，由上层 fail-closed。

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { safeStorage } from 'electron';
import { AppLogger } from '../logger/AppLogger';
import { LOG_TAGS } from '../logger/LogConstants';

/** master.key 版本号（ADR-004 §4.1） */
export const MASTER_KEY_VERSION = 3;
/** v3 AAD 前缀：`AAD = "zentect:cred:v3:" + purpose`（ADR-004 §4.2 N2） */
export const V3_AAD_PREFIX = 'zentect:cred:v3:';
/** DEK 长度：32B（AES-256） */
const DEK_BYTES = 32;
/** 首个 DEK 的标识（§4.2：2 位十进制字符串，为将来轮换预留） */
const INITIAL_DEK_ID = '01';
const DEK_ID_PATTERN = /^\d{2}$/;
const KEYS_DIR_NAME = 'keys';
const MASTER_KEY_FILENAME = 'master.key';
/** wrap_recovery 自身的 AAD —— 与凭据 AAD 分域，防止「wrap 密文」和「凭据密文」互相搬运 */
const WRAP_RECOVERY_AAD = V3_AAD_PREFIX + 'wrap_recovery';

/** master.key 的文件结构（内部件，永不导出给用户；G6 导出的是 Recovery Kit 而非本文件） */
export interface MasterKeyFile {
  v: number;
  /** DEK 标识（"01"…"99"），与密文里的 `<dekId>` 段对应 */
  dekId: string;
  createdAt: string;
  /** KEK-A：`safeStorage.encryptString(base64(DEK))` 的 base64 */
  wrap_os?: string;
  /** KEK-B：`"v3:<iv>:<tag>:<ct>"`（恢复密钥包裹的 DEK） */
  wrap_recovery?: string;
}

/** KeyStore 状态判别联合（§9.2：任一状态都不许崩，必须可被启动自检读取） */
export type KeyStoreStatus =
  | 'ready'
  | 'missing_master_key'
  | 'corrupted_master_key'
  | 'no_usable_wrap';

export interface KeyStoreState {
  status: KeyStoreStatus;
  dekId: string | null;
  createdAt: string | null;
  /** master.key 内是否存在 wrap_recovery（Tier 1 恢复材料是否齐备，§4.5） */
  recoveryAvailable: boolean;
  /** wrap_os 本次是否解开成功 */
  osWrapUsable: boolean;
  /** 是否已绑定恢复密钥（P3 接 UI；P1 仅内存绑定） */
  recoveryKeyBound: boolean;
  /** master.key 绝对路径（未注入数据根目录时为空串） */
  filePath: string;
  /** 失败原因说明（供启动自检打印；正常时为空串） */
  detail: string;
}

// =====================================================================
// v3 编解码原语（纯函数，无状态；ADR-004 §4.2 N1/N2/N3）
// =====================================================================

/** AAD 构造：`zentect:cred:v3:<purpose>`（purpose 必须与写入字段一一对应，否则密文无法跨字段搬运） */
export function buildV3Aad(purpose: string): Buffer {
  return Buffer.from(V3_AAD_PREFIX + purpose, 'utf8');
}

/**
 * 加密 ⇒ `v3:<dekId>:<base64url(iv)>:<base64url(tag)>:<base64url(ct)>`
 *
 * N1：IV 每次 `randomBytes(12)`，**禁止**固定 IV / `hash(明文)` 派生 IV / `DEK+字段名` 确定性 IV。
 * N2：AAD 必填（purpose 参与认证）。
 */
export function encodeV3(dek: Buffer, dekId: string, purpose: string, plaintext: string): string {
  if (!DEK_ID_PATTERN.test(dekId)) throw new Error(`encodeV3: 非法 dekId「${dekId}」`);
  if (!purpose) throw new Error('encodeV3: purpose 必填（v3 写入路径不得缺 AAD）');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(buildV3Aad(purpose));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v3:${dekId}:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

/**
 * 解密（N3：真边界是 GCM auth tag）
 *
 * 返回 null 覆盖全部失败：格式非法 / purpose 不匹配（AAD 不符）/ 被横向搬运 / 密钥不符 / 数据损坏。
 * **不抛异常** —— 调用方（`crypto.decryptData`）统一按 fail-closed 处理。
 */
export function decodeV3(dek: Buffer, purpose: string, text: string): string | null {
  try {
    const parts = text.split(':');
    if (parts.length !== 5 || parts[0] !== 'v3' || !DEK_ID_PATTERN.test(parts[1])) return null;
    const iv = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv, { authTagLength: 16 });
    decipher.setAAD(buildV3Aad(purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** 用恢复密钥包裹 DEK ⇒ `"v3:<iv>:<tag>:<ct>"`（P3 的 `bindRecovery` 与单测共用） */
export function encodeWrapRecovery(recoveryKey: Buffer, dek: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', recoveryKey, iv);
  cipher.setAAD(Buffer.from(WRAP_RECOVERY_AAD, 'utf8'));
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  return `v3:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

/** 用恢复密钥解出 DEK（失败返回 null） */
export function decodeWrapRecovery(recoveryKey: Buffer, text: string): Buffer | null {
  try {
    const parts = text.split(':');
    if (parts.length !== 4 || parts[0] !== 'v3') return null;
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', recoveryKey, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(WRAP_RECOVERY_AAD, 'utf8'));
    decipher.setAuthTag(tag);
    const dek = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]);
    return dek.length === DEK_BYTES ? dek : null;
  } catch {
    return null;
  }
}

// =====================================================================
// KeyStore
// =====================================================================

export class KeyStore {
  private static instance: KeyStore | null = null;

  private baseDir = '';
  private filePath = '';
  private file: MasterKeyFile | null = null;
  private cachedDek: Buffer | null = null;
  private recoveryKey: Buffer | null = null;
  private state: KeyStoreState = {
    status: 'missing_master_key',
    dekId: null,
    createdAt: null,
    recoveryAvailable: false,
    osWrapUsable: false,
    recoveryKeyBound: false,
    filePath: '',
    detail: '',
  };

  private constructor() {}

  static getInstance(): KeyStore {
    if (!KeyStore.instance) KeyStore.instance = new KeyStore();
    return KeyStore.instance;
  }

  /**
   * 幂等初始化：注入数据根目录 → 定位 `<data>/keys/master.key` → 读盘（首次则生成）
   *
   * - 文件已存在：**只读，绝不覆盖**（覆盖 = 毁库；损坏时保留原文件，用户仍可能用恢复材料救回）
   * - 文件不存在且 `safeStorage` 不可用：**拒绝落盘**（造出无可用 wrap 的密钥等于没有密钥），
   *   状态置 `no_usable_wrap`，等 OS 通道恢复后的首次启动再生成
   */
  init(baseDir?: string): KeyStoreState {
    if (baseDir !== undefined && baseDir !== this.baseDir) {
      this.baseDir = baseDir;
      this.cachedDek = null;
    }
    if (!this.baseDir) {
      this.filePath = '';
      this.file = null;
      this.cachedDek = null;
      return this.setState('missing_master_key', '未注入数据根目录，master.key 无从寻址');
    }

    this.filePath = path.join(this.baseDir, KEYS_DIR_NAME, MASTER_KEY_FILENAME);
    this.file = null;
    this.cachedDek = null;

    if (!fs.existsSync(this.filePath)) {
      this.createMasterKey();
      return this.getState();
    }
    this.loadMasterKey();
    return this.getState();
  }

  getState(): KeyStoreState {
    return { ...this.state, filePath: this.filePath, recoveryKeyBound: !!this.recoveryKey };
  }

  /**
   * 取 DEK（§4.1「两层 wrap 依次试」）：wrap_os → wrap_recovery
   *
   * 任一都不通 ⇒ null（**不抛异常**）。成功结果在内存缓存，避免每次加解密都做一次 OS 解密。
   */
  getDek(): { dek: Buffer; dekId: string } | null {
    if (!this.file) return null;
    if (!this.cachedDek) {
      this.cachedDek = this.unwrapOs() ?? this.unwrapRecovery();
    }
    if (!this.cachedDek) return null;
    return { dek: this.cachedDek, dekId: this.file.dekId };
  }

  /**
   * 绑定恢复密钥（KEK-B）
   *
   * 仅做内存绑定，供 `getDek()` 在 wrap_os 失效时回落救急。
   * ⚠️ 恢复导出已取消（用户裁定：不导出恢复材料）⇒ 无调用方，`master.key` 永不写出 `wrap_recovery`；
   *    换言之当前唯一 KEK 是 KEK-A（DPAPI），`data/keys/master.key` 与 Chromium profile 需同存亡。
   */
  bindRecovery(recoveryKey: Buffer): void {
    if (recoveryKey.length !== DEK_BYTES) {
      throw new Error(`bindRecovery: 恢复密钥长度必须为 ${DEK_BYTES} 字节（当前 ${recoveryKey.length}）`);
    }
    this.recoveryKey = recoveryKey;
    this.cachedDek = null;
  }

  /**
   * 自检（G5）：DEK 可用 + 一次 v3 往返 + N1（IV 唯一）+ N2（AAD 绑定）
   *
   * 内含真实断言而不是「能跑就算过」——AAD 断言失败意味着密文可被跨字段搬运，
   * 与「加密层已损坏」同等严重，必须让启动自检看见。
   */
  selfTest(): { ok: boolean; detail: string } {
    try {
      this.init();
      const got = this.getDek();
      if (!got) {
        const st = this.state;
        return { ok: false, detail: `DEK 不可用（status=${st.status}${st.detail ? '：' + st.detail : ''}）` };
      }

      const purpose = '__selftest__';
      const plain = `zentect-selftest-${Date.now()}`;
      const c1 = encodeV3(got.dek, got.dekId, purpose, plain);
      const c2 = encodeV3(got.dek, got.dekId, purpose, plain);
      if (c1 === c2 || c1.split(':')[2] === c2.split(':')[2]) {
        return { ok: false, detail: 'v3 自检失败：同明文两次加密得到相同 IV（N1 nonce 唯一性被破坏）' };
      }
      if (decodeV3(got.dek, purpose, c1) !== plain) {
        return { ok: false, detail: 'v3 自检失败：密文读不回明文' };
      }
      if (decodeV3(got.dek, `${purpose}-other`, c1) !== null) {
        return { ok: false, detail: 'v3 自检失败：purpose 不匹配仍能解开（N2 AAD 绑定被破坏）' };
      }
      return { ok: true, detail: 'v3 往返正常（已含 N1 IV 唯一性 / N2 AAD 绑定断言）' };
    } catch (err) {
      return { ok: false, detail: `v3 自检异常：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ---------------------------------------------------------------- 内部

  private setState(status: KeyStoreStatus, detail: string): KeyStoreState {
    this.state = {
      status,
      dekId: null,
      createdAt: null,
      recoveryAvailable: false,
      osWrapUsable: false,
      recoveryKeyBound: !!this.recoveryKey,
      filePath: this.filePath,
      detail,
    };
    return this.getState();
  }

  private createMasterKey(): void {
    const dek = crypto.randomBytes(DEK_BYTES);
    const wrapOs = this.wrapWithOs(dek);
    if (!wrapOs) {
      this.setState('no_usable_wrap',
        'master.key 不存在且 safeStorage 不可用：无法生成 wrap_os，故不落盘（避免造出无可用 wrap 的废密钥）');
      return;
    }

    const file: MasterKeyFile = {
      v: MASTER_KEY_VERSION,
      dekId: INITIAL_DEK_ID,
      createdAt: new Date().toISOString(),
      wrap_os: wrapOs,
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.writeAtomic(file);
    } catch (err) {
      this.setState('missing_master_key', `写入 master.key 失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    this.file = file;
    this.cachedDek = dek;
    this.state = {
      status: 'ready',
      dekId: file.dekId,
      createdAt: file.createdAt,
      recoveryAvailable: false,
      osWrapUsable: true,
      recoveryKeyBound: !!this.recoveryKey,
      filePath: this.filePath,
      detail: '',
    };
    AppLogger.info(LOG_TAGS.SYSTEM, `🔐 已生成凭据主密钥 master.key（dekId=${file.dekId}，DEK 已由 OS 级 KEK 包裹）`);
  }

  private loadMasterKey(): void {
    let parsed: MasterKeyFile;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as MasterKeyFile;
    } catch (err) {
      this.setState('corrupted_master_key', `master.key 读取/解析失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (
      !parsed || typeof parsed !== 'object'
      || parsed.v !== MASTER_KEY_VERSION
      || typeof parsed.dekId !== 'string' || !DEK_ID_PATTERN.test(parsed.dekId)
      || typeof parsed.createdAt !== 'string'
    ) {
      this.setState('corrupted_master_key', `master.key 结构非法（v=${(parsed as MasterKeyFile)?.v}，期望 v=${MASTER_KEY_VERSION}）`);
      return;
    }
    this.file = parsed;

    const osOk = this.unwrapOs() !== null;
    const recoveryAvailable = typeof parsed.wrap_recovery === 'string' && parsed.wrap_recovery.length > 0;
    const recOk = this.unwrapRecovery() !== null;

    if (!osOk && !recOk) {
      this.state = {
        status: 'no_usable_wrap',
        dekId: parsed.dekId,
        createdAt: parsed.createdAt,
        recoveryAvailable,
        osWrapUsable: false,
        recoveryKeyBound: !!this.recoveryKey,
        filePath: this.filePath,
        detail: recoveryAvailable
          ? 'wrap_os 不可用，且未绑定恢复密钥 —— 该 master.key 内的 DEK 本机不可解（恢复导出未启用）'
          : 'wrap_os 不可用，且 master.key 内不存在 wrap_recovery —— 无任何可用 wrap：凭据不可解，需重新填写',
      };
      return;
    }

    this.state = {
      status: 'ready',
      dekId: parsed.dekId,
      createdAt: parsed.createdAt,
      recoveryAvailable,
      osWrapUsable: osOk,
      recoveryKeyBound: !!this.recoveryKey,
      filePath: this.filePath,
      detail: osOk ? '' : 'wrap_os 不可用，已由恢复密钥解出 DEK',
    };
  }

  /** KEK-A：DEK 先转 base64 字符串再交给 safeStorage（**不可**把随机字节直接当 utf8 文本传入，会有损） */
  private wrapWithOs(dek: Buffer): string | null {
    try {
      if (safeStorage.isEncryptionAvailable() !== true) return null;
      return safeStorage.encryptString(dek.toString('base64')).toString('base64');
    } catch (err) {
      AppLogger.warn(LOG_TAGS.SYSTEM, 'wrap_os 生成失败', err);
      return null;
    }
  }

  private unwrapOs(): Buffer | null {
    const wrap = this.file?.wrap_os;
    if (!wrap) return null;
    try {
      if (safeStorage.isEncryptionAvailable() !== true) return null;
      const dek = Buffer.from(safeStorage.decryptString(Buffer.from(wrap, 'base64')), 'base64');
      return dek.length === DEK_BYTES ? dek : null;
    } catch {
      // 换 profile / 升级 Electron / 清 %APPDATA% ⇒ 正是今天这个故障；静默回落 KEK-B
      return null;
    }
  }

  private unwrapRecovery(): Buffer | null {
    const wrap = this.file?.wrap_recovery;
    if (!wrap || !this.recoveryKey) return null;
    return decodeWrapRecovery(this.recoveryKey, wrap);
  }

  private writeAtomic(file: MasterKeyFile): void {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}