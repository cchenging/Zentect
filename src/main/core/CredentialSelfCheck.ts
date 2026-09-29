// 📁 路径：src/main/core/CredentialSelfCheck.ts
// ADR-004 §4.4 G5：启动期凭据自检
//
// 为什么要自检：凭据一旦在启动时就不可读写，用户看到的会是「到处 401 / 空 Key」，
// 排查成本极高（2026-09-25 那次连打 665 帧 → 429 封禁就是这种形态）。故在启动期主动打印
// 四项事实并**立即告警**，把问题暴露在第一屏日志里：
//   ① 数据目录（userData）实际路径
//   ② OS 级通道（safeStorage / v2；将来 v3 的 wrap_os 依赖它）是否可用
//   ③ 一次真实的加解密往返是否成功
//   ④ 当前实际生效的通道 + v3/KeyStore（P1）是否已落
//
// ⚠️ 本自检**不引入新格式**（P0 约束）：v3/KeyStore 属 P1，未落时如实报告，不伪造可用。
//    G5 与 G1/G2/G3 一样**不受 `ZENTECT_CRED_V3` 开关控制**，任何档位都必须生效。

import { app, safeStorage } from 'electron';
import { encryptData, decryptData } from '../utils/crypto';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';

/** 当前实际生效的凭据通道 */
export type CredentialChannel = 'v2' | 'v1' | 'none';

export interface CredentialSelfCheckReport {
  /** 数据目录实际路径（DB / master.key 都在这一层） */
  userDataPath: string;
  /** OS 级通道（safeStorage / v2）是否可用 */
  safeStorageAvailable: boolean;
  /** OS 级通道的一次真实往返是否成功（仅当 `safeStorageAvailable` 为真时才有意义） */
  safeStorageRoundTripOk: boolean;
  /** 现役通道：`encryptData` 实际选中的格式 */
  activeChannel: CredentialChannel;
  /** 一次加解密往返是否成功（失败 ⇒ 所有凭据读写都会异常） */
  roundTripOk: boolean;
  /** v3 / KeyStore（P1）是否已落 —— P0 阶段恒 false，仅做「未落」可见化，不用它做判定 */
  v3Available: boolean;
  /** 需要启动期告警的问题项（空数组 = 一切正常） */
  problems: string[];
}

/**
 * 执行启动期凭据自检（纯读取，不写库、不改任何凭据）
 *
 * @param probeText 可选：自检探针明文（默认自动生成，仅在测试中显式传入）
 */
export function runCredentialSelfCheck(probeText?: string): CredentialSelfCheckReport {
  const problems: string[] = [];

  let userDataPath = '';
  try {
    userDataPath = app.getPath('userData');
  } catch (err) {
    problems.push(`无法解析 userData 路径：${(err as Error)?.message ?? err}`);
  }

  // ① OS 级通道可用性 + 真实往返（将来 v3 的 wrap_os 同样依赖 safeStorage）
  let safeStorageAvailable = false;
  let safeStorageRoundTripOk = false;
  const osProbe = 'zentect-selfcheck-os';
  try {
    safeStorageAvailable = safeStorage.isEncryptionAvailable() === true;
    if (safeStorageAvailable) {
      safeStorageRoundTripOk = safeStorage.decryptString(safeStorage.encryptString(osProbe)) === osProbe;
    }
  } catch (err) {
    safeStorageAvailable = false;
    safeStorageRoundTripOk = false;
    AppLogger.warn(LOG_TAGS.BOOTSTRAP, `[凭据自检] safeStorage 探测异常：${(err as Error)?.message ?? err}`);
  }
  if (!safeStorageAvailable) {
    problems.push(
      'safeStorage 不可用：OS 级通道（v2 密文 / 将来的 v3 wrap_os）失效。' +
      '现役回退通道仍可运行，但换 profile、重装或换机后 v2 密文将无法解开，请尽快到 设置 → AI 重新填写 API Key',
    );
  } else if (!safeStorageRoundTripOk) {
    problems.push('safeStorage 可用但加解密往返失败：OS 级通道已损坏，凭据可能整体不可读');
  }

  // ② 加解密往返自检（走当前最优通道，即真实运行时会用的那条路）
  const probe = probeText ?? `zentect-selfcheck-${Date.now()}`;
  let activeChannel: CredentialChannel = 'none';
  let roundTripOk = false;
  try {
    const cipher = encryptData(probe);
    if (cipher.startsWith('v2:')) activeChannel = 'v2';
    else if (cipher.startsWith('v1:')) activeChannel = 'v1';
    roundTripOk = !!cipher && decryptData(cipher) === probe;
  } catch (err) {
    problems.push(`加解密往返自检抛出异常：${(err as Error)?.message ?? err}`);
  }
  if (activeChannel === 'none') {
    problems.push('加解密自检未产出任何格式的密文：凭据层完全不可用，任何 API Key 都无法安全落库');
  } else if (!roundTripOk) {
    problems.push(`加解密往返自检失败（现役通道 ${activeChannel}）：写入的密文读不回明文，凭据层已损坏`);
  }

  // ③ v3 / KeyStore 状态（P1）—— 如实报告，不用它做判定
  const v3Available = false;

  return {
    userDataPath,
    safeStorageAvailable,
    safeStorageRoundTripOk,
    activeChannel,
    roundTripOk,
    v3Available,
    problems,
  };
}