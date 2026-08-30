// 📁 路径：src/main/engine/adapters/OpenAICompatibleAdapter.ts
import type { ILLMProvider, LLMResponse, ChatOptions } from './ILLMProvider';
import type { WebContents } from 'electron';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { StreamBufferGuard } from '../../core/StreamBufferGuard';
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';

/** 可重试的 HTTP 状态码：限流 + 服务端临时故障 */
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
/** 🔧 网络/限流类错误的最大重试次数（2 次 = 最多尝试 3 次）
 *  🚀 提速：从 1 恢复到 2。此前为防"假 429"压到 1，但真根因是 API Key/路径。
 *  并发 4 路下偶发瞬时 429/5xx 概率上升，保留 2 次指数退避重试兜底（质量优先）。
 */
const MAX_RETRY_ATTEMPTS = 2;
/** 指数退避的初始等待毫秒（第 1 次失败后） */
const BASE_BACKOFF_MS = 1000;
/** 指数退避乘数（1s → 2s → 4s） */
const BACKOFF_MULTIPLIER = 2;

/* ============ 🔧 进程级 HTTP 请求全局限流器 ============
 * 兜底用：防止并发请求在"同一毫秒"瞬时打爆服务商 QPS 尖峰。
 * 🚀 提速：根因（API Key/路径）已解决，RPM=3 / QPS≤0.4 的保守门槛已废除，
 * 放宽到"4 路并发 × 每秒 5 次、每分钟 240 次"，几乎不再主动限流，仅保留防瞬时尖峰能力。
 */
/** 请求间最小间隔（ms）：QPS 上限放宽到 ≤5/s（多数中转 QPS≥10，留 2 倍裕度） */
const REQUEST_MIN_INTERVAL_MS = 200;
/** 60s 滑动窗口请求上限：240 次/分钟，4 路并发下每路 60 次，实际几乎不会触达 */
const MAX_REQUESTS_PER_MINUTE = 240;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** 全局限流器单例（模块级变量，所有 OpenAICompatibleAdapter + VolcengineAdapter 实例共享） */
const GlobalRequestThrottler = {
  /** 最近一次真实 fetch 的时间戳（ms） */
  lastRequestAt: 0,
  /** 滑动窗口内的请求时间戳队列（严格增序，超过 60s 的会在 acquire 时清理） */
  requestTimestamps: [] as number[],
  /**
   * 在真正发起 HTTP fetch 前调用。如果需要等待，会自动 sleep，
   * 保证 QPS 上限 & RPM 上限不被突破。
   */
  async acquire(): Promise<void> {
    // 先清理 60s 之前的旧时间戳（滑动窗口）
    const now1 = Date.now();
    const cutoff = now1 - RATE_LIMIT_WINDOW_MS;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] <= cutoff) {
      this.requestTimestamps.shift();
    }

    // ① 计算"请求间最小间隔"的等待
    const minIntervalWait = Math.max(0, (this.lastRequestAt + REQUEST_MIN_INTERVAL_MS) - now1);
    // ② 计算"滑动窗口 RPM 上限"的等待：若窗口满，等最旧那条出窗口的时间 + 一点 buffer
    let rpmWait = 0;
    if (this.requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
      const oldest = this.requestTimestamps[0];
      rpmWait = Math.max(0, (oldest + RATE_LIMIT_WINDOW_MS + 100) - now1); // +100ms 保守 buffer
    }
    const totalWaitMs = Math.max(minIntervalWait, rpmWait);

    if (totalWaitMs > 0) {
      // 🔧 把日志级别从 DEBUG → WARN：默认配置下 DEBUG 会被过滤，用户看不到节流器是否真的生效；
      // 一旦出现 429，我们必须能从日志里反推"到底有没有被节流、等了多久、窗口请求是几个"，否则就是盲调。
      AppLogger.warn(LOG_TAGS.AI_AGENT,
        `[Adapter][Throttler] 全局限流等待 ${totalWaitMs}ms（minInterval=${minIntervalWait}ms, rpmWait=${rpmWait}ms, 当前窗口请求=${this.requestTimestamps.length}/${MAX_REQUESTS_PER_MINUTE}）`);
      await sleep(totalWaitMs);
    }

    // sleep 后再重新取时间戳，清理 & 重新检查
    const now2 = Date.now();
    const cutoff2 = now2 - RATE_LIMIT_WINDOW_MS;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] <= cutoff2) {
      this.requestTimestamps.shift();
    }
    // 若窗口还是满（极小概率：sleep 不够长或被并发抢占），再递归等一次
    if (this.requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
      return this.acquire();
    }
    this.requestTimestamps.push(now2);
    this.lastRequestAt = now2;
  },
};

