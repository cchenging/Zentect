// 📁 路径: src/renderer/src/core/commands/DeleteCommand.ts
import type { IAICommand } from './types';
import type { AIAction } from '../../../../shared/types';
import { useEditorStore } from '../../store/useStore';

export class DeleteCommand implements IAICommand {
  async execute(action: AIAction, state: any): Promise<boolean> {
    if (action.targetId) {
      const isAiMode = state.storyboardMode === 'ai';
      const activeShots = isAiMode ? [...state.aiShots] : [...state.shots];
      
      const filteredShots = activeShots.filter(s => s.id !== action.targetId);
      
      if (isAiMode) {
        useEditorStore.setState({ aiShots: filteredShots });
      } else {
        useEditorStore.setState({ shots: filteredShots });
      }
      
      state.reorderShot('FORCE_DOMINO_TRIGGER', 0);
      return true;
    }
    return false;
  }
}