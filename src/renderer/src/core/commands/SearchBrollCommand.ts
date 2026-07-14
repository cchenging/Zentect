// 📁 路径: src/renderer/src/core/commands/SearchBrollCommand.ts
import type { IAICommand } from './types';
import type { AIAction } from '../../../../shared/types';
import { useProjectStore } from '../../../../modules/editor/stores/useProjectStore';
import { AppNotifier } from '../AppNotifier';
import { API } from '../../api';

export class SearchBrollCommand implements IAICommand {
  async execute(action: AIAction, _state: any): Promise<boolean> {
    if (action.query && action.targetIndex !== undefined) {
      AppNotifier.info(`正在为您检索画面：${action.query}...`);

      try {
        const projectState = useProjectStore.getState();
        const searchResult = await API.engine.searchBroll(action.query, projectState.projectId);

        if (searchResult.success && searchResult.mediaId) {
          const media = projectState.mediaItems.find(m => m.id === searchResult.mediaId);
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
              visionText: `[CLIP 向量匹配] ${action.query}`
            };

            const safeIndex = Math.max(0, Math.min(action.targetIndex, activeShots.length));
            activeShots.splice(safeIndex, 0, newShot);

            if (isAiMode) useProjectStore.setState({ aiShots: activeShots });
            else useProjectStore.setState({ shots: activeShots });

            projectState.reorderShot('FORCE_DOMINO_TRIGGER', 0);
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
