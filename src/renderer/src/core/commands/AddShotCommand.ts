// 📁 路径: src/renderer/src/core/commands/AddShotCommand.ts
import type { IAICommand } from './types';
import type { AIAction } from '../../../../shared/types';
import { useEditorStore } from '../../store/useStore';

export class AddShotCommand implements IAICommand {
  async execute(action: AIAction, state: any): Promise<boolean> {
    if (action.mediaId && action.targetIndex !== undefined) {
      const media = state.mediaItems.find(m => m.id === action.mediaId);
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
          visionText: 'AI 自动检索插入素材'
        };
        
        const safeIndex = Math.max(0, Math.min(action.targetIndex, activeShots.length));
        activeShots.splice(safeIndex, 0, newShot);
        
        if (isAiMode) {
          useEditorStore.setState({ aiShots: activeShots });
        } else {
          useEditorStore.setState({ shots: activeShots });
        }
        
        state.reorderShot('FORCE_DOMINO_TRIGGER', 0);
        return true;
      }
    }
    return false;
  }
}