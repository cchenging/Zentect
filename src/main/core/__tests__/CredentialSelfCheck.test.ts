// 📁 路径：src/main/core/__tests__/CredentialSelfCheck.test.ts
// 🔧 ADR-004 G5 回归锁定：启动期凭据自检
//
// 锁死三件事：
//   ① safeStorage 不可用时**必须产生启动期告警**（而不是静默 —— 这正是 429 事故的土壤）；
//   ② 加解密往返失败必须告警（凭据层整体损坏）；
//   ③ OS 级通道正常时不得误报；P1 起 `v3Available` 必须是 KeyStore 的**真实探测结果**
//      （数据根未注入时如实报未落，绝不伪造可用）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, safeStorage } from 'electron';
import { runCredentialSelfCheck } from '../CredentialSelfCheck';
import { PathManager } from '../../utils/pathManager';

const ss = safeStorage as unknown as Record<string, unknown>;

/** 恢复 setup.ts 给出的默认 mock（无 `isEncryptionAvailable` ⇒ 走 v1 回退） */
function resetSafeStorageMock(): void {
  delete ss.isEncryptionAvailable;
  ss.encryptString = vi.fn();
  ss.decryptString = vi.fn();
}

/** 可逆的假 OS 密钥链（P1：wrap_os 依赖它，故必须真能往返） */
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

describe('runCredentialSelfCheck — ADR-004 G5', () => {
  beforeEach(resetSafeStorageMock);
  afterEach(resetSafeStorageMock);

  it('safeStorage 不可用 ⇒ 现役通道回落 v1、往返仍成功，但必须产生启动期告警', () => {
    const report = runCredentialSelfCheck('probe-1');

    expect(report.safeStorageAvailable).toBe(false);
    expect(report.activeChannel).toBe('v1');
    expect(report.roundTripOk).toBe(true);
    expect(report.v3Available).toBe(false);
    expect(report.userDataPath).toBe('/mock/app/path');
    expect(report.problems.some((p) => p.includes('safeStorage 不可用'))).toBe(true);
  });

  it('OS 级通道正常 ⇒ 现役通道 v2、无告警，且如实报告 v3 未落', () => {
    ss.isEncryptionAvailable = vi.fn(() => true);
    ss.encryptString = vi.fn((t: string) => Buffer.from(`enc:${t}`));
    ss.decryptString = vi.fn((b: Buffer) => b.toString().replace(/^enc:/, ''));

    const report = runCredentialSelfCheck('probe-2');

    expect(report.safeStorageAvailable).toBe(true);
    expect(report.safeStorageRoundTripOk).toBe(true);
    expect(report.activeChannel).toBe('v2');
    expect(report.roundTripOk).toBe(true);
    expect(report.v3Available).toBe(false);
    expect(report.problems).toEqual([]);
  });

  it('safeStorage 可用但往返被破坏 ⇒ 告警（不得因为 isEncryptionAvailable=true 就放行）', () => {
    ss.isEncryptionAvailable = vi.fn(() => true);
    ss.encryptString = vi.fn((t: string) => Buffer.from(`enc:${t}`));
    ss.decryptString = vi.fn(() => 'MISMATCH');

    const report = runCredentialSelfCheck('probe-3');

    expect(report.safeStorageAvailable).toBe(true);
    expect(report.safeStorageRoundTripOk).toBe(false);
    expect(report.roundTripOk).toBe(false);
    expect(report.problems.filter((p) => p.includes('往返')).length).toBe(2);
  });

  it('userData 路径读取失败 ⇒ 告警且不抛（自检本身不得阻断启动）', () => {
    vi.mocked(app.getPath).mockImplementationOnce(() => {
      throw new Error('no userData');
    });

    const report = runCredentialSelfCheck('probe-4');
    expect(report.userDataPath).toBe('');
    expect(report.problems.some((p) => p.includes('userData'))).toBe(true);
  });

  it('P1：数据根就绪 + OS 通道可用 ⇒ v3Available 是真实探测结果（首启即生成 master.key 并往返成功）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentect-selfcheck-'));
    const spy = vi.spyOn(PathManager, 'getUserDataPath').mockReturnValue(dir);
    enableSafeStorage();

    try {
      const report = runCredentialSelfCheck('probe-v3');

      expect(report.v3Available).toBe(true);
      expect(report.keyStoreStatus).toBe('ready');
      expect(report.masterKeyPath).toBe(path.join(dir, 'keys', 'master.key'));
      expect(report.v3Detail).toContain('v3 往返正常');
      expect(report.problems).toEqual([]);
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P1：master.key 损坏时启动即告警（不得静默，也不得崩）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentect-selfcheck-'));
    fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'keys', 'master.key'), 'not-json', 'utf8');
    const spy = vi.spyOn(PathManager, 'getUserDataPath').mockReturnValue(dir);
    enableSafeStorage();

    try {
      const report = runCredentialSelfCheck('probe-broken');

      expect(report.v3Available).toBe(false);
      expect(report.keyStoreStatus).toBe('corrupted_master_key');
      expect(report.problems.some((p) => p.includes('v3 密钥仓库异常'))).toBe(true);
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});