/**
 * 异步等待（毫秒）
 * @param ms 等待时长
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 🔧 致命错误黑名单（命中即永不重试，即使 HTTP status 是 429 也一样）
 * 原因：国内中转商常见奇葩行为 —— "Invalid token / 余额不足 / 欠费 / 模型无权限" 等致命错误
 *      居然也会返回 HTTP 429（而不是正确的 401/403/402），导致指数退避 + 3 次重试白白等待 7 秒，
 *      还在日志里伪装成"限流"误导用户去调并发参数。
 */
const FATAL_NEVER_RETRY_REGEX = /invalid token|unauthorized|forbidden|401|403|api.?key.*invalid|invalid.*api.?key|鉴权|认证失败|auth.?fail|权限不足|没有权限|账号.*被.*(禁|冻|停)|insufficient balance|arrearage|balance.*not.*enough|out.?of.?balance|余额不足|欠费|额度不足|账户.*(过期|失效)|model.*not.?found|模型不存在|模型未开通|无效的模型|model.*invalid|unsupported model|context.*length.*(exceed|over|max)|上下文.*过长|prompt.?too.?long/i;

/**
 * 从 Response 或 fetch 错误中判断是否属于"可安全重试"的场景
 * （限流 429 / 服务端临时故障 / 偶发网络中断）
 * 🔧 致命错误黑名单优先：只要错误 detail 命中致命关键词，即便状态码是 429 也绝不重试
 */
function isRetryable(status: number | undefined, detail: string): boolean {
  const msg = (detail || '').toLowerCase();
  if (FATAL_NEVER_RETRY_REGEX.test(msg)) {
    return false;
  }
  if (status !== undefined && RETRYABLE_HTTP_STATUS.has(status)) return true;
  // 状态码缺失但错误文本含网络类关键词，也视为可重试（fetch 异常）
  return /fetch failed|network error|econnreset|etimedout|socket hang up|enotfound|dns|connection refused|tls|ssl/i.test(msg);
}

/**
 * 解析 Retry-After 头为毫秒数（兼容秒数 / HTTP-date 两种格式；无法解析时回退为 undefined）
 */
function parseRetryAfterMs(response: Response | undefined): number | undefined {
  if (!response?.headers) return undefined;
  const raw = response.headers.get('Retry-After') || response.headers.get('retry-after');
  if (!raw) return undefined;
  const asSecs = Number(raw);
  if (Number.isFinite(asSecs) && asSecs >= 0) {
    return Math.min(Math.ceil(asSecs * 1000), 15_000); // 最多等 15s，防止死等
  }
  // HTTP-date 格式：粗略转 Date；失败就 undefined
  const asDate = new Date(raw).getTime();
  if (Number.isFinite(asDate) && asDate > 0) {
    return Math.min(Math.max(asDate - Date.now(), 0), 15_000);
  }
  return undefined;
}

/**
 * 🔧 规范化 baseURL，处理用户手动多写的后缀 & 末尾斜杠
 * 常见用户误填："https://xxx.com/v1/chat/completions"、"https://xxx.com/chat/completions"、"https://xxx.com/models"
 * 这些写法后续再拼 "/chat/completions" 就会路径重复，导致 404。
 * @returns 清洗后的纯 host + 可选 /v1 前缀，末尾无斜杠
 */
function normalizeBaseURL(input: string): string {
  if (!input) return '';
  let cleaned = input.trim().replace(/\/+$/, '');
  // 去掉末尾多写的 /chat/completions / /models / /v1/chat/completions
  cleaned = cleaned.replace(/\/(chat\/completions|models)$/i, '');
  cleaned = cleaned.replace(/\/v1\/chat\/completions$/i, '/v1');
  cleaned = cleaned.replace(/\/+$/, '');
  return cleaned;
}

/**
 * 判断一次响应是否像"路径写错导致的 404/HTML"，用于触发自动补 /v1 的兜底重试
 * 典型情况：
 *  - HTTP 404（路径根本不存在）
 *  - 200 但返回 HTML（路由落到了中转的管理页/首页，肯定不是合法的 OpenAI 兼容接口）
 *  - 400/500 且 detail 中明确有 "unknown path" / "invalid endpoint" / "路由不存在" / "路径不存在" 等关键词
 */
