// 📁 路径: src/main/utils/crypto.ts
import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import { safeStorage } from 'electron';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { KeyStore, encodeV3, decodeV3 } from '../../modules/infra/security/KeyStore';

// ⚠️ 安全注意：以下硬编码值仅作为 safeStorage 不可用时的回退方案
// Electron 桌面应用打包后无法读取环境变量，因此保留硬编码回退
// 生产环境中 safeStorage（OS 密钥链）始终优先（v2 格式），v1 仅用于兼容旧数据
function deriveLegacyKey(secret: string): Buffer {
  return crypto.scryptSync(
    os.userInfo().username + os.arch() + os.platform() + secret,
    'salt_magic_2026', // 回退盐值，safeStorage 可用时不会使用
    32
  );
}

/** 所有历史遗留密钥（按优先级从上到下尝试解密），仅用于 v1 格式兼容 */
const LEGACY_SECRETS = [
  'Zentect_Studio_Secret',    // 当前密钥
  'MagicOne_Studio_Secret',   // 项目改名前的旧密钥
];

function getLegacyKey(): Buffer {
  return deriveLegacyKey(LEGACY_SECRETS[0]);
}

const LEGACY_ALGORITHM = 'aes-256-gcm';

/**
 * v3 通道开关（ADR-004 §5 P1）：缺省 on；`ZENTECT_CRED_V3=0|false` 关闭并整体回退旧通道
 *
 * ⚠️ 关闭只影响**新写入**：已落库的 v3 密文在读取路径上仍按优先级尝试（否则会读不出自己的数据）。
 */
export function isV3Enabled(): boolean {
  const v = process.env.ZENTECT_CRED_V3;
  return !(v === '0' || v === 'false');
}

/**
 * 历史通道加密（v2 → v1）—— 保持原样，未传 purpose 时**完全走这条路**
 *
 * 使用 Electron safeStorage 加密（OS 级密钥链），回退到基于 scrypt 的 AES-256-GCM 加密
 */
