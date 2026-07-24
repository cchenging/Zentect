// 📁 路径: src/renderer/src/core/commands/AddShotCommand.ts
import type { IAICommand } from './types';
import type { AIAction } from '../../../../shared/types';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';

export class AddShotCommand implements IAICommand {
  async execute(action: AIAction, _state: any): Promise<boolean> {
    if (action.mediaId && action.targetIndex !== undefined) {
      const projectState = useProjectStore.getState();
      const media = projectState.mediaItems.find(m => m.id === action.mediaId);
      if (media) {
        const isAiMode = projectState.storyboardMode === 'ai';
        const activeShots = isAiMode ? [...projectState.aiShots] : [...projectState.shots];

        const newShot: any = {
          id: `ai_shot_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          mediaId: media.id,
          start: 0,
          end: 3.0,
          originalText: action.newText || '',
          aiText: action.newText || '',
          roleId: projectState.roles.length > 0 ? projectState.roles[0].id : 'default',
          coverPath: media.coverPath || '',
          visionText: 'AI 自动检索插入素材'
        };

        const safeIndex = Math.max(0, Math.min(action.targetIndex, activeShots.length));
        activeShots.splice(safeIndex, 0, newShot);

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
