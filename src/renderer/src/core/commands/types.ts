import type { AIAction } from '../../../../shared/types';
import type { EditorState } from '../../store/storeTypes';

export interface IAICommand {
  execute(action: AIAction, state: EditorState): Promise<boolean>;
}