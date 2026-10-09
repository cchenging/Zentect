// 📁 路径：src/modules/infra/security/__tests__/KeyStore.v3.test.ts
// 🔧 ADR-004 P1 回归锁定：信封加密（v3）+ 双 wrap 密钥仓库
//
// 覆盖矩阵（P1 规格 T1~T6 / T10；T7~T9 的 v1/v2→v3 迁移属 P2，不在此文件）：
//   T1  v3 往返 / T2 nonce 唯一（N1） / T3 AAD 绑定（N2）
//   T4  wrap_os 失效回落 wrap_recovery / T5 双 wrap 皆失效 ⇒ getDek() === null
//   T6  master.key 缺失或损坏 ⇒ 不崩、不覆盖、不吐明文
//   T10 init 幂等（绝不重新生成 DEK）
//
// 另加「零行为变化」锁：未传 purpose 时 encryptData 绝不产出 v3。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { safeStorage } from 'electron';
import {
  KeyStore,
  encodeV3,
  decodeV3,
  encodeWrapRecovery,
  MASTER_KEY_VERSION,
  type MasterKeyFile,
} from '../KeyStore';
import { encryptData, decryptData, isV3Enabled } from '../../../../main/utils/crypto';
import { CredentialManager } from '../CredentialManager';
import { CREDENTIAL_PURPOSE } from '../../../../shared/utils/credentialFormat';

const ss = safeStorage as unknown as Record<string, unknown>;
const PURPOSE = CREDENTIAL_PURPOSE.apiProfileApiKey;

/** 可逆的假 OS 密钥链（真实 safeStorage 在 node 环境不存在） */
const xor = (b: Buffer): Buffer => {
  const out = Buffer.from(b);
  for (let i = 0; i < out.length; i++) out[i] ^= 0x5a;
  return out;
};

function enableSafeStorage(): void {
  ss.isEncryptionAvailable = vi.fn(() => true);
  ss.encryptString = vi.fn((t: string) => xor(Buffer.from(t, 'utf8')));
  ss.decryptString = vi.fn((b: Buffer) => xor(b).toString('utf8'));
}

/** 模拟「Chromium profile 被重建」：OS 通道整体失效（今天那次故障的形态） */
function disableSafeStorage(): void {
  ss.isEncryptionAvailable = vi.fn(() => false);
  ss.encryptString = vi.fn();
  ss.decryptString = vi.fn();
}

const masterKeyPathOf = (dir: string): string => path.join(dir, 'keys', 'master.key');
const readMasterKey = (dir: string): MasterKeyFile =>
  JSON.parse(fs.readFileSync(masterKeyPathOf(dir), 'utf8')) as MasterKeyFile;

