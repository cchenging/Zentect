// 📁 路径：src/main/core/__tests__/CredentialSelfCheck.test.ts
// 🔧 ADR-004 G5 回归锁定：启动期凭据自检
//
// 锁死三件事：
//   ① safeStorage 不可用时**必须产生启动期告警**（而不是静默 —— 这正是 429 事故的土壤）；
//   ② 加解密往返失败必须告警（凭据层整体损坏）；
//   ③ OS 级通道正常时不得误报，且如实报告 v3/KeyStore 未落（P0 不伪造 v3 可用）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { app, safeStorage } from 'electron';
import { runCredentialSelfCheck } from '../CredentialSelfCheck';

const ss = safeStorage as unknown as Record<string, unknown>;

/** 恢复 setup.ts 给出的默认 mock（无 `isEncryptionAvailable` ⇒ 走 v1 回退） */
function resetSafeStorageMock(): void {
  delete ss.isEncryptionAvailable;
  ss.encryptString = vi.fn();
  ss.decryptString = vi.fn();
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
});