// — 路径：src/renderer/src/pages/editor/components/semantic-flow/index.tsx
import React, { useCallback, useState, useEffect, useRef } from 'react';
import { ReactFlow, Background, BackgroundVariant, MiniMap, Controls, addEdge, ConnectionLineType } from '@xyflow/react';
import type { Connection, Edge } from '@xyflow/react';
import { NodePicker } from './NodePicker';
import { NodeFloatingPanel } from './NodeFloatingPanel';
import '@xyflow/react/dist/style.css';
import { useEditorStore } from '../../../../store/useStore';
import { AppNotifier } from '../../../../core/AppNotifier';
import { WorkflowValidator } from '../../../../core/WorkflowValidator';

import { SourceNode } from './nodes/SourceNode';
import { ProcessNode } from './nodes/ProcessNode';
import { VectorNode } from './nodes/VectorNode';
import { ScriptNode } from './nodes/ScriptNode';
import { PlayerNode } from './nodes/PlayerNode';

// 注册所有节点类型
export const nodeTypes = {
  sourceNode: SourceNode,
  processNode: ProcessNode,
  vectorNode: VectorNode,
  scriptNode: ScriptNode,
  playerNode: PlayerNode,
};

export const SemanticWorkflow = () => {
  const { 
    nodes, edges, onNodesChange, onEdgesChange, updateNodeData, setActiveNode, setEdges 
  } = useEditorStore();
  
  // — 状态：记录 ReactFlow 实例（用于屏幕坐标到画布真实坐标的精准转换）
  const [rfInstance, setRfInstance] = useState<any>(null);

  // — 状态：控制菜单，携带源节点信息和允许的类型
  const [pickerConfig, setPickerConfig] = useState<{
    x: number, y: number, flowX?: number, flowY?: number, sourceNodeId?: string, sourceHandleId?: string | null, allowedTypes?: string[]
  } | null>(null);

  // — 局部新增 1：实时拖拽校验（使用 WorkflowValidator 统一校验规则）
  const isValidConnection = useCallback((connection: Connection) => {
    const errorMsg = WorkflowValidator.validateConnection(connection, nodes);
    return errorMsg === null;
  }, [nodes]);

  // — 局部更新 2：真实连接拦截器与数据落盘（使用 WorkflowValidator 统一校验）
  const onConnect = useCallback((params: Connection) => {
    // — 统一校验：使用独立校验器验证连线合法性
    const errorMsg = WorkflowValidator.validateConnection(params, nodes);
    if (errorMsg) {
      AppNotifier.warn(errorMsg);
      return;
    }

    const sourceNode = nodes.find((n) => n.id === params.source);
    const targetNode = nodes.find((n) => n.id === params.target);

    if (!sourceNode || !targetNode) return;

    const sourceAccent = sourceNode.data?.accent || 'blue';
    const accentColors: Record<string, string> = { blue: '#3b82f6', indigo: '#6366f1', purple: '#a855f7', emerald: '#10b981', amber: '#f59e0b', rose: '#f43f5e', green: '#22c55e' };
    const strokeColor = accentColors[sourceAccent] || '#3b82f6';

    const newEdge: Edge = {
      ...params,
      id: `e-${params.source}-${params.target}`,
      type: 'smoothstep',
      animated: true,
      style: { stroke: strokeColor, strokeWidth: 2 },
    };

    setEdges((eds) => addEdge(newEdge, eds));
    AppNotifier.success(`🔗 [${sourceNode.data?.label || '源'}] 已成功接入 [${targetNode.data?.label || '目标'}]`);

    // — 局部新增：魔王漫食堂专属播放脉络打通
    // 如果线连到了播放器，立刻把上游的媒体流推给全局 Player
    if (targetNode.type === 'playerNode') {
      const { setActivePlaySource, setActiveScript, setActiveShots, mediaItems: mediaItemsStore } = useEditorStore.getState();

      // — 防御性编程：确保 mediaItems 是数组
      const mediaItems = Array.isArray(mediaItemsStore) ? mediaItemsStore : [];

      // 1. 如果源头是【剧本重构】节点
      if (sourceNode.type === 'scriptNode') {
        const scriptContent = sourceNode.data?.content || "暂无生成的剧本内容...";
        setActiveScript(scriptContent);
        AppNotifier.success('📜 剧本内容已映射至监视器');
      }

      // 2. 如果源头是【视觉抽帧】节点
      if (sourceNode.data?.actionType === 'vision-extract' || sourceNode.data?.actionType === 'frame-extract') {
        const extractedShots = sourceNode.data?.results || []; // 假设 AI 抽帧结果存放在这里
        setActiveShots(extractedShots);
        AppNotifier.success('🖼️ 关键帧序列已映射至监视器');
      }
      
      // 3. 优先使用源节点的 mediaId 匹配实际媒体资产
      let targetMedia = null;
      const sourceMediaId = sourceNode.data?.mediaId;
      if (sourceMediaId) {
        targetMedia = mediaItems.find(m => m.id === sourceMediaId) as any;
      }
      // 回退：从源节点的 results 找媒体路径
      if (!targetMedia) {
        const upstreamResults = sourceNode.data?.results;
        if (upstreamResults?.mediaPath || upstreamResults?.filePath) {
          targetMedia = {
            id: sourceNode.id,
            filePath: upstreamResults.mediaPath || upstreamResults.filePath,
            name: upstreamResults.fileName || sourceNode.data?.label || '上游数据',
          } as any;
        }
      }
      // 兜底：取第一个媒体（兼容旧行为）
      if (!targetMedia) {
        targetMedia = mediaItems?.[0] as any;
      }

      if (targetMedia) {
         setActivePlaySource({
           id: (targetMedia as any).id as string,
           type: 'video',
           path: (targetMedia as any).filePath,
           filePath: (targetMedia as any).filePath,
           name: (targetMedia as any).name,
           thumbnail: (targetMedia as any).thumbnail || (targetMedia as any).coverPath,
           coverPath: (targetMedia as any).coverPath
         } as any);
         AppNotifier.success('📺 信号已成功接入监视器并开始预览');
      } else {
         AppNotifier.warn('当前源节点没有可用的媒体数据');
      }
    }
  }, [nodes, setEdges]);

  // 1. 标准化：使用 Ref 存储完整的起点上下文
  const connectionStart = useRef<{ nodeId: string | null; handleId: string | null }>({ nodeId: null, handleId: null });

  // 2. 标准化：利用官方回调精准记录
  const onConnectStart = useCallback((_, params) => {
    connectionStart.current = { nodeId: params.nodeId, handleId: params.handleId };
  }, []);

  // — 修复 1：使用变量锁定闭包状态，防止被同步清空
  const onConnectEnd = useCallback((event: any, connectionState?: any) => {
    if (!connectionStart.current.nodeId) return;

    if (connectionState && connectionState.isValid) {
      connectionStart.current = { nodeId: null, handleId: null };
      return;
    }

    const target = event.target as Element;
    const isNode = target?.closest?.('.react-flow__node');

    if (!isNode) {
      const { clientX, clientY } = 'changedTouches' in event ? event.changedTouches[0] : event;
      const flowPosition = rfInstance ? rfInstance.screenToFlowPosition({ x: clientX, y: clientY }) : { x: clientX, y: clientY };

      // 保存 sourceId 副本并立即设置 pickerConfig
      const sourceId = connectionStart.current.nodeId;
      const handleId = connectionStart.current.handleId;
      
      setPickerConfig({
        x: clientX,
        y: clientY,
        flowX: flowPosition.x,
        flowY: flowPosition.y,
        sourceNodeId: sourceId,
        sourceHandleId: handleId,
      });
    }

    connectionStart.current = { nodeId: null, handleId: null };
  }, [rfInstance]);

  // 📡 监听后端 AI 任务进度的"雷达"
  useEffect(() => {
    // 监听 Electron IPC 消息
    let removeListener: (() => void) | undefined;
    
    if (window.api?.ipc?.on && typeof window.api.ipc.on === 'function') {
      removeListener = (window.api as any).ipc?.on(
        'task:progress', 
        (_, { taskId, progress, status, message }) => {
          // 根据 taskId 匹配画布上的节点
          // 映射逻辑：vision_ext -> n-vision-ext, audio_ext -> n-audio-ext
      const nodeId = `n-${taskId.replace(/_/g, '-').replace(/--+/g, '-')}`; 
          
          updateNodeData(nodeId, {
            progress: progress * 100,
            status: status, // 'processing' | 'success' | 'error'
            metaLabel: message
          });
        }
      );
    }

    return () => {
      if (removeListener) {
        removeListener();
      }
    };
  }, [updateNodeData]);

  // 节点选择变化回调
  const onSelectionChange = useCallback(({ nodes }: { nodes: any[] }) => {
    if (nodes.length > 0) {
      const node = nodes[0];
      setActiveNode(node.id, node.type); // 同步到 Store
    } else {
      setActiveNode(null, null); // 清空选中，这会自动触发抽屉关闭
    }
  }, [setActiveNode]);

  // 定义精准的点击捕获函数
  const onNodeClick = useCallback((event, node) => {
    // 阻止冒泡，防止触发画布背景点击
    event.stopPropagation();
    // 记录当前激活节点（不再拉出旧式侧边栏，改用 BaseNode 伴生面板）
    setActiveNode(node.id, node.type);
  }, [setActiveNode]);

  // — 拦截画布右键事件
  const onPaneContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault(); // 阻止浏览器默认的原生右键菜单
    
    // 记录鼠标在屏幕上的物理坐标 (用于定位浮窗)
    setPickerConfig({
      x: event.clientX,
      y: event.clientY
    });
  }, []);

  // — 画布点击或拖拽时，关闭菜单
  const closePicker = useCallback(() => setPickerConfig(null), []);

  return (
    <div className="w-full h-full bg-background">
      {/* — 修复：画布容器使用 relative，但菜单使用 fixed 定位避免坐标偏移 */}
      <div className="relative w-full h-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onInit={setRfInstance}                // — 挂载实例获取
          onConnectStart={onConnectStart}       // — 挂载连线起点监听
          onConnectEnd={onConnectEnd}           // — 挂载连线松开监听
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}  // — 绑定节点点击
          onPaneClick={() => {
             closePicker();
             setActiveNode(null, null);
             useEditorStore.getState().setInspectorOpen(false);
          }} // — 绑定画布空白点击
          isValidConnection={isValidConnection as any} // 👈 挂载规则引擎
          onSelectionChange={onSelectionChange}
          nodeTypes={nodeTypes}
          connectionLineType={ConnectionLineType.SmoothStep}
          defaultViewport={{ x: 100, y: 100, zoom: 1 }}
          minZoom={0.2} maxZoom={1.5}
          deleteKeyCode={['Backspace', 'Delete']}
          multiSelectionKeyCode={['Control', 'Meta', 'Shift']}
          selectionOnDrag={true} // 允许框选
          panOnScroll={true}     // 允许触控板平滑移动
          // — 禁用 React Flow 标志
          attributionPosition={"bottom-left" as any}
          onPaneContextMenu={onPaneContextMenu as any}
          onMoveStart={closePicker as any}
        >
        <Background 
          variant={BackgroundVariant.Dots} 
          color="#3f3f46" 
          gap={28} 
          size={1.5} 
        />
        {/* — 缩小并锐化 MiniMap */}
        <MiniMap 
          position="top-right"
          style={{ 
            width: 180,
            height: 100,
            background: '#09090b',
            borderRadius: '8px', 
            border: '1px solid rgba(255,255,255,0.05)'
          }} 
          maskColor="rgba(0, 0, 0, 0.7)"
          nodeColor="#3b82f6"
          nodeStrokeWidth={3} 
          zoomable 
          pannable 
        />
        {/* — 修复：通过深度选择器彻底重塑控制块 UI，解决白底看不清图标问题 */}
        <Controls 
          showInteractive={false}
          className="bg-zinc-900 border-zinc-800 p-1 rounded-lg flex flex-col gap-1 shadow-2xl
            [&_button]:bg-zinc-900 [&_button]:border-zinc-800 [&_button]:text-zinc-400 
            [&_button:hover]:bg-zinc-800 [&_button:hover]:text-zinc-100 
            [&_button]:transition-colors [&_svg]:fill-zinc-400 [&_path]:fill-zinc-400" 
        />
        </ReactFlow>
      </div>

      {/* — 挂载悬浮菜单（使用 fixed 定位，所以要放在外层） */}
      <NodePicker 
        config={pickerConfig} 
        onClose={closePicker} 
        rfInstance={rfInstance}
      />

      {/* 选中节点时在节点下方显示浮动配置面板 */}
      <NodeFloatingPanel />
    </div>
  );
};