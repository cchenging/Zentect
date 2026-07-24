// 📁 路径: src/renderer/src/core/commands/UpdateTextCommand.ts
import type { IAICommand } from './types';
import type { AIAction } from '../../../../shared/types';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';

export class UpdateTextCommand implements IAICommand {
  async execute(action: AIAction, _state: any): Promise<boolean> {
    if (action.targetId && action.newText !== undefined) {
      const projectState = useProjectStore.getState();
      const isAiMode = projectState.storyboardMode === 'ai';

      if (isAiMode) {
        projectState.updateAiShot(action.targetId, { aiText: action.newText });
      } else {
        projectState.updateShot(action.targetId, { originalText: action.newText });
      }

      return true;
    }
    return false;
  }
}
