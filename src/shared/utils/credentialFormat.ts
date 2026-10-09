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

/** 已知密文前缀（`v3:` 为 ADR-004 P1 已落的信封加密格式） */
export const ENCRYPTED_PREFIXES = ['v1:', 'v2:', 'v3:'] as const;

/**
 * v3 AAD 的 purpose 取值（ADR-004 §4.2）
 *
 * purpose 必须**与写入字段一一对应**并参与 GCM 认证 —— 它保证密文不可跨字段搬运：
 * 把 A 字段的密文塞进 B 字段，认证阶段就会失败（而不是被当成合法明文读出来）。
 * 新增 v3 写入字段时必须在这里登记，禁止在调用点手写裸字符串（否则口径漂移 = 静默失效）。
 */
export const CREDENTIAL_PURPOSE = {
  /** `api_profiles.api_key` 列 */
  apiProfileApiKey: 'api_profiles.api_key',
  /** `settings` 表敏感项：purpose 为 `settings:<configKey>` */
  settings: (configKey: string) => `settings:${configKey}`,
} as const;

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

/**
 * 凭据解密失败（fail-closed 专用异常，ADR-004 §4.3 / §4.4 G1·G2）
 *
 * 读路径（`CredentialManager.decrypt` → 各仓储 `safeDecrypt`）在遇到 `decrypt_failed` 时**抛本异常**，
 * 不再静默降级为空串 —— 空串会被上层当成「未配置」继续外发（本次 429 事故的形态）。
 * 调用方**禁止** catch 后继续外发；正确处置 = 告警 + 要求用户到 设置 → AI 重新填写。
 */
export class CredentialDecryptError extends Error {
  readonly reason: CredentialFailureReason;
  /** 出错的设置键名（密码学层不知道键名，故可选；仓储层抛出时必填） */
  readonly key?: string;

  constructor(reason: CredentialFailureReason, key?: string) {
    super(
      `凭据${key ? ` [${key}]` : ''}解密失败（reason=${reason}）：疑似跨 Electron 版本的旧数据或密钥不可用，` +
      '请到 设置 → AI 重新填写（已按 fail-closed 处理，绝不放行密文/空值）',
    );
    this.name = 'CredentialDecryptError';
    this.reason = reason;
    this.key = key;
  }
}

/**
 * 出站前 preflight 拦截异常（ADR-004 §4.4 G3）
 *
 * AI 服务客户端构造点（VLM/LLM）拿到凭据后、构造 adapter / 进批次循环前，
 * 凭据状态不是 `ok` 时**立即抛本异常** ⇒ ExceptionHub 归一化为 AI_AUTH_FAILED。
 * 绝不带着空 Key / 密文进批次循环（2026-09-25 连打 665 帧 → 429 封禁的教训）。
 */
export class AIAuthError extends Error {
  /** 出错的通道（deepseek / qwen / doubao / tencent / proxy …） */
  readonly provider: string;
  /** 任务场景标签（visual / script / translate / chat …），用于日志定位 */
  readonly taskLabel: string;
  /** 拦截时的凭据状态（decrypt_failed=已失效需重填；missing=从未配置） */
  readonly status: CredentialStatus;

  constructor(options: { provider: string; taskLabel: string; status: CredentialStatus }) {
    const { provider, taskLabel, status } = options;
    super(
      status === 'decrypt_failed'
        ? `AI 凭据已失效（provider=${provider}, ${taskLabel}）：解密失败，请到 设置 → AI 重新填写 API Key（出站前已拦截，未发起请求）`
        : `AI 凭据未配置（provider=${provider}, ${taskLabel}）：请在 设置 → AI 填写 API Key（出站前已拦截，未发起请求）`,
    );
    this.name = 'AIAuthError';
    this.provider = provider;
    this.taskLabel = taskLabel;
    this.status = status;
  }
}

/**
 * 出站前凭据断言（ADR-004 §4.4 G3，纯函数）
 *
 * 构造点调用方（`createAdapter` / `createFromConfig` / `ProviderManager.getLLMConfig`）
 * 在构造 AI 客户端**之前**调用，凭据非 `ok` 立即抛 `AIAuthError`、不进批次循环：
 * - `status === 'decrypt_failed'` ⇒ 抛（「已失效需重填」，**禁止**静默换通道/当未配置处理）
 * - `apiKey` 为空 ⇒ 抛（「未配置」，即使 status 未知也拦）
 * - status 未知但 Key 非空 ⇒ 放行（避免误伤显式填 Key 的自定义端点）
 */
export function assertOutboundCredential(opts: {
  provider: string;
  taskLabel: string;
  apiKey?: string | null;
  status?: CredentialStatus;
}): void {
  const { provider, taskLabel, apiKey, status } = opts;
  if (status === 'decrypt_failed') {
    throw new AIAuthError({ provider, taskLabel, status: 'decrypt_failed' });
  }
  if (!apiKey || apiKey.trim() === '') {
    throw new AIAuthError({ provider, taskLabel, status: status ?? 'missing' });
  }
}