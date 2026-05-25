// 📁 路径: src/renderer/src/core/commands/UpdateTextCommand.ts
import type { IAICommand } from './types';
import type { AIAction } from '../../../../shared/types';

export class UpdateTextCommand implements IAICommand {
  async execute(action: AIAction, state: any): Promise<boolean> {
    if (action.targetId && action.newText !== undefined) {
      const isAiMode = state.storyboardMode === 'ai';
      
      if (isAiMode) {
        state.updateAiShot(action.targetId, { aiText: action.newText });
      } else {
        state.updateShot(action.targetId, { originalText: action.newText });
      }
      
      return true;
    }
    return false;
  }
}