function encryptLegacy(text: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(text);
      return 'v2:' + encrypted.toString('base64');
    }
  } catch {
    // 回退到传统方式
  }

  try {
    const iv = crypto.randomBytes(12);
    const key = getLegacyKey();
    const cipher = crypto.createCipheriv(LEGACY_ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `v1:${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch {
    return '';
  }
}

/**
 * 加密（ADR-004 §4.2）
 *
 * - **传 `purpose`**：走 v3 信封加密（AES-256-GCM + dekId + random 12B IV，purpose 作 AAD）。
 *   v3 写入路径**必须**有 purpose —— 少了 AAD 就失去「密文不可跨字段搬运」这一层保护，
 *   故无 purpose 时根本不会产出 v3 密文（结构性保证，不靠调用方自觉）。
 * - **不传 `purpose`**：完全保持历史行为（v2 → v1），故未接线的调用方线上零变化。
 *
 * DEK 不可用时**抛错**（fail-closed）：绝不静默降级成 v2 —— 那正是 D1「唯一钥匙托管在会消失的目录」的老路。
 */
export function encryptData(text: string, purpose?: string): string {
  if (!purpose) return encryptLegacy(text);

  if (!isV3Enabled()) return encryptLegacy(text);

  const store = KeyStore.getInstance();
  const got = store.getDek();
  if (!got) {
    const st = store.getState();
    throw new Error(
      `v3 加密失败：DEK 不可用（status=${st.status}${st.detail ? '：' + st.detail : ''}）。` +
      '按 fail-closed 处理，不回退 v2（v2 依赖会消失的 Chromium profile）',
    );
  }
  return encodeV3(got.dek, got.dekId, purpose, text);
}

/**
 * 解密（ADR-004 §4.3）：优先级 **v3(DEK) → v2(safeStorage) → v1(legacy 派生)**
 *
 * 返回规则（与历史完全一致，便于上层统一处置）：
 * - 解密成功 → 返回明文
 * - 解密失败 → 返回原值 text（`classifyCredential` 据此归为 `decrypt_failed`，绝不把密文当明文外发）
 * - 空值/非加密格式 → 原样返回
 *
 * ⚠️ v3 密文的 AAD 由 `purpose` 参与认证，故**读 v3 必须传与写入时相同的 purpose**；
 *    缺 purpose / purpose 不符 / 密钥不符 / 数据损坏 一律返回原密文（fail-closed），不抛异常。
 * ⚠️ v1/v2 是**不带 AAD** 的旧格式，解密时不存在 AAD 参与，故迁移期（§4.3 ②）现有 5 条密文不受影响。
 */
export function decryptData(text: string, purpose?: string): string {
  if (!text || text === '') return text;

  // ① v3：信封加密（唯一带 AAD 的格式）
  if (text.startsWith('v3:')) {
    if (!purpose) {
      AppLogger.warn(LOG_TAGS.SYSTEM, 'v3 密文解密时未提供 purpose，无法校验 AAD —— 按 fail-closed 处理');
      return text;
    }
    const got = KeyStore.getInstance().getDek();
    if (!got) {
      AppLogger.warn(LOG_TAGS.SYSTEM, 'v3 密文解密失败：DEK 不可用（master.key 缺失/损坏或两个 wrap 均失效）');
      return text;
    }
    const plain = decodeV3(got.dek, purpose, text);
    if (plain === null) {
      AppLogger.warn(LOG_TAGS.SYSTEM, 'v3 密文认证失败（密钥不符 / purpose 不符的跨字段搬运 / 数据损坏）');
      return text;
    }
    return plain;
  }

  // ② v2：OS 级密钥链（历史主通道，D1 的根因所在）
  try {
    if (text.startsWith('v2:')) {
      if (safeStorage.isEncryptionAvailable()) {
        const buffer = Buffer.from(text.slice(3), 'base64');
        return safeStorage.decryptString(buffer);
      }
      AppLogger.warn(LOG_TAGS.SYSTEM, 'safeStorage 不可用，v2 格式数据无法解密');
      return text;
    }
  } catch (err) {
    AppLogger.warn(LOG_TAGS.SYSTEM, 'v2 格式解密失败（可能为跨 Electron 版本的旧数据）', err);
    return text;
  }

  // ③ v1：legacy scrypt 派生（无 AAD，跨 profile 稳定但强度最低，仅兼容历史数据）
  try {
    const payload = text.startsWith('v1:') ? text.slice(3) : text;
    const parts = payload.split(':');
    if (parts.length !== 3) return text;
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    // 按优先级依次尝试所有历史密钥
    for (const secret of LEGACY_SECRETS) {
      try {
        const key = deriveLegacyKey(secret);
        const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      } catch {
        continue;  // 密钥不匹配，试下一个
      }
    }

    return text;  // 所有密钥都无法解密
  } catch {
    return text;
  }
}

/**
 * 💥 工业级规范：状态哈希生成器 (State Hash Generator)
 * 用于计算 L2 缓存的唯一指纹。只要参数不变，指纹永远一致。
 * @param args 需要参与计算的参数集合 (如算力版本、路径、fps、策略等)
 * @returns 8位 MD5 短哈希值
 */
export function generateStateHash(...args: any[]): string {
  const hash = crypto.createHash('md5');
  // 将所有参数序列化后推入 hash 引擎
  const payload = JSON.stringify(args);
  hash.update(payload);
  // 取前 8 位即可满足本地工程级节点的绝对唯一性，并保持文件夹路径清爽
  return hash.digest('hex').substring(0, 8);
}

// 💥 核心架构升级：将霸占线程的读取彻底改为异步流（Stream）
export async function getFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // 创建哈希计算器
    const hash = crypto.createHash('md5'); // 或 'sha256'，保持您原有的算法不变
    
    // 创建仅占极小内存的只读流
    const stream = fs.createReadStream(filePath);

    // 像流水线一样，每次只处理一小块数据（chunk），绝不阻塞主线程
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * 💥 生成全局唯一标识符 (UUID)
 * 使用加密安全的随机数生成
 * @returns 36位标准 UUID 字符串
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}