describe('KeyStore + v3 信封加密 — ADR-004 P1', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentect-keys-'));
    enableSafeStorage();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ZENTECT_CRED_V3;
  });

  // ---------------------------------------------------------------- T1

  it('T1 v3 往返：master.key 首启生成（只存 wrap_os，绝不存明文 DEK），加解密闭环', () => {
    const store = KeyStore.getInstance();
    const state = store.init(dir);

    expect(state.status).toBe('ready');
    expect(state.dekId).toBe('01');
    expect(state.filePath).toBe(masterKeyPathOf(dir));

    // master.key 落盘内容：结构正确、且**不含明文 DEK**（决定性约束）
    const raw = fs.readFileSync(masterKeyPathOf(dir), 'utf8');
    const file = JSON.parse(raw) as MasterKeyFile;
    expect(file.v).toBe(MASTER_KEY_VERSION);
    expect(typeof file.wrap_os).toBe('string');
    expect(file.wrap_recovery).toBeUndefined();

    const got = store.getDek();
    expect(got).not.toBeNull();
    expect(got!.dek.length).toBe(32);
    expect(raw).not.toContain(got!.dek.toString('hex'));
    expect(raw).not.toContain(got!.dek.toString('base64'));

    // 编解码原语往返
    const cipher = encodeV3(got!.dek, got!.dekId, PURPOSE, 'sk-p1-roundtrip');
    expect(cipher.startsWith(`v3:${got!.dekId}:`)).toBe(true);
    expect(decodeV3(got!.dek, PURPOSE, cipher)).toBe('sk-p1-roundtrip');

    // 通道层往返（crypto.ts 走 v3 → 读回明文）
    const viaChannel = encryptData('sk-p1-channel', PURPOSE);
    expect(viaChannel.startsWith('v3:')).toBe(true);
    expect(decryptData(viaChannel, PURPOSE)).toBe('sk-p1-channel');

    expect(store.selfTest().ok).toBe(true);
  });

  it('零行为变化锁：未传 purpose 时绝不产出 v3（历史 v2/v1 通道原样）', () => {
    KeyStore.getInstance().init(dir);

    const legacy = encryptData('sk-legacy-path');
    expect(legacy).toMatch(/^v[12]:/);
    expect(legacy.startsWith('v3:')).toBe(false);
    expect(decryptData(legacy)).toBe('sk-legacy-path');

    // 开关关闭时，即使传了 purpose 也回退旧通道
    process.env.ZENTECT_CRED_V3 = '0';
    expect(isV3Enabled()).toBe(false);
    expect(encryptData('sk-switch-off', PURPOSE)).toMatch(/^v[12]:/);
  });

  // ---------------------------------------------------------------- T2

  it('T2 N1 nonce 唯一：同明文同 purpose 两次加密 ⇒ IV 与密文均不同', () => {
    const store = KeyStore.getInstance();
    store.init(dir);
    const got = store.getDek()!;

    const c1 = encodeV3(got.dek, got.dekId, PURPOSE, 'sk-same-plaintext');
    const c2 = encodeV3(got.dek, got.dekId, PURPOSE, 'sk-same-plaintext');

    expect(c1).not.toBe(c2);
    expect(c1.split(':')[2]).not.toBe(c2.split(':')[2]);  // IV 段
    expect(Buffer.from(c1.split(':')[2], 'base64url').length).toBe(12);
    expect(decodeV3(got.dek, PURPOSE, c2)).toBe('sk-same-plaintext');
  });

  // ---------------------------------------------------------------- T3

  it('T3 N2 AAD 绑定：purpose 不符（密文横向搬运）⇒ 认证失败，不吐明文', () => {
    const store = KeyStore.getInstance();
    store.init(dir);

    const cipher = encryptData('sk-belongs-to-api-profile', PURPOSE);

    // 原始语义：换 purpose 解不开
    expect(decodeV3(store.getDek()!.dek, 'settings:logPath', cipher)).toBeNull();
    // 通道语义：返回原密文（上层 classifyCredential ⇒ decrypt_failed，绝不外发密文）
    expect(decryptData(cipher, 'settings:logPath')).toBe(cipher);
    // 缺 purpose 同样不放行
    expect(decryptData(cipher)).toBe(cipher);
    // 正确 purpose 才放行
    expect(decryptData(cipher, PURPOSE)).toBe('sk-belongs-to-api-profile');

    // CredentialManager 层面的判别联合（G1 口径复用）
    const mgr = CredentialManager.getInstance();
    expect(mgr.decrypt(cipher, 'settings:logPath')).toEqual({ status: 'decrypt_failed', reason: 'key_mismatch' });
    expect(mgr.decrypt(cipher, PURPOSE)).toEqual({ status: 'ok', value: 'sk-belongs-to-api-profile' });
  });

  // ---------------------------------------------------------------- T4

  it('T4 wrap_os 失效 ⇒ 由 wrap_recovery 解出同一把 DEK（Tier 1 恢复路径可走通）', () => {
    const store = KeyStore.getInstance();
    store.init(dir);
    const originalDek = store.getDek()!;

    // 造出恢复材料：把 DEK 用随机恢复密钥包一份写进 master.key（P3 的 Recovery Kit 产出物）
    const recoveryKey = crypto.randomBytes(32);
    const file = readMasterKey(dir);
    file.wrap_recovery = encodeWrapRecovery(recoveryKey, originalDek.dek);
    fs.writeFileSync(masterKeyPathOf(dir), JSON.stringify(file, null, 2), 'utf8');

    // 模拟 profile 重建：OS 通道整体失效，master.key 仍在
    disableSafeStorage();
    store.bindRecovery(recoveryKey);
    const state = store.init(dir);

    expect(state.status).toBe('ready');
    expect(state.osWrapUsable).toBe(false);
    expect(state.recoveryAvailable).toBe(true);
    expect(state.detail).toContain('恢复密钥');

    const recovered = store.getDek();
    expect(recovered).not.toBeNull();
    expect(recovered!.dek.equals(originalDek.dek)).toBe(true);
    expect(recovered!.dekId).toBe(originalDek.dekId);

    // 恢复出的 DEK 能解开 OS 通道失效之前写下的 v3 密文
    const cipher = encodeV3(originalDek.dek, originalDek.dekId, PURPOSE, 'sk-before-profile-loss');
    expect(decodeV3(recovered!.dek, PURPOSE, cipher)).toBe('sk-before-profile-loss');

    // 且恢复密钥本身不是公开可推导量：错误的恢复密钥解不开
    store.bindRecovery(crypto.randomBytes(32));
    expect(store.init(dir).status).toBe('no_usable_wrap');
  });

  // ---------------------------------------------------------------- T5

  it('T5 两个 wrap 皆失效 ⇒ getDek() === null（不抛异常），通道层 fail-closed', () => {
    const store = KeyStore.getInstance();
    store.init(dir);

    disableSafeStorage();
    store.bindRecovery(crypto.randomBytes(32));   // 恢复密钥与 master.key 内的 wrap 不匹配
    const file = readMasterKey(dir);
    file.wrap_recovery = encodeWrapRecovery(crypto.randomBytes(32), crypto.randomBytes(32));
    fs.writeFileSync(masterKeyPathOf(dir), JSON.stringify(file, null, 2), 'utf8');

    const state = store.init(dir);
    expect(state.status).toBe('no_usable_wrap');
    expect(store.getDek()).toBeNull();
    expect(store.selfTest().ok).toBe(false);
    expect(store.selfTest().detail).toContain('DEK 不可用');

    // 加密 fail-closed：不静默降级成 v2（那正是 D1 的老路）
    expect(() => encryptData('sk-write-when-broken', PURPOSE)).toThrow(/DEK 不可用/);
  });

  // ---------------------------------------------------------------- T6

  it('T6a master.key 损坏 ⇒ corrupted 状态、不崩、不改写文件、不吐明文', () => {
    fs.mkdirSync(path.dirname(masterKeyPathOf(dir)), { recursive: true });
    fs.writeFileSync(masterKeyPathOf(dir), '{ this is not json', 'utf8');

    const store = KeyStore.getInstance();
    const state = store.init(dir);

    expect(state.status).toBe('corrupted_master_key');
    expect(store.getDek()).toBeNull();
    expect(store.selfTest().ok).toBe(false);
    // 绝不覆盖：脏文件仍在原地（用户还可能靠 Recovery Kit 救回）
    expect(fs.readFileSync(masterKeyPathOf(dir), 'utf8')).toBe('{ this is not json');
  });

  it('T6b master.key 结构非法（版本/字段不对）⇒ corrupted，不崩', () => {
    fs.mkdirSync(path.dirname(masterKeyPathOf(dir)), { recursive: true });
    fs.writeFileSync(masterKeyPathOf(dir), JSON.stringify({ v: 2, wrap_os: 'x' }), 'utf8');

    const store = KeyStore.getInstance();
    expect(store.init(dir).status).toBe('corrupted_master_key');
    expect(store.getDek()).toBeNull();
  });

  it('T6c 首启但 OS 通道不可用 ⇒ 拒绝落盘（不造无可用 wrap 的废密钥），不崩', () => {
    disableSafeStorage();
    const store = KeyStore.getInstance();
    const state = store.init(dir);

    expect(state.status).toBe('no_usable_wrap');
    expect(store.getDek()).toBeNull();
    expect(fs.existsSync(masterKeyPathOf(dir))).toBe(false);
  });

  it('T6d 未注入数据根目录 ⇒ 如实报缺失，绝不拼路径、绝不崩', () => {
    const store = KeyStore.getInstance();
    const state = store.init('');

    expect(state.status).toBe('missing_master_key');
    expect(state.filePath).toBe('');
    expect(store.getDek()).toBeNull();
    expect(store.selfTest().ok).toBe(false);
  });

  // ---------------------------------------------------------------- T10

  it('T10 init 幂等：重复初始化不重新生成 DEK、不改写 master.key', () => {
    const store = KeyStore.getInstance();
    const first = store.init(dir);
    const firstRaw = fs.readFileSync(masterKeyPathOf(dir), 'utf8');
    const firstDek = store.getDek()!;

    const second = store.init(dir);

    expect(second.status).toBe('ready');
    expect(second.dekId).toBe(first.dekId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(fs.readFileSync(masterKeyPathOf(dir), 'utf8')).toBe(firstRaw);
    expect(store.getDek()!.dek.equals(firstDek.dek)).toBe(true);

    // 换目录 = 换钥匙库（测试用例之间不串状态）
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentect-keys-other-'));
    try {
      const other = store.init(otherDir);
      expect(other.status).toBe('ready');
      expect(store.getDek()!.dek.equals(firstDek.dek)).toBe(false);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});