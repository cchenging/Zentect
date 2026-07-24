// 📁 路径: src/renderer/src/core/commands/DeleteCommand.ts
import type { IAICommand } from './types';
import type { AIAction } from '../../../../shared/types';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';

export class DeleteCommand implements IAICommand {
  async execute(action: AIAction, _state: any): Promise<boolean> {
    if (action.targetId) {
      const projectState = useProjectStore.getState();
      const isAiMode = projectState.storyboardMode === 'ai';
      const activeShots = isAiMode ? [...projectState.aiShots] : [...projectState.shots];

      const filteredShots = activeShots.filter(s => s.id !== action.targetId);

      if (isAiMode) {
        useProjectStore.setState({ aiShots: filteredShots });
      } else {
        useProjectStore.setState({ shots: filteredShots });
      }

      projectState.reorderShot('FORCE_DOMINO_TRIGGER', 0);
      return true;
    }
    return false;
  }
}
