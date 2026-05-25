// 📁 新增文件: src/main/engine/strategies/TTSStrategy.ts
import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { PipelineTask } from '../../../shared/types';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../shared/utils/LogConstants';
import { AIEngine } from '../AIEngine';
import * as path from 'path';

export class TTSStrategy extends BaseNodeStrategy {
  readonly nodeType = 'tts-synthesize';
  readonly isRecoverable = true;

  protected async performTask(
    task: PipelineTask, 
    context: ExecutionContext, 
    cacheDir: string, 
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    let textToSpeech = task.params?.text;

    if (!textToSpeech && task.dependsOn) {
      for (const depId of task.dependsOn) {
        const busData = context.bus.get(depId);
        if (busData) {
          if (typeof busData === 'string') {
            textToSpeech = busData;
          } else if (busData.shots) {
            textToSpeech = busData.shots.map((s: any) => s.text || '').join('\n');
          } else if (Array.isArray(busData)) {
            textToSpeech = busData.map((s: any) => s.text || '').join('\n');
          } else if (busData.scriptText) {
            textToSpeech = busData.scriptText;
          } else if (busData.transcript) {
            textToSpeech = busData.transcript;
          } else if (busData.outputText) {
            textToSpeech = busData.outputText;
          }
        }
        if (textToSpeech) break;
      }
    }

    if (!textToSpeech) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, 'TTS 未找到前置剧本，返回空配音');
      return { _failed: true, _error: '未找到前置剧本文本', audioPath: null, duration: 0 };
    }

    onProgress(20, '正在连接语音合成服务...');

    const voiceType = task.params?.voiceType || 'default_voice';
    const outputPath = path.join(cacheDir, `tts_${Date.now()}.mp3`);

    // 调用现有的 TTS 业务
    try {
      const ttsResult = await AIEngine.generateTTS(textToSpeech, voiceType);
      onProgress(80, '音频流接收中...');
      
      return {
        audioPath: outputPath,
        ttsResult: ttsResult,
        duration: 0
      };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, 'TTS 接口调用失败', e);
      // 不 throw —— 返回降级结果，由 BaseNodeStrategy.isRecoverable 捕获并继续
      return { _failed: true, _error: `TTS 合成失败: ${e.message}`, audioPath: null, duration: 0 };
    }
  }
}