function looksLikePathMismatch(response: Response, detail: string): boolean {
  if (response.status === 404) return true;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) return true;
  const low = (detail || '').toLowerCase();
  return /unknown path|invalid endpoint|no such endpoint|endpoint not found|invalid route|route not found|路由不存在|路径不存在|invalid path|path not found|404 not found/.test(low);
}

export class OpenAICompatibleAdapter implements ILLMProvider {
  public readonly providerName: string = 'openai_compatible';
  protected baseURL: string;
  protected apiKey: string;

  constructor(baseURL: string, apiKey: string) {
    // 🔧 构造时先规范化 baseURL，避免用户把 "https://xxx.com/v1/chat/completions" 填成 baseURL
    this.baseURL = normalizeBaseURL(baseURL);
    this.apiKey = apiKey;
  }

  /**
   * 内部工具：生成 /chat/completions 或 /models 的完整 URL
   * @param kind 'chat' => /chat/completions；'models' => /models
   * @param forceInjectV1 是否强行在 baseURL 和路径之间插入 /v1（用于自动补 v1 的兜底重试）
   */
  protected buildEndpoint(kind: 'chat' | 'models', forceInjectV1: boolean = false): string {
    const base = this.baseURL.replace(/\/$/, '');
    const needsV1Injection = forceInjectV1 && !/\/v1$/i.test(base);
    const path = kind === 'chat' ? '/chat/completions' : '/models';
    if (needsV1Injection) {
      return `${base}/v1${path}`;
    }
    return `${base}${path}`;
  }

  /**
   * 内部工具：统一发起带"自动补 /v1 兜底重试"的请求
   * - 第一次：原 baseURL 拼路径
   * - 第一次若 404 / 返回 HTML（典型缺 /v1）：自动补 /v1 再试一次（仅补一次，不循环）
   * - 返回最终响应：调用方继续走原 status/text 消费逻辑
   */
  protected async fetchWithV1Fallback(
    kind: 'chat' | 'models',
    makeInit: (endpoint: string) => RequestInit,
    opLabel: string,
  ): Promise<Response> {
    const endpoint1 = this.buildEndpoint(kind, false);
    const resp1 = await this.fetchWithRetry(endpoint1, makeInit(endpoint1), opLabel);
    if (resp1.ok) return resp1;

    // 读取一次 body 用于判断路径错误；这里保留 text 用于后续 rebuildResponseWithText 可能复用
    let detail1 = '';
    try { detail1 = (await resp1.text()).substring(0, 300); } catch {}
    const pathMismatch = looksLikePathMismatch(resp1, detail1);
    const v1AlreadyPresent = /\/v1$/i.test(this.baseURL.replace(/\/$/, ''));

    if (pathMismatch && !v1AlreadyPresent) {
      AppLogger.warn(LOG_TAGS.AI_AGENT,
        `[Adapter] 检测到疑似缺少 /v1 前缀：原 endpoint=${endpoint1} 返回 HTTP ${resp1.status}，自动补 /v1 再试一次。服务端返回片段：${detail1 || '(空)'}`);
      const endpoint2 = this.buildEndpoint(kind, true);
      const resp2 = await this.fetchWithRetry(endpoint2, makeInit(endpoint2), `${opLabel}/auto-v1`);
      if (resp2.ok) return resp2;
      let detail2 = '';
      try { detail2 = (await resp2.text()).substring(0, 300); } catch {}
      // 补 /v1 后仍失败：把最后一次响应返回给上层；调用方可以继续按原逻辑 throw
      return this.rebuildResponseWithText(resp2, detail2);
    }

    // 非路径类失败：把第一次响应用缓存的 text 重建后返回，避免上层读不到 body
    return this.rebuildResponseWithText(resp1, detail1);
  }

