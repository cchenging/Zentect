// 📁 路径：src/renderer/src/core/ContextCompressor.ts
import { useEditorStore } from '../store/useStore';
import { usePlayerStore } from '@modules/editor/stores/usePlayerStore';

export class ContextCompressor {
  /**
   * 获取当前工程的 AI 记忆快照
   * 把庞大的工程状态降维压缩成 AI 能看懂的极简 JSON 摘要
   */
  static getCompressedSnapshot() {
    const state = useEditorStore.getState();
    const playerState = usePlayerStore.getState();

    const activeShots = state.storyboardMode === 'ai' ? state.aiShots : state.shots;

    // 1. 扩容：引入视觉感知字段
    const compressedTimeline = activeShots.map((shot, index) => ({
      index: index + 1,
      id: shot.id,
      timeRange: `${Math.floor(shot.start)}s - ${Math.floor(shot.end)}s`,
      text: state.storyboardMode === 'ai' ? shot.aiText : shot.originalText,
      visionText: shot.visionText || '无视觉描述',
      isPureVisual: !(state.storyboardMode === 'ai' ? shot.aiText : shot.originalText)
    }));

    // 2. 扩容：打通素材池感知
    const mediaSummary = state.mediaItems.map(m => ({
      mediaId: m.id,
      name: m.name,
      type: m.type,
      duration: m.duration,
      // 提取前 50 个字符作为摘要，让大模型了解备用素材内容
      contentHint: m.extractedText ? (m.extractedText.substring(0, 50) + '...') : '未提取或无台词'
    }));

    // 3. 组装终极上下文
    return JSON.stringify({
      environment: {
        mode: state.storyboardMode,
        projectRatio: state.projectRatio,
        currentTime: Math.floor(playerState.currentTime)
      },
      timeline: compressedTimeline,
      mediaPool: mediaSummary
    });
  }
}
