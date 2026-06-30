// 📁 src/main/engine/strategies/TTSStrategy.ts
import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../shared/utils/LogConstants';
import { AIEngine } from '../AIEngine';
import { ProviderManager } from '../config/ProviderManager';

/** TTS 引擎类型 */
type TTSProvider = 'doubao' | 'fish' | 'edge' | 'sovits' | 'moss';

/** 单段 TTS 合成结果 */
interface TTSItemResult {
  shotId: string;
  text: string;
  audioPath: string | null;
  duration: number;
  _failed?: boolean;
  _error?: string;
}

/** 各引擎推荐并发数：HTTP 类引擎可高并发，本地推理引擎受 GPU 限制 */
const ENGINE_CONCURRENCY: Record<TTSProvider, number> = {
  edge: 6,
  doubao: 5,
  fish: 5,
  moss: 2,
  sovits: 2,
};

/**
 * 控制并发数的批量执行器
 * @param tasks 任务列表
 * @param concurrency 最大并发数
 * @param onTaskComplete 单个任务完成时的回调（用于进度更新）
 */
async function runConcurrent<T, R>(
  tasks: T[],
  concurrency: number,
  executor: (task: T, index: number) => Promise<R>,
  onTaskComplete?: (completed: number, total: number, index: number) => void
): Promise<{ result: R | null; error: Error | null }[]> {
  const results: { result: R | null; error: Error | null }[] = new Array(tasks.length);
  let nextIndex = 0;
  let completedCount = 0;

  /** 从队列中取出下一个任务执行，单段失败不中断其他任务 */
  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      try {
        results[idx] = { result: await executor(tasks[idx], idx), error: null };
      } catch (e: any) {
        results[idx] = { result: null, error: e instanceof Error ? e : new Error(String(e.message || e)) };
      }
      completedCount++;
      onTaskComplete?.(completedCount, tasks.length, idx);
    }
  }

  // 启动 concurrency 个 worker 并行消费任务
  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export class TTSStrategy extends BaseNodeStrategy {
  readonly nodeType = 'tts-synthesize';
  readonly isRecoverable = true;

  /** 执行 TTS 合成任务。注意：第一个参数 input 是 BaseNodeStrategy 展开后的 params，不是 PipelineTask */
  protected async performTask(
    input: any,
    context: ExecutionContext,
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    // 读取 TTS 引擎：优先使用前端传入的引擎，其次从设置读取
    const provider: TTSProvider = (input.ttsEngine as TTSProvider)
      || ProviderManager.getTTSConfig().provider as TTSProvider
      || 'edge';
    const voiceId: string | undefined = input.voiceId || undefined;

    // 收集待合成的段落列表
    let shots: Array<{ shotId: string; text: string; duration: number }> = [];

    // 优先从前端注入的 scriptShots 参数获取（步骤独立执行时 context.bus 为空）
    if (input.scriptShots && Array.isArray(input.scriptShots) && input.scriptShots.length > 0) {
      shots = input.scriptShots.map((s: any, idx: number) => ({
        shotId: s.shotId || s.id || `shot_${idx + 1}`,
        text: s.text || '',
        duration: s.duration || 3,
      })).filter((s: any) => s.text && s.text.trim().length > 0);
      AppLogger.info(LOG_TAGS.AI_AGENT, `TTS 从 scriptShots 获取到 ${shots.length} 段剧本文本`);
    }

    // 从 context.bus 中查找上游 script-gen 节点的产出
    if (shots.length === 0 && context.bus) {
      for (const [nodeId, busData] of context.bus.entries()) {
        if (nodeId.includes('script')) {
          if (busData?.shots && Array.isArray(busData.shots)) {
            shots = busData.shots.map((s: any, idx: number) => ({
              shotId: s.shotId || `shot_${idx + 1}`,
              text: s.text || '',
              duration: s.duration || 3,
            })).filter((s: any) => s.text && s.text.trim().length > 0);
          }
          if (shots.length > 0) break;
        }
      }
    }

    if (shots.length === 0) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, 'TTS 未找到前置剧本，返回空配音');
      return { _failed: true, _error: '未找到前置剧本文本，请先完成步骤3「解说文案」', audioPath: null, duration: 0 };
    }

    // 获取当前引擎的并发数
    const concurrency = ENGINE_CONCURRENCY[provider] || 3;
    onProgress(5, `并发合成 ${shots.length} 段配音 [${provider}] ×${concurrency} 路并行 ...`);

    // 使用 Promise.allSettled + 控制并发数 批量合成
    const settledResults = await runConcurrent(
      shots,
      concurrency,
      // 单段合成执行器
      async (shot, _idx) => {
        const audioPath = await AIEngine.generateTTS(shot.text, provider, cacheDir, voiceId);
        return { shotId: shot.shotId, text: shot.text, audioPath, duration: shot.duration } as TTSItemResult;
      },
      // 进度回调：每完成一段更新进度
      (completed, total, _idx) => {
        const progress = 5 + Math.floor((completed / total) * 90);
        onProgress(progress, `已完成 ${completed}/${total} 段 [${provider}] ...`);
      }
    );

    // 统计结果
    let successCount = 0;
    let failCount = 0;
    const results: TTSItemResult[] = settledResults.map((item, idx) => {
      if (item.error || !item.result) {
        failCount++;
        AppLogger.warn(LOG_TAGS.AI_AGENT, `TTS 第 ${idx + 1} 段 [${shots[idx].shotId}] 合成失败: ${item.error?.message}`);
        return {
          shotId: shots[idx].shotId,
          text: shots[idx].text,
          audioPath: null,
          duration: shots[idx].duration,
          _failed: true,
          _error: item.error?.message || '未知错误',
        };
      }
      successCount++;
      return item.result;
    });

    onProgress(100, `配音合成完成: ${successCount} 成功, ${failCount} 失败`);
    AppLogger.info(LOG_TAGS.AI_AGENT, `TTS 合成完毕: ${successCount}/${shots.length} 段成功 [${provider}] ×${concurrency}路并发`);

    // 返回逐段结果，供前端 mapPipelineResultToState 映射
    return { shots: results, provider, successCount, failCount };
  }
}
