// 📁 src/renderer/src/pages/editor/hooks/useEditorLogic.ts
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore, useEditorStore } from '../../../store/useStore';
import { DraftService } from '../../../services/DraftService';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';
import { AppNotifier } from '../../../core/AppNotifier';
import { API } from '../../../api';
import { DEFAULT_WORKFLOW } from '../config/templates';

// ========================================================
// 💥 逻辑块 A：数据装载引擎 (Hydration) - 已增加防呆保护
// ========================================================
export const useEditorHydration = (id: string | undefined) => {
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) {
      navigate('/');
      return;
    }

    let isMounted = true;
    const store = useEditorStore.getState();
    store.resetProjectState();

    const init = async () => {
      useStore.getState().setHydrationStatus('LOADING');
      try {
        // 💥 修复根因 1：严格对齐 ProjectController 的单条查询信道
        const projectRes = await window.api.ipc.invoke(IPC_CHANNELS.PROJECT_GET_BY_ID, id);

        // 兼容 ipc 包装层可能的 .data 嵌套
        const currentProject = projectRes?.data || projectRes;
        if (!currentProject) throw new Error(`在数据库中未找到 ID 为 [${id}] 的项目`);

        if (isMounted) {
          store.setProjectMeta(currentProject.id, currentProject.name);
          useEditorStore.setState({ projectPath: currentProject.path });
        }

        // 2. 加载 L2 缓存 (IndexedDB 防止断电丢失) - 💥 使用带脏数据清洗的安全方法
        let parsedNodes: any[] = [];
        let parsedEdges: any[] = [];

        // 💥 修复：优先尝试从新的安全缓存恢复
        const canvasDraft = await DraftService.getCanvasDraft(id);

        if (isMounted && canvasDraft) {
          parsedNodes = canvasDraft.nodes || [];
          parsedEdges = canvasDraft.edges || [];
          // 恢复管线执行状态
          if (canvasDraft.workflowState) {
            const wfState = canvasDraft.workflowState;
            if (wfState === 'processing') {
              useEditorStore.getState().setWorkflowState('processing');
            }
          }
          console.log(`[Editor] 成功从 L2 缓存恢复项目 [${id}]`);
        } else {
          // 回退到旧的 canvasSnapshot 格式
          const localDraft = await DraftService.getDraft(id);

          if (localDraft?.canvasSnapshot) {
            const parsed = JSON.parse(localDraft.canvasSnapshot);
            parsedNodes = parsed.nodes || [];
            parsedEdges = parsed.edges || [];
          } else {
            // 💥 修复：如果本地没草稿（或草稿损坏被抛弃），退回空画布，或者尝试从主进程拉取项目初始状态
            const canvasData = typeof currentProject.canvasData === 'string'
              ? JSON.parse(currentProject.canvasData || '{}')
              : currentProject.canvasData;
            parsedNodes = canvasData?.nodes || [];
            parsedEdges = canvasData?.edges || [];

            // 💥 修复点：如果没有找到有效草稿（即全新创建的项目），自动注入默认的电影解说工作流
            if (parsedNodes.length === 0 && parsedEdges.length === 0) {
              parsedNodes = DEFAULT_WORKFLOW.nodes;
              parsedEdges = DEFAULT_WORKFLOW.edges;
              console.log(`[Editor] 新项目初始化完成，已加载默认工作流: ${DEFAULT_WORKFLOW.name}`);
            }
          }

          if (isMounted) {
            console.log(`[Editor] 未发现有效草稿，初始化空画布或数据库配置`);
          }
        }

        // 4. 将清洗后的数据推入 Zustand 状态机
        useStore.getState().setNodes(parsedNodes);
        useStore.getState().setEdges(parsedEdges);

        // 5. 初始化关联工作流状态
        if (!store.activeWorkflowId) {
          store.switchWorkflow(id, parsedNodes, parsedEdges);
        }

        // 6. 加载媒体资产列表（用于 SourceNode 封面显示、PlayerNode 播放等）
        if (isMounted) {
          try {
            const loadedMedia = await API.media.getByProject(id);
            if (Array.isArray(loadedMedia) && loadedMedia.length > 0) {
              useEditorStore.getState().setMediaItems(loadedMedia);
            }
          } catch (e) {
            console.warn('[Hydration] 加载媒体资产失败，不影响画布启动:', e);
          }
        }

        if (isMounted) useStore.getState().setHydrationStatus('READY');
      } catch (error) {
        console.error('[Editor Hydration Error]:', error);
        // 💥 修复：这里的 catch 作为双重保险，因为 DraftService 内部已经做了安全降级
        if (isMounted) {
          // 💥 修复点：异常时安全重置为默认工作流
          useStore.getState().setNodes(DEFAULT_WORKFLOW.nodes);
          useStore.getState().setEdges(DEFAULT_WORKFLOW.edges);
          AppNotifier.error('本地画布数据异常，已安全重置为默认工作流');
          useStore.getState().setHydrationStatus('ERROR');
        }
      }
    };

    init();

    return () => {
      isMounted = false;
    };
  }, [id, navigate]);
};

// ========================================================
// 💥 逻辑块 B：无感保存引擎 (AutoSave) - 已修复记忆丢失问题
// ========================================================
export const useEditorAutoSave = (id: string | undefined) => {
  // 1. 放弃 Zustand subscribe 兼容猜测，使用最稳健的原生 Hook 订阅数据流
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const status = useStore((state) => state.hydrationStatus);

  // 2. 响应式防抖落盘：只要节点或连线发生物理改变，500ms 后自动写入本地草稿库
  useEffect(() => {
    if (!id || status !== 'READY') return;

    const timer = setTimeout(() => {
      try {
        const snap = JSON.stringify({ nodes, edges });
        DraftService.saveDraft(id, snap).catch(() => {});
      } catch (e) {
        console.error('[AutoSave] 序列化画布数据失败:', e);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [nodes, edges, status, id]);

  // 3. 页面卸载拦截：关闭软件/刷新前，强制同步给主进程数据库
  useEffect(() => {
    if (!id) return;

    const handleBeforeUnload = () => {
      const state = useStore.getState();
      if (state.hydrationStatus === 'READY') {
        try {
          const snap = JSON.stringify({ nodes: state.nodes, edges: state.edges });
          DraftService.saveDraft(id, snap);
        } catch (e) {}
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [id]);
};

// ========================================================
// 💥 逻辑块 C：同步精灵 (Sync Daemon)
// ========================================================
export const useSyncDaemon = () => {
  useEffect(() => {
    if (!window.api?.ipc?.invoke) return;
    let isSyncing = false;

    const daemon = setInterval(async () => {
      if (isSyncing) return;
      isSyncing = true;
      try {
        const pending = await DraftService.getPendingDrafts();
        for (const draft of pending) {
          await window.api.ipc.invoke(
            IPC_CHANNELS.PROJECT_SAVE_CANVAS,
            draft.projectId,
            draft.canvasSnapshot
          );
          await DraftService.markAsSynced(draft.projectId);
        }
      } catch (err) {
        console.warn('[SyncDaemon] 同步异常:', err);
      } finally {
        isSyncing = false;
      }
    }, 5000);

    return () => clearInterval(daemon);
  }, []);
};
