// 📁 路径: src/renderer/src/core/commands/SearchBrollCommand.ts
import type { IAICommand } from './types';
import type { AIAction } from '../../../../shared/types';
import { useEditorStore } from '../../store/useStore';
import { AppNotifier } from '../AppNotifier';
import { API } from '../../api';

export class SearchBrollCommand implements IAICommand {
  async execute(action: AIAction, state: any): Promise<boolean> {
    if (action.query && action.targetIndex !== undefined) {
      AppNotifier.info(`正在为您检索画面：${action.query}...`);
      
      try {
        // 💥 重构点：使用 API 防腐层
        const searchResult = await API.engine.searchBroll(action.query, state.projectId);
        
        if (searchResult.success && searchResult.mediaId) {
          const media = state.mediaItems.find(m => m.id === searchResult.mediaId);
          if (media) {
            const isAiMode = state.storyboardMode === 'ai';
            const activeShots = isAiMode ? [...state.aiShots] : [...state.shots];
            
            const newShot: any = {
              id: `ai_shot_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              mediaId: media.id,
              start: 0,
              end: 3.0, 
              originalText: action.newText || '',
              aiText: action.newText || '',
              roleId: state.roles.length > 0 ? state.roles[0].id : 'default',
              coverPath: media.coverPath || '',
              visionText: `[CLIP 向量匹配] ${action.query}`
            };
            
            const safeIndex = Math.max(0, Math.min(action.targetIndex, activeShots.length));
            activeShots.splice(safeIndex, 0, newShot);
            
            if (isAiMode) useEditorStore.setState({ aiShots: activeShots });
            else useEditorStore.setState({ shots: activeShots });
            
            state.reorderShot('FORCE_DOMINO_TRIGGER', 0);
            return true;
          }
        }
        AppNotifier.warn(`检索无果：暂无符合 "${action.query}" 的素材`);
      } catch (e) {
        console.error("向量检索报错:", e);
      }
    }
    return false;
  }
}