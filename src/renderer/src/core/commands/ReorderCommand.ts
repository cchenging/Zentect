// 📁 路径: src/renderer/src/core/commands/ReorderCommand.ts
import type { IAICommand } from './types';
import type { AIAction } from '../../../../shared/types';
import { useEditorStore } from '../../store/useStore';

export class ReorderCommand implements IAICommand {
  async execute(action: AIAction, state: any): Promise<boolean> {
    if (action.targetId && action.targetIndex !== undefined && action.targetIndex >= 0) {
      const isAiMode = state.storyboardMode === 'ai';
      const activeShots = isAiMode ? [...state.aiShots] : [...state.shots];
      
      const fromIndex = activeShots.findIndex(s => s.id === action.targetId);
      if (fromIndex !== -1) {
        const [movedItem] = activeShots.splice(fromIndex, 1);
        activeShots.splice(action.targetIndex, 0, movedItem);
        
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