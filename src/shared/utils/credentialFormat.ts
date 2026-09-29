// 📁 路径：src/shared/utils/credentialFormat.ts
// 凭据值「形态判定」与「解密结果归类」——ADR-004 §4.3 / §4.4 G2·G4
//
// ⚠️ 定位（ADR-004 N3）：本模块只是 **sanity check**，不承担密码学校验职责。
//    真正的密码学边界是 AEAD auth tag 校验失败（由 crypto 层判定），本模块只负责
//    「形态像不像密文」与「解密结果该归类成哪种状态」。
//
// 为什么放在 shared：主进程仓储（ApiProfileRepository）与渲染进程 UI（AITab）都要用，
//   必须**同一份实现**，否则各处正则漂移 ⇒ 守卫口径不一致（G2 明确要求「三处同口径」）。

export type CredentialStatus = 'ok' | 'missing' | 'decrypt_failed';

export type CredentialFailureReason = 'key_mismatch' | 'corrupted' | 'unsupported_version';

/**
 * 凭据读取结果（判别联合，ADR-004 §4.3）
 *
 * 调用方禁止用 `if (!apiKey)` 式模糊判断 —— 空字符串既可能是「从未配置」，
 * 也可能是「配置了但解不开」，二者处置方式完全不同（后者必须告警并要求重填）。
 */
export type CredentialResult =
  | { status: 'ok'; value: string }
  | { status: 'missing' }
  | { status: 'decrypt_failed'; reason: CredentialFailureReason };

/** 已知密文前缀（`v3:` 为 ADR-004 预留格式，尚未产出，但须识别以防误当明文落库） */
export const ENCRYPTED_PREFIXES = ['v1:', 'v2:', 'v3:'] as const;

/**
 * 判断字符串「看起来像」密文
 *
 * 支持两种历史形态：
 * - 前缀格式：`v1:` / `v2:` / `v3:`
 * - 旧版无前缀三段 hex：`iv:authTag:ciphertext`
 */
export function looksEncryptedValue(val: string): boolean {
  if (!val) return false;
  if (ENCRYPTED_PREFIXES.some((p) => val.startsWith(p))) return true;
  const parts = val.split(':');
  return parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
}

/**
 * 把「取库原值 + 解密函数返回值」归类为 CredentialResult
 *
 * 判定口径：
 * - 原值为空 ⇒ `missing`
 * - 原值不像密文 ⇒ `ok` 且返回原值（明文旧数据 / 非加密值，历史上确实存在）
 * - 原值像密文且解出了明文 ⇒ `ok`
 * - 原值像密文但解不出来（返回值仍为原值 / 仍像密文 / 为空）⇒ `decrypt_failed`
 *
 * `reason` 说明：解不开的密文无法区分「密钥不对」与「数据损坏」——GCM tag 失败同时覆盖
 * 两种成因，故统一归类为 `key_mismatch`；`corrupted` 仅在调用方捕获到解析异常时使用。
 */
export function classifyCredential(raw: string, decrypted: string): CredentialResult {
  if (!raw || raw.trim() === '') return { status: 'missing' };
  if (!looksEncryptedValue(raw)) return { status: 'ok', value: raw };
  if (decrypted && decrypted !== raw && !looksEncryptedValue(decrypted)) {
    return { status: 'ok', value: decrypted };
  }
  return { status: 'decrypt_failed', reason: 'key_mismatch' };
}