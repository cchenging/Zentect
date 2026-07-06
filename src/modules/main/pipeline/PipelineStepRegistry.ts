/** Pipeline 步骤执行器签名 */
export type StepExecutor = (
  projectId: string,
  mediaId: string,
  mediaPath: string,
  context: Record<string, unknown>,
  onProgress: (progress: number, message?: string) => void,
) => Promise<Record<string, unknown>>;

/** Pipeline 步骤注册项 */
export interface StepRegistryEntry {
  /** 步骤唯一标识 */
  stepId: string;
  /** 步骤显示标签 */
  label: string;
  /** 步骤描述 */
  description: string;
  /** 默认最大重试次数 */
  defaultMaxRetries: number;
  /** 是否为致命步骤（失败则终止整条管线） */
  fatal: boolean;
  /** 默认是否启用 */
  enabled: boolean;
  /** 步骤执行器 */
  executor?: StepExecutor;
}

/**
 * Pipeline 步骤注册中心
 * 统一管理所有管线步骤的元数据与执行器，
 * 供 SimplePipelineRunner / PipelineEngine / CLI 等适配器复用
 */
export class PipelineStepRegistry {
  private static instance: PipelineStepRegistry;
  private registry = new Map<string, StepRegistryEntry>();

  private constructor() {
    this.registerBuiltinSteps();
  }

  static getInstance(): PipelineStepRegistry {
    if (!PipelineStepRegistry.instance) {
      PipelineStepRegistry.instance = new PipelineStepRegistry();
    }
    return PipelineStepRegistry.instance;
  }

  /** 注册内置步骤（V1.0 固定管线 7 步） */
  private registerBuiltinSteps(): void {
    const builtinSteps: Omit<StepRegistryEntry, 'executor'>[] = [
      {
        stepId: 'extract_frames',
        label: '帧提取',
        description: '从视频中按策略抽取关键帧',
        defaultMaxRetries: 2,
        fatal: false,
        enabled: true,
      },
      {
        stepId: 'separate_audio',
        label: '音频分离',
        description: '从视频中提取人声与背景音',
        defaultMaxRetries: 1,
        fatal: false,
        enabled: true,
      },
      {
        stepId: 'asr',
        label: '语音识别',
        description: '将音频转为带时间戳的文本',
        defaultMaxRetries: 3,
        fatal: false,
        enabled: true,
      },
      {
        stepId: 'face_detect',
        label: '人脸检测',
        description: '检测并聚类视频中出现的人脸',
        defaultMaxRetries: 2,
        fatal: false,
        enabled: true,
      },
      {
        stepId: 'scene_detect',
        label: '场景分割',
        description: '检测视频的场景切换点',
        defaultMaxRetries: 2,
        fatal: false,
        enabled: true,
      },
      {
        stepId: 'script_gen',
        label: '解说稿生成',
        description: '基于场景与字幕生成AI解说稿',
        defaultMaxRetries: 3,
        fatal: true,
        enabled: true,
      },
      {
        stepId: 'tts_export',
        label: 'TTS 配音',
        description: '将解说稿合成为配音音频',
        defaultMaxRetries: 0,
        fatal: false,
        enabled: true,
      },
    ];

    for (const step of builtinSteps) {
      this.registry.set(step.stepId, step as StepRegistryEntry);
    }
  }

  /** 注册自定义步骤 */
  register(entry: StepRegistryEntry): void {
    if (this.registry.has(entry.stepId)) {
      throw new Error(`步骤 ${entry.stepId} 已存在, 不允许重复注册`);
    }
    this.registry.set(entry.stepId, entry);
  }

  /** 更新步骤的执行器 */
  setExecutor(stepId: string, executor: StepExecutor): void {
    const entry = this.registry.get(stepId);
    if (!entry) {
      throw new Error(`步骤 ${stepId} 未注册, 无法设置执行器`);
    }
    entry.executor = executor;
  }

  /** 获取步骤 */
  get(stepId: string): StepRegistryEntry | undefined {
    return this.registry.get(stepId);
  }

  /** 获取所有已注册步骤 */
  getAll(): StepRegistryEntry[] {
    return Array.from(this.registry.values());
  }

  /** 获取所有启用的步骤 */
  getEnabled(): StepRegistryEntry[] {
    return this.getAll().filter((s) => s.enabled);
  }

  /** 获取步骤的排序列表（按注册顺序） */
  getOrdered(): StepRegistryEntry[] {
    return this.getAll();
  }

  /** 检查步骤是否已注册 */
  has(stepId: string): boolean {
    return this.registry.has(stepId);
  }

  /** 移除步骤 */
  remove(stepId: string): boolean {
    return this.registry.delete(stepId);
  }

  /** 获取注册步骤数量 */
  get count(): number {
    return this.registry.size;
  }

  /** 清空所有步骤（测试用） */
  clear(): void {
    this.registry.clear();
  }
}
