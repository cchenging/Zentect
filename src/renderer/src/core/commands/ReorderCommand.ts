// 📁 路径: src/renderer/src/core/commands/ReorderCommand.ts
import type { IAICommand } from './types';
import type { AIAction } from '../../../../shared/types';
import { useProjectStore } from '../../../../modules/editor/stores/useProjectStore';

export class ReorderCommand implements IAICommand {
  async execute(action: AIAction, _state: any): Promise<boolean> {
    if (action.targetId && action.targetIndex !== undefined && action.targetIndex >= 0) {
      const projectState = useProjectStore.getState();
      const isAiMode = projectState.storyboardMode === 'ai';
      const activeShots = isAiMode ? [...projectState.aiShots] : [...projectState.shots];

      const fromIndex = activeShots.findIndex(s => s.id === action.targetId);
      if (fromIndex !== -1) {
        const [movedItem] = activeShots.splice(fromIndex, 1);
        activeShots.splice(action.targetIndex, 0, movedItem);

        if (isAiMode) {
          useProjectStore.setState({ aiShots: activeShots });
        } else {
          useProjectStore.setState({ shots: activeShots });
        }

        projectState.reorderShot('FORCE_DOMINO_TRIGGER', 0);
        return true;
      }
    }
    return false;
  }
}
