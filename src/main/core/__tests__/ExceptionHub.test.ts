// 📁 路径：src/main/core/__tests__/ExceptionHub.test.ts
// Layer 5 异常归一化单元测试
import { describe, it, expect } from 'vitest';
import { ExceptionHub } from '../ExceptionHub';
import { ErrorCode } from '@modules/infra/error/AppError';
import { AIAuthError, CredentialDecryptError } from '../../../shared/utils/credentialFormat';

describe('ExceptionHub', () => {
  it('401 错误应归一化为鉴权失败', () => {
    const payload = ExceptionHub.normalize(new Error('HTTP 401 Unauthorized'));
    expect(payload.code).toBe(ErrorCode.SYS_ENV_ERROR);
    expect(payload.titleKey).toBe('engine_errors.AI_AUTH_FAILED_TITLE');
    expect(payload.promptKey).toBe('engine_errors.AI_AUTH_FAILED_PROMPT');
  });

  it('API Key 错误应归一化为鉴权失败', () => {
    const payload = ExceptionHub.normalize(new Error('Invalid api key provided'));
    expect(payload.code).toBe(ErrorCode.SYS_ENV_ERROR);
    expect(payload.titleKey).toBe('engine_errors.AI_AUTH_FAILED_TITLE');
  });

  it('429 错误应归一化为服务超限', () => {
    const payload = ExceptionHub.normalize(new Error('HTTP 429 Rate limit exceeded'));
    expect(payload.code).toBe(ErrorCode.AI_PROCESS_FAILED);
    expect(payload.titleKey).toBe('engine_errors.AI_QUOTA_LIMIT_TITLE');
  });

  it('quota 错误应归一化为服务超限', () => {
    const payload = ExceptionHub.normalize(new Error('Insufficient quota'));
    expect(payload.titleKey).toBe('engine_errors.AI_QUOTA_LIMIT_TITLE');
  });

  it('timeout 错误应归一化为网络超时', () => {
    const payload = ExceptionHub.normalize(new Error('Request timeout after 30000ms'));
    expect(payload.code).toBe(ErrorCode.NETWORK_TIMEOUT);
    expect(payload.titleKey).toBe('engine_errors.NETWORK_TIMEOUT_TITLE');
  });

  it('fetch failed 应归一化为网络超时', () => {
    const payload = ExceptionHub.normalize(new Error('fetch failed'));
    expect(payload.code).toBe(ErrorCode.NETWORK_TIMEOUT);
    expect(payload.titleKey).toBe('engine_errors.NETWORK_TIMEOUT_TITLE');
  });

  it('JSON parse 错误应归一化为契约破损', () => {
    const payload = ExceptionHub.normalize(new Error('Unexpected token in JSON at position 0'));
    expect(payload.titleKey).toBe('engine_errors.DAEMON_CONTRACT_BROKEN_TITLE');
  });

  it('未知错误应归一化为契约破损兜底', () => {
    const payload = ExceptionHub.normalize(new Error('Something went wrong'));
    expect(payload.titleKey).toBe('engine_errors.DAEMON_CONTRACT_BROKEN_TITLE');
  });

  it('ECONNREFUSED 应归一化为 Daemon 离线并触发自愈', () => {
    const payload = ExceptionHub.normalize(new Error('connect ECONNREFUSED 127.0.0.1:34567'));
    expect(payload.code).toBe(ErrorCode.AI_SERVICE_OFFLINE);
    expect(payload.titleKey).toBe('engine_errors.DAEMON_OFFLINE_TITLE');
    expect(payload.promptKey).toBe('engine_errors.DAEMON_OFFLINE_AUTOHAL_PROMPT');
  });

  it('daemon offline 应归一化为 Daemon 离线', () => {
    const payload = ExceptionHub.normalize(new Error('Daemon offline unexpectedly'));
    expect(payload.code).toBe(ErrorCode.AI_SERVICE_OFFLINE);
    expect(payload.titleKey).toBe('engine_errors.DAEMON_OFFLINE_TITLE');
  });

  it('clip_search 应归一化为 Daemon 离线', () => {
    const payload = ExceptionHub.normalize(new Error('clip_search service unavailable'));
    expect(payload.code).toBe(ErrorCode.AI_SERVICE_OFFLINE);
    expect(payload.titleKey).toBe('engine_errors.DAEMON_OFFLINE_TITLE');
  });

  it('toIPCPayload 应正确序列化', () => {
    const payload = ExceptionHub.normalize(new Error('HTTP 401'));
    const ipc = ExceptionHub.toIPCPayload(payload);
    expect(ipc.code).toBe(ErrorCode.SYS_ENV_ERROR);
    expect(ipc.titleKey).toBe('engine_errors.AI_AUTH_FAILED_TITLE');
    expect(typeof ipc.rawMessage).toBe('string');
  });

  // === ADR-004 G3：出站前凭据拦截必须归为「鉴权失败」，不能被兜底误判为「契约破损」 ===
  it('AIAuthError（凭据未配置）⇒ 鉴权失败，不得落契约破损兜底', () => {
    const err = new AIAuthError({ provider: 'deepseek', taskLabel: 'script', status: 'missing' });
    const payload = ExceptionHub.normalize(err);
    expect(payload.code).toBe(ErrorCode.SYS_ENV_ERROR);
    expect(payload.titleKey).toBe('engine_errors.AI_AUTH_FAILED_TITLE');
    expect(payload.promptKey).toBe('engine_errors.AI_AUTH_FAILED_PROMPT');
  });

  it('AIAuthError（凭据已失效需重填）⇒ 鉴权失败', () => {
    const err = new AIAuthError({ provider: 'visual', taskLabel: 'visual', status: 'decrypt_failed' });
    const payload = ExceptionHub.normalize(err);
    expect(payload.code).toBe(ErrorCode.SYS_ENV_ERROR);
    expect(payload.titleKey).toBe('engine_errors.AI_AUTH_FAILED_TITLE');
  });

  it('CredentialDecryptError ⇒ 鉴权失败（消息不含 api key，靠 name/特征词识别）', () => {
    const payload = ExceptionHub.normalize(new CredentialDecryptError('key_mismatch', 'deepseekKey'));
    expect(payload.code).toBe(ErrorCode.SYS_ENV_ERROR);
    expect(payload.titleKey).toBe('engine_errors.AI_AUTH_FAILED_TITLE');
    expect(payload.titleKey).not.toBe('engine_errors.DAEMON_CONTRACT_BROKEN_TITLE');
  });

  it('被上层包裹后丢掉 name 的凭据异常，仍靠消息特征归为鉴权失败', () => {
    const wrapped = new Error('LLM 处理异常: AI 凭据未配置（provider=deepseek, script）：请在 设置 → AI 填写 API Key（出站前已拦截，未发起请求）');
    const payload = ExceptionHub.normalize(wrapped);
    expect(payload.titleKey).toBe('engine_errors.AI_AUTH_FAILED_TITLE');
  });
});