  /**
   * 测试中转站/模型连通性与鉴权
   * 🔧 修复：原实现写死 model=gpt-3.5-turbo，导致用户选的是 gpt-4o/火山ep-xxx/千问模型，
   *      「测试连接」按钮测的却是完全无关的另一个小模型 —— 只要小模型有余额就会返回成功，
   *      但真实调用用户配置的模型时却报 Invalid token/模型不存在/余额不足。
   *
   * 新策略：
   *  - 如果调用方传入了真实模型名 model：就直接用该模型发 POST /chat/completions 最小文字推理，
   *    准确验证"这个具体模型我到底能不能用"。
   *  - 如果没传 model（兜底兼容）：回退到 GET /models，只验证 baseURL + Authorization Bearer 是否正确，
   *    不绑定任何具体模型名，避免硬编码 gpt-3.5-turbo 在火山/千问/中转不存在时误报失败。
   */
  public async testConnection(model?: string): Promise<boolean> {
    if (model && model.trim().length > 0) {
      // ✅ 推荐路径：真实测用户选中的这个模型（自动补 /v1 兜底）
      try {
        const response = await this.fetchWithV1Fallback(
          'chat',
          (_endpoint) => ({
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 3 })
          }),
          `testConnection/model=${model}`,
        );
        if (response.ok) return true;
        let detail = '';
        try { detail = (await response.text()).substring(0, 200); } catch {}
        const v1Hint = /\/v1$/i.test(this.baseURL) ? '' : `（也可尝试在 baseURL 末尾手动加上 /v1，如 https://xxx.com/v1）`;
        throw new Error(`模型「${model}」验证失败，HTTP ${response.status}${detail ? '：' + detail : ''}${v1Hint}`);
      } catch (error: any) { throw error; }
    }

    // 🔧 兼容路径：没有 model 时用 GET /models 测鉴权（自动补 /v1 兜底）
    try {
      const response = await this.fetchWithV1Fallback(
        'models',
        () => ({
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.apiKey}` }
        }),
        'testConnection/get-models',
      );
      if (response.ok) return true;
      let detail = '';
      try { detail = (await response.text()).substring(0, 200); } catch {}
      const v1Hint = /\/v1$/i.test(this.baseURL) ? '' : `（也可尝试在 baseURL 末尾手动加上 /v1，如 https://xxx.com/v1）`;
      throw new Error(`GET /models 返回 HTTP ${response.status}${detail ? '：' + detail : ''}${v1Hint}`);
    } catch (error: any) { throw error; }
  }

  async chat(messages: any[], model: string, temperature: number, options?: ChatOptions): Promise<LLMResponse> {
    try {
      // P0-1：组装请求体，按需注入 response_format / max_tokens（兼容 OpenAI / Qwen JSON Mode）
      // 🔧 兼容性降级：部分服务商不支持 json_schema，自动降级为 json_object 再降级为无
      const response = await this.doChatRequest(model, messages, temperature, options?.response_format, options?.max_tokens);
      // 🔧 修复：状态码 200 但返回 HTML 时给出明确提示（而非 "Unexpected token '<'"）
      const contentType = response.headers.get('content-type') || '';
      const rawText = await response.text();
      if (!contentType.includes('application/json') || rawText.trimStart().startsWith('<')) {
        const v1Hint = /\/v1$/i.test(this.baseURL) ? '' : `（也可尝试在 baseURL 末尾手动加上 /v1，如 https://xxx.com/v1）`;
        throw new Error(`接口返回了 HTML 而非 JSON（baseURL=${this.baseURL}）${v1Hint}，请检查接口地址是否正确。响应片段：${rawText.substring(0, 200)}`);
      }
      const data = JSON.parse(rawText);
      const msg = data.choices?.[0]?.message;
      // 🔧 诊断增强：content 为空但存在 reasoning_content → DeepSeek 思考模式被 max_tokens 截断，
      // 明确报"思考截断"而非被误判为"后端空返回"，便于用户针对性处理（关闭思考或提高 max_tokens）
      if (!msg?.content && msg?.reasoning_content) {
        throw new Error(
          `响应 content 为空：模型仅输出了思考内容（${String(msg.reasoning_content).length} 字符）而未产出正文，` +
          `大概率是 DeepSeek 思考模式耗尽 max_tokens 被截断，请关闭思考或提高 max_tokens`,
        );
      }
      return { success: true, text: data.choices[0].message.content };
    } catch (error: any) { return { success: false, error: error.message }; }
  }

  /**
   * 🔧 统一封装 fetch + 限流/网络故障指数退避重试
   * - 对 429/500/502/503/504 以及 fetch 失败的偶发网络故障自动重试
   * - 优先尊重响应头 Retry-After（秒或 HTTP-date）
   * - 每次重试打印告警，超过 MAX_RETRY_ATTEMPTS 后将最后一次响应/错误原样返回给上层
   *
   * @param endpoint 完整请求 URL
   * @param init fetch 参数（method/headers/body 等）
   * @param opLabel 操作标签，仅用于日志定位（如 "chat/json_schema"、"testConnection"）
   * @returns 最后一次 fetch 的 Response（无论成功/失败；调用方继续按原逻辑处理 ok / status）
   */
  private async fetchWithRetry(
    endpoint: string,
    init: RequestInit,
    opLabel: string,
  ): Promise<Response> {
    let lastResponse: Response | undefined;
    let lastError: any;
    let attempt = 0;
    const maxAttempt = MAX_RETRY_ATTEMPTS + 1; // 重试次数 + 首次尝试

    while (attempt < maxAttempt) {
      try {
        // 🔧 全局硬限流：每个真实 HTTP fetch 请求发出前，强制过 QPS+RPM 双节流器
        // （作用域覆盖所有 LLM/VLM 请求，包括 buildGlobalContext / 批次分析 / 配置测试 / 内部重试）
        await GlobalRequestThrottler.acquire();
        const response = await fetch(endpoint, init);
        lastResponse = response;

        if (response.ok) return response;

        // 读取错误文本用于判断 + 日志
        let detail = '';
        try { detail = (await response.text()).substring(0, 300); } catch {}

        if (!isRetryable(response.status, detail)) {
          // 不可重试（400/401/404 等），重新构造一个可读的 Response（text() 已消费过 body）
          return this.rebuildResponseWithText(response, detail);
        }

        attempt++;
        if (attempt >= maxAttempt) {
          // 重试次数用完，返回最后一次响应（重新构造 body）
          AppLogger.error(LOG_TAGS.AI_AGENT,
            `[Adapter][${opLabel}] 可重试错误（HTTP ${response.status}）已达 ${attempt}/${maxAttempt} 次上限，停止重试。服务端详情：${detail || '(空)'}`);
          return this.rebuildResponseWithText(response, detail);
        }

        // 🔧 退避等待：优先 Retry-After，否则按 BASE_BACKOFF * multiplier^(attempt-1)
        const retryAfterMs = parseRetryAfterMs(response);
        const backoffMs = retryAfterMs ?? BASE_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1);
        const hint = this.summarizeRateLimitDetail(detail);
        AppLogger.warn(LOG_TAGS.AI_AGENT,
          `[Adapter][${opLabel}] 遭遇可重试错误 HTTP ${response.status}${hint.classification}，第 ${attempt}/${MAX_RETRY_ATTEMPTS} 次重试，等待 ${backoffMs}ms${retryAfterMs ? '（来自 Retry-After 头）' : ''}。服务端详情：${detail || '(空)'}`);
        await sleep(backoffMs);

        // 📌 细节：response.text() 已经把 body 消费完了不能再次给调用方用；下一轮 fetch 用原始 init 重新请求即可
        lastError = undefined;
        continue;
      } catch (e: any) {
        lastError = e;
        const detail = String(e?.message || e);
        attempt++;

        if (!isRetryable(undefined, detail) || attempt >= maxAttempt) {
          AppLogger.error(LOG_TAGS.AI_AGENT,
            `[Adapter][${opLabel}] fetch 网络错误（非重试或已达上限 ${attempt}/${maxAttempt}）：${detail}`);
          throw e;
        }
        const backoffMs = BASE_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1);
        AppLogger.warn(LOG_TAGS.AI_AGENT,
          `[Adapter][${opLabel}] fetch 网络异常：${detail.substring(0, 160)}，第 ${attempt}/${MAX_RETRY_ATTEMPTS} 次重试，等待 ${backoffMs}ms`);
        await sleep(backoffMs);
      }
    }

    // 理论不会跑到这里；兜底返回最后一次 response 或抛最后一个 error
    if (lastResponse) return lastResponse;
    throw lastError ?? new Error('fetchWithRetry: 未知错误');
  }

  /**
   * 由于我们在判断可重试时会消费 response.text()（用于判断 detail + 日志），
   * 需要用原始状态 + 已读取的 text 重新构造一个 Response，否则上层拿到的 body 已不可读
   */
  private rebuildResponseWithText(orig: Response, cachedText: string): Response {
    const headers: Record<string, string> = {};
    orig.headers.forEach((v, k) => { headers[k] = v; });
    // 修正 content-length（因为 cachedText 可能被我们 substring 截断了）
    if (cachedText.length > 0) {
      headers['content-length'] = String(new Blob([cachedText]).size);
    }
    return new Response(cachedText, {
      status: orig.status,
      statusText: orig.statusText,
      headers,
    });
  }

  /**
   * 执行单次 VLM 请求，支持 response_format 三级降级 + 每一级独立的 429/5xx 重试
   * 降级链：json_schema → json_object → 无 response_format
   * 🔧 同时每一级都走 fetchWithV1Fallback：路径不匹配时自动补 /v1，覆盖用户漏填 /v1 的场景
   * 兼容 OpenAI 官方 / 阿里云 Qwen / 智谱等不同服务商
   */
  private async doChatRequest(
    model: string, messages: any[],
    temperature: number, responseFormat: any, maxTokens?: number,
  ): Promise<Response> {
    const buildPayload = (rf: any) => {
      const payload: any = { model, messages, temperature };
      if (rf) payload.response_format = rf;
      if (maxTokens) payload.max_tokens = maxTokens;
      // 🔧 DeepSeek V4 思考模式默认开启：max_tokens 同时覆盖"思考+输出"，长任务思考易耗尽预算导致 content 为空
      //（实例现象：章节解说请求连续两次空返回）。解说文案为创作直出任务，显式关闭思考（官方最佳实践），
      // 同时使 temperature 真正生效（思考模式下其被静默忽略）。
      if (/deepseek/i.test(model)) {
        payload.thinking = { type: 'disabled' };
      }
      return payload;
    };

    /** 生成指定 response_format 对应的 RequestInit；endpoint 由 fetchWithV1Fallback 统一注入 */
    const makeInitFactory = (rf: any) => (_endpoint: string): RequestInit => ({
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(rf)),
    });

    const response = await this.fetchWithV1Fallback(
      'chat',
      makeInitFactory(responseFormat),
      `chat/${responseFormat?.type || 'no-format'}`,
    );

    if (response.ok) return response;

    // 读取错误详情用于判断降级
    let detail = '';
    try { detail = (await response.text()).substring(0, 300); } catch {}

    // 🔧 兼容性降级0：json_object 不支持时，去掉 response_format 重试（Ollama 等本地模型 / 部分中转站不实现该参数）
    // 修复背景：ScriptGenStrategy 三处生成调用已显式传 response_format: {type:'json_object'}，
    // 若后端不支持会 400 报错，需在此兜底降级，避免"不支持即挂掉"破坏原有可运行链路。
    if (response.status === 400 && responseFormat?.type === 'json_object') {
      AppLogger.warn(LOG_TAGS.AI_AGENT,
        `[Adapter] 后端不支持 response_format(json_object)，降级为无格式约束重试`);
      const retryNoFmt = await this.fetchWithV1Fallback(
        'chat',
        makeInitFactory(null),
        `chat/no-format(fallback)`,
      );
      if (retryNoFmt.ok) return retryNoFmt;
      let detail0 = '';
      try { detail0 = (await retryNoFmt.text()).substring(0, 300); } catch {}
      this.throwHttpError(retryNoFmt.status, detail0);
    }

    // 🔧 兼容性降级1：json_schema 不支持时，降级为 json_object
    if (response.status === 400 && responseFormat?.type === 'json_schema' && detail.includes('json_schema')) {
      AppLogger.warn(LOG_TAGS.AI_AGENT,
        `[Adapter] VLM 不支持 json_schema，降级为 json_object 重试`);
      const fallbackFormat = { type: 'json_object' as const };
      const retry1 = await this.fetchWithV1Fallback(
        'chat',
        makeInitFactory(fallbackFormat),
        `chat/json_object(fallback)`,
      );
      if (retry1.ok) return retry1;
      let detail2 = '';
      try { detail2 = (await retry1.text()).substring(0, 300); } catch {}
      // 🔧 兼容性降级2：json_object 也不支持时，去掉 response_format
      if (retry1.status === 400 && detail2.includes('response_format')) {
        AppLogger.warn(LOG_TAGS.AI_AGENT,
          `[Adapter] VLM 不支持 response_format，降级为无格式约束重试`);
        const retry2 = await this.fetchWithV1Fallback(
          'chat',
          makeInitFactory(null),
          `chat/no-format(fallback)`,
        );
        if (retry2.ok) return retry2;
        let detail3 = '';
        try { detail3 = (await retry2.text()).substring(0, 300); } catch {}
        this.throwHttpError(retry2.status, detail3);
      }
      this.throwHttpError(retry1.status, detail2);
    }

    this.throwHttpError(response.status, detail);
    throw new Error('unreachable'); // TS 类型收窄
  }

  /** 根据 HTTP 状态码抛出带诊断信息的错误 */
  private throwHttpError(status: number, detail: string): never {
    const v1Hint = /\/v1$/i.test(this.baseURL) ? '' : `（也可尝试在 baseURL 末尾手动加上 /v1，如 https://xxx.com/v1）`;
    if (status === 401) throw new Error(`API Key 鉴权失败（401）${detail ? '：' + detail : ''}`);
    if (status === 404) throw new Error(`接口地址不存在（404），请检查 baseURL：${this.baseURL}${v1Hint}${detail ? ' 详情：' + detail : ''}`);
    // 🔧 修复：429 必须带上服务端响应的 detail（区分 QPS/RPM/TPM 超限 vs 余额不足/欠费/鉴权失败伪装的429）
    // 国内中转常把 Invalid token / 余额不足 / 模型无权限 也用 HTTP 429 返回，伪装成限流
    if (status === 429) {
      const hint = this.summarizeRateLimitDetail(detail);
      // 如果是"伪装成限流的致命错误"，不要再说"请求过于频繁被限流"，直接说真实原因
      const isFatalPseudo429 = /余额不足|欠费|鉴权失败|API Key 无效|模型不存在|模型未开通|上下文长度超限/.test(hint.classification);
      const prefix = isFatalPseudo429
        ? `❌ ${hint.classification.replace(/^但实际为|^（|）$/g, '').trim()}（供应商返回了 HTTP 429）`
        : `请求过于频繁被限流（429）${hint.classification}`;
      throw new Error(
        `${prefix}。` +
        `baseURL=${this.baseURL}${hint.detail ? '，服务端返回：' + hint.detail : ''}`
      );
    }
    throw new Error(`HTTP ${status}${detail ? '：' + detail : ''}`);
  }

  /**
   * 从 429 detail 文本中推断限流类型（QPS/RPM/TPM/余额/鉴权/模型），给用户可读诊断 + 下一步处理建议
   */
  private summarizeRateLimitDetail(detail: string): { classification: string; detail: string } {
    const cleaned = (detail || '').trim();
    const low = cleaned.toLowerCase();

    // 🔧 优先级最高：鉴权失败/Invalid token（供应商伪装成429，其实是401级别）
    if (/invalid token|unauthorized|forbidden|401|403|api.?key.*invalid|invalid.*api.?key|鉴权|认证失败|auth.?fail|权限不足|没有权限/.test(low)) {
      return { classification: '但实际为API Key 鉴权失败/无权限（供应商返回了429），请检查API Key是否有效、模型是否有访问权限', detail: cleaned };
    }
    if (low.includes('insufficient') || low.includes('arrearage') || low.includes('balance') ||
        /余额|欠费|额度不足|充值/.test(low)) {
      return { classification: '但实际为余额不足/欠费（供应商返回了429），请检查账户余额或充值', detail: cleaned };
    }
    if (/model.*not.?found|模型不存在|模型未开通|无效的模型|unsupported model|model.*invalid/.test(low)) {
      return { classification: '但实际为模型不存在/未开通（供应商返回了429），请核对模型名或申请开通权限', detail: cleaned };
    }
    if (low.includes('context') && /length|exceed|over|max/.test(low)) {
      return { classification: '（上下文长度超限，与限流无关，实际是 prompt 太长/图片太大）', detail: cleaned };
    }
    if (low.includes('tpm') || low.includes('token')) {
      return { classification: '（每分钟 Token 数 TPM 超限，请降低图片数/拼图或等待更长时间）', detail: cleaned };
    }
    if (low.includes('rpm') || /per minute|每分钟/.test(low)) {
      return { classification: '（每分钟请求数 RPM 超限，当前已加全局退避；若持续出现需调整批次间隔）', detail: cleaned };
    }
    if (low.includes('qps') || /per second|每秒/.test(low)) {
      return { classification: '（每秒请求数 QPS 超限）', detail: cleaned };
    }
    // 无明确关键词时原样返回简短 detail，供人工判断
    const shortDetail = cleaned.length > 200 ? cleaned.substring(0, 200) + '…' : cleaned;
    return { classification: '（QPS/RPM/TPM 限额其中之一）', detail: shortDetail };
  }

  // 💥 真正干活的地方：拦截流、发给前端、解析动作
  async streamChatToBrowser(webContents: WebContents, messages: any[], model: string, temperature: number, chunkChannel: string, tools?: any[]): Promise<{ text: string, toolCall?: any }> {
    const endpoint = `${this.baseURL.replace(/\/$/, '')}/chat/completions`;
    const payload: any = { model, messages, temperature, stream: true };
    
    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    let response;
    try {
      // 💥 给 fetch 加上错误拦截 + 🔧 全局限流
      await GlobalRequestThrottler.acquire();
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (networkError: any) {
      // 拦截 Node.js 底层 10秒超时与连接拒绝
      if (networkError.message.includes('fetch failed')) {
         throw new Error(`【物理断网拦截】请求 [${this.baseURL}] 失败。可能原因：\n1. Node.js 后端默认不走系统 VPN，请尝试更换国内中转站或配置底层代理。\n2. 若使用本地代理(如 127.0.0.1)，请检查该端口是否真正开启。`);
      }
      throw networkError;
    }

    if (!response.ok) throw new Error(`模型响应异常：HTTP ${response.status}`);
    
    const reader = response.body?.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = ''; let currentToolCall: any = null;

    // 💥 修复核心：必须加上 buffer，绝不允许把 TCP 断包的半截 JSON 直接去 Parse！
    let buffer = '';

    // 💥 Layer 4 进阶：流式断点保护，网络熔断时验证完整性
    const bufferGuard = new StreamBufferGuard();

    // 💥 断层4修复：从 chunkChannel 中提取 nodeId 用于安全推流
    // chunkChannel 格式通常为 'agent:streamChunk' 或自定义频道
    let streamNodeId = 'unknown';
    if (chunkChannel.includes(':')) {
      streamNodeId = chunkChannel.split(':').pop() || 'unknown';
    }

    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 将最后一行（可能被网络切断的半截）重新塞回 buffer，等下一个包来了再拼上
      buffer = lines.pop() || ''; 

      for (const line of lines) {
        if (line.trim() === '' || line.trim() === 'data: [DONE]') continue;
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6)); // 💥 解构，方便异常捕获
            const delta = parsed.choices[0]?.delta;
            if (delta?.content) { 
              fullText += delta.content; 
              webContents.send(chunkChannel, delta.content); 
              // 💥 追加到流式保护缓冲区
              bufferGuard.append(delta.content);

              // 💥 断层4修复：实时向前端推送 StreamBufferGuard 清洗后的安全数据
              const safeText = bufferGuard.rollbackOrResolve();
              if (safeText !== '[]') {
                try {
                  if (!webContents.isDestroyed()) {
                    webContents.send(IPC_CHANNELS.EVENT_STREAM_SAFE_CHUNK, {
                      nodeId: streamNodeId,
                      safeText: safeText,
                    });
                  }
                } catch { /* 推送失败静默 */ }
              }
            }
            if (delta?.tool_calls) {
              const tc = delta.tool_calls[0];
              if (tc.function?.name) currentToolCall = { name: tc.function.name, arguments: '' };
              if (tc.function?.arguments && currentToolCall) currentToolCall.arguments += tc.function.arguments;
            }
          } catch (e) {
            // 💥 修复：坚决不静默失败！打印截断数据，防止死锁
            AppLogger.error(LOG_TAGS.AI_ENGINE, `[SSE 解析异常] 大模型返回脏数据`, { 
              lineFragment: line.substring(0, 80) + '...', 
              error: String(e) 
            });
          }
        }
      }
    }

    let finalAction = null;
    if (currentToolCall) {
      try { finalAction = { type: currentToolCall.name.toUpperCase(), ...JSON.parse(currentToolCall.arguments) }; } catch (e) {
        AppLogger.debug(LOG_TAGS.AI_ENGINE, `工具调用参数解析失败: ${currentToolCall.name}`, e)
      }
    }

    // 💥 Layer 4 进阶：流结束后验证完整性，破损则回滚为空契约
    const validatedText = bufferGuard.rollbackOrResolve();
    if (validatedText === '[]') {
      // 流式数据被截断，使用空契约替代残缺数据
      fullText = '[]';
    }

    return { text: fullText, toolCall: finalAction };
  }
}
