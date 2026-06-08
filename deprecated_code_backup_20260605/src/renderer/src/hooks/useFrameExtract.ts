// 📁 路径：src/renderer/src/hooks/useFrameExtract.ts
// 画布节点系统已移除，此 hook 暂不可用，返回空数据 + 警告日志

/**
 * 抽帧配置 Hook（暂不可用）
 * 画布节点系统已移除，返回默认值和空操作
 */
export const useFrameExtract = (_nodeId: string, _projectId?: string) => {
  console.warn('[useFrameExtract] 画布节点系统已移除，此 hook 暂不可用');
  return {
    fps: 1,
    strategy: 'uniform' as const,
    handleFpsChange: () => {},
    handleStrategyChange: () => {},
    refreshResults: async () => {},
  };
};
