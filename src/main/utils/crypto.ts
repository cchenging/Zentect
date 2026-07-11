// 📁 路径: src/main/utils/crypto.ts
import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import { safeStorage } from 'electron';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';

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
 * 使用 Electron safeStorage 加密（OS 级密钥链）
 * 回退到基于 scrypt 的 AES-256-GCM 加密
 */
export function encryptData(text: string): string {
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
 * 解密 Electron safeStorage 加密的数据
 * 兼容 v1（传统 AES）和 v2（OS 密钥链）格式
 *
 * 返回规则：
 * - 解密成功 → 返回明文
 * - 解密失败 → 返回原值 text（调用方应自行判断 looksEncrypted 并降级处理）
 * - 空值/非加密格式 → 原样返回
 */
export function decryptData(text: string): string {
  if (!text || text === '') return text;

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
