// 📁 路径：src/modules/pipeline/step2-vision/backend/VlmAdapter.ts
// 🚀 通用 VLM（视觉大模型）适配器
//
// 设计目标：屏蔽不同视觉大模型（Qwen-VL / Claude / 豆包 / OpenAI 兼容 / 本地开源模型）
// 在【渠道解析】【response_format 支持级别】【JSON 返回格式】上的差异，
// 向步骤2 后端暴露统一的分析契约。
//
// 渠道解析复用 LLMFactory（已通过设置/绑定表在 deepseek/qwen/腾讯/豆包/proxy 间自动切换），
// 本适配器只负责：统一调用 + response_format 三级降级 + 鲁棒 JSON 提取。
import { LLMFactory } from '../../../../main/engine/adapters/LLMFactory';
import type { ILLMProvider } from '../../../../main/engine/adapters/ILLMProvider';
import { safeParseVlmJson } from '../../../../shared/utils/jsonUtils';
import { AppLogger } from '../../../../main/core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

/**
 * VLM response_format 能力级别（首次调用检测，后续复用，避免重复失败）
 * 1 = json_schema（最严格，OpenAI/部分服务商支持）
 * 2 = json_object（多数服务商支持）
 * 3 = 无 response_format（纯 prompt 约束，兼容所有服务商）
 */
type FormatLevel = 1 | 2 | 3;

export class VlmAdapter {
  private adapter: ILLMProvider;
  private model: string;
  private formatLevel: FormatLevel = 1;

  /**
   * 构造 VLM 适配器
   * 内部通过 LLMFactory.createAdapter('visual') 解析当前绑定的视觉模型
   * （渠道切换：deepseek/qwen/腾讯/豆包/proxy 自动识别，无需重复实现渠道解析）
   * @param modelName 可选，覆盖 LLMFactory 解析出的模型名（如前端显式指定）
   */
  constructor(modelName?: string) {
    const { adapter, modelName: resolvedModel } = LLMFactory.createAdapter('visual');
    this.adapter = adapter;
    this.model = modelName || resolvedModel;
  }

  /** 当前生效的视觉模型名（供上游作为 L2 缓存键使用） */
  public get modelName(): string {
    return this.model;
  }

  /**
   * 调用 VLM 并返回解析后的 JSON
   * - 内部处理 response_format 三级降级（json_schema → json_object → 无，适配不同服务商）
   * - JSON 解析失败【直接抛错】（错就错），不静默降级
   *
   * @param messages 已构造好的 OpenAI 兼容 messages（含 image_url 多模态内容）
   * @param temperature 采样温度
   * @param responseFormat 首选 response_format（json_schema 级别）
   * @returns 解析后的结构化 JSON 对象
   */
  public async analyzeJson<T>(
    messages: any[],
    temperature: number,
    responseFormat: any,
  ): Promise<T> {
    const text = await this.callWithFormatFallback(messages, temperature, responseFormat);
    return safeParseVlmJson<T>(text);
  }

  /**
   * 按当前 response_format 级别调用 VLM，失败时自动降级
   * 降级链：json_schema → json_object → 无（不同服务商支持级别不同，属设计多路径）
   * @param messages 多模态消息
   * @param temperature 采样温度
   * @param responseFormat 首选 json_schema 格式定义
   * @returns 原始文本（未解析）
   */
  private async callWithFormatFallback(
    messages: any[],
    temperature: number,
    responseFormat: any,
  ): Promise<string> {
    const buildOpts = (level: FormatLevel): any => {
      if (level === 1) return { response_format: responseFormat };
      if (level === 2) return { response_format: { type: 'json_object' } };
      return {};
    };

    while (this.formatLevel <= 3) {
      try {
        const r = await this.adapter.chat(
          messages,
          this.model,
          temperature,
          buildOpts(this.formatLevel),
        );
        return this.extractText(r);
      } catch (e: any) {
        if (this.formatLevel < 3 && this.isFormatError(e)) {
          const next = (this.formatLevel + 1) as FormatLevel;
          AppLogger.warn(
            LOG_TAGS.AI_AGENT,
            `[VlmAdapter] VLM 不支持 Level ${this.formatLevel}，降级到 Level ${next}`,
          );
          this.formatLevel = next;
          continue;
        }
        throw e; // 非格式错误或已到 Level 3，直接暴露
      }
    }
    throw new Error('VLM 调用失败: 未知错误');
  }

  /** 从 LLMResponse 提取文本；success=false 时抛错暴露失败原因 */
  private extractText(r: any): string {
    if (r && typeof r === 'object') {
      if (r.success === false) {
        throw new Error(`VLM 调用失败: ${r.error || '未知错误'}`);
      }
      return r.text || '';
    }
    return typeof r === 'string' ? r : '';
  }

  /** 判断是否为 response_format 不兼容错误（可安全降级重试） */
  private isFormatError(e: any): boolean {
    const msg = String(e?.message || e);
    return /response_format|json_schema|json_object|unknown_parameter|400/i.test(msg);
  }
}