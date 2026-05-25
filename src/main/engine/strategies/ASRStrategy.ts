// 📁 src/main/engine/strategies/ASRStrategy.ts
import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { PipelineTask } from '../../../shared/types';

export class ASRStrategy extends BaseNodeStrategy {
  readonly nodeType = 'asr';

  protected async performTask(
    task: PipelineTask, 
    context: ExecutionContext, 
    _cacheDir: string, 
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    const sourceMediaId = task.dependsOn?.[0]; 
    const sourceData = sourceMediaId ? context.bus.get(sourceMediaId) : null;
    
    // 优先从 audio-separate 节点的产物拿人声，如果没有则用源媒体
    const targetAudioPath = sourceData?.vocalAudioPath || sourceData?.filePath || task.mergedInputs?.mediaPath;

    if (!targetAudioPath) throw new Error('ASR 失败：未找到音频输入源，请检查连线。');

    onProgress(30, `正在进行语音识别...`);

    // 调用 AIEngine 进行 ASR
    // 目前这是模拟实现，未来可以接入真实的 Whisper
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    onProgress(100, 'success');

    return {
      textData: "模拟的台词识别结果",
      transcript: "模拟的完整转录文本"
    };
  }
}
