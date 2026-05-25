/** V1.3: QuickCard 专属 Zustand Store
 *  存放跨组件共享业务数据（publishConfig），与 Editor 的 EditorStore 独立
 *  通过 subscribeWithSelector 实现细粒度订阅
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { PublishConfig } from '../../../shared/types/publish';
import { EMPTY_PUBLISH_CONFIG } from '../../../shared/types/publish';

interface QuickCardState {
  /** 发布素材配置：StepPublish 写，PublishEditor 读写，ExportPanel 读 */
  publishConfig: PublishConfig;
  setPublishConfig: (config: PublishConfig) => void;
  resetPublishConfig: () => void;
}

export const useQuickCardStore = create<QuickCardState>()(
  subscribeWithSelector((set) => ({
    publishConfig: EMPTY_PUBLISH_CONFIG,
    setPublishConfig: (config) => set({ publishConfig: config }),
    resetPublishConfig: () => set({ publishConfig: EMPTY_PUBLISH_CONFIG }),
  }))
);