// 📁 路径: src/renderer/src/core/commands/index.ts
import type { IAICommand } from './types';
import { SearchBrollCommand } from './SearchBrollCommand';
import { UpdateTextCommand } from './UpdateTextCommand';
import { ReorderCommand } from './ReorderCommand';
import { DeleteCommand } from './DeleteCommand';
import { AddShotCommand } from './AddShotCommand';

export const AICommandRegistry = new Map<string, IAICommand>([
  ['SEARCH_BROLL', new SearchBrollCommand()],
  ['UPDATE_TEXT', new UpdateTextCommand()],
  ['REORDER', new ReorderCommand()],
  ['DELETE', new DeleteCommand()],
  ['ADD_SHOT', new AddShotCommand()]
]);