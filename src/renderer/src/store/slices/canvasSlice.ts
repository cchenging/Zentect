// 📁 路径：src/renderer/src/store/slices/canvasSlice.ts
import type { StateCreator } from 'zustand';
import type { EditorState, FlowNode, FlowEdge, CanvasSlice } from '../storeTypes';
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import { initialNodes, initialEdges } from '../../pages/editor/components/semantic-flow/initialLayout';
import { HYDRATION_STATUS, NODE_STATUS } from '../constants';
import { IPC_CHANNELS } from '../../../../shared/utils/IpcConstants';

export const createCanvasSlice: StateCreator<EditorState, [], [], CanvasSlice> = (set, get) => ({
  nodes: initialNodes as FlowNode[],
  edges: initialEdges,
  hydrationStatus: HYDRATION_STATUS.IDLE, 
  activeWorkflowId: null, 
  isWorkflowLoading: false, 
  activeNode: null,

  setNodes: (nodes) => set((state) => ({ nodes: typeof nodes === 'function' ? nodes(state.nodes) : nodes })),
  setEdges: (edges) => set((state) => ({ edges: typeof edges === 'function' ? edges(state.edges) : edges })),

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) as FlowNode[] });
  },
  
  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  updateNodeData: (nodeId, newData) => {
    set({
      nodes: get().nodes.map((node) => 
        node.id === nodeId ? { ...node, data: { ...node.data, ...newData } } : node
      ) as FlowNode[]
    });
  },

  setActiveNode: (id, type) => set({ activeNode: id && type ? { id, type } : null }),

  addNode: (node) => set({ nodes: [...get().nodes, node] }),

  removeNode: (nodeId: string) => {
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId)
    }));
  },

  duplicateNode: (nodeId: string) => {
    const state = get();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    
    const newNode = {
      ...node,
      id: `n-${crypto.randomUUID().slice(0, 8)}`,
      position: { x: node.position.x + 40, y: node.position.y + 40 },
      selected: false,
      data: JSON.parse(JSON.stringify({ ...node.data, status: NODE_STATUS.IDLE, progress: 0 }))
    } as FlowNode;
    
    set({ nodes: [...state.nodes, newNode] });
  },

  resetCanvas: () => set({ 
    nodes: initialNodes as FlowNode[], 
    edges: initialEdges,
    hydrationStatus: HYDRATION_STATUS.IDLE, 
    activeNode: null 
  }),

  setHydrationStatus: (status) => set({ hydrationStatus: status }),

  // 💥 架构跃迁：彻底移除 setTimeout，实现极致的瞬时状态抽换 (Instant Morph)
  switchWorkflow: async (targetId: string, initialNodes?: FlowNode[], initialEdges?: FlowEdge[]) => {
    const currentId = get().activeWorkflowId;
    
    if (currentId && typeof window !== 'undefined' && window.api?.ipc?.send) {
      // 💥 修复根因：ipcRenderer.send 是单向通信，不返回 Promise，不能使用 .catch()
      // 直接发送即可，如果需要错误处理，应该在主进程监听或改为 invoke 模式
      try {
        window.api.ipc.send(IPC_CHANNELS.ENGINE_ABORT_PIPELINE, { projectId: currentId });
      } catch (err) {
        console.warn('通知主进程中止任务失败:', err);
      }
    }

    // 无延迟，直接用新快照覆盖当前内存
    set({
      activeWorkflowId: targetId,
      nodes: initialNodes || [],
      edges: initialEdges || [],
      isWorkflowLoading: false,
      hydrationStatus: HYDRATION_STATUS.READY
    });
  },

  updateNodeStatus: (nodeId, status, progress, results) => {
    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id === nodeId) {
          return {
            ...node,
            data: {
              ...node.data,
              status: status,
              ...(progress !== undefined && { progress }),
              ...(results && { results: { ...((node.data as any).results || {}), ...results } })
            }
          };
        }
        return node;
      }) as FlowNode[]
    }));
  },
});
