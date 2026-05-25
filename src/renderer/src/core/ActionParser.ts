import { useEditorStore } from '../store/useStore';
import { AppNotifier } from './AppNotifier';
import type { EditorNode, EditorEdge, PipelineTask, AIAction } from '../../../shared/types'; // 💥 统一引用
import { nodeParsers } from './parsers';
import { AICommandRegistry } from './commands';
import type { Node, Edge } from '@xyflow/react';

// 定义发往后端的纯净管线载荷
export interface PipelinePayload {
  nodes: Array<{
    id: string;
    type: string;
    data: any;
  }>;
  edges: Array<{
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
  }>;
}

export class ActionParser {
  static extractActions(aiReply: string): { cleanText: string, actions: AIAction[] } {
    const actions: AIAction[] = [];
    let cleanText = aiReply;

    const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/i;
    const match = aiReply.match(jsonBlockRegex);

    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1]);
        if (Array.isArray(parsed)) {
          actions.push(...parsed);
        } else if (parsed.action || parsed.type) {
           const type = parsed.type || parsed.action;
           actions.push({ ...parsed, type: type.toUpperCase() });
        }
        cleanText = aiReply.replace(jsonBlockRegex, '').trim();
      } catch (e) {
        console.error("AI 动作 JSON 解析失败", e);
      }
    }

    return { cleanText, actions };
  }

  static async executeActions(actions: AIAction[]) {
    if (!actions || actions.length === 0) return;

    const state = useEditorStore.getState();
    let executedCount = 0;

    for (const action of actions) {
      try {
        const command = AICommandRegistry.get(action.type);
        if (!command) {
           console.warn(`[ActionParser] 未知的 AI 动作类型: ${action.type}`);
           continue;
        }

        const success = await command.execute(action, state);
        if (success) executedCount++;

      } catch (e) {
        console.error(`执行动作 [${action.type}] 失败`, e);
      }
    }

    if (executedCount > 0) {
      AppNotifier.success(`AI 导演已执行 ${executedCount} 项剪辑调度`);
    }
  }

  /**
   * 将画布拓扑图编译为【确定性】的执行序列（带有溯源闭包打包）
   * 编译器现在可以确保生成的 sequence 是 100% 后端引擎可识别的
   */
  static compileToSequence(nodes: EditorNode[], edges: EditorEdge[], targetNodeId?: string): PipelineTask[] {
    const sequence: PipelineTask[] = [];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    
    const state = useEditorStore.getState();

    let validNodes = nodes.filter(n => n.data?.actionType);
    
    if (targetNodeId) {
      const target = nodeMap.get(targetNodeId);
      validNodes = target && target.type === 'processNode' && target.data?.actionType ? [target] : [];
    }

    if (validNodes.length === 0) {
      console.warn('[ActionParser] 画布上没有可执行的算力节点');
      return [];
    }

    const inDegree = new Map<string, number>();
    const graph = new Map<string, string[]>();
    
    validNodes.forEach(n => {
      inDegree.set(n.id, 0);
      graph.set(n.id, []);
    });

    edges.forEach(edge => {
      if (inDegree.has(edge.target) && inDegree.has(edge.source)) {
        inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
        graph.get(edge.source)?.push(edge.target);
      }
    });

    const queue: string[] = [];
    inDegree.forEach((degree, nodeId) => {
      if (degree === 0) queue.push(nodeId);
    });

    const sortedNodeIds: string[] = [];
    let queueIdx = 0;
    while (queueIdx < queue.length) {
      const currentId = queue[queueIdx++];
      sortedNodeIds.push(currentId);
      
      const neighbors = graph.get(currentId) || [];
      for (const neighbor of neighbors) {
        inDegree.set(neighbor, (inDegree.get(neighbor) || 0) - 1);
        if (inDegree.get(neighbor) === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (sortedNodeIds.length !== validNodes.length) {
      throw new Error("管线中存在循环连接(死循环)，请检查节点连线！");
    }

    // 构建入边映射：一次遍历 O(E)，替代每次 O(E) 的 filter
    const incomingEdgesMap = new Map<string, Array<{ source: string }>>();
    for (const edge of edges) {
      const list = incomingEdgesMap.get(edge.target);
      if (list) list.push(edge);
      else incomingEdgesMap.set(edge.target, [{ source: edge.source }]);
    }

    for (const nodeId of sortedNodeIds) {
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      const incomingEdges = incomingEdgesMap.get(nodeId) || [];
      const dependsOnIds = incomingEdges.map(e => e.source);

      const upstreamContext: Record<string, any> = {
        dependsOn: dependsOnIds,
      };
      
      for (const parentId of dependsOnIds) {
        const parentNode = nodeMap.get(parentId);
        if (!parentNode) continue;

        if (parentNode.data?.results) {
          Object.assign(upstreamContext, parentNode.data.results);
        }

        if (parentNode.data?.mediaId) {
          const media = state.mediaItems.find(m => m.id === parentNode.data.mediaId);
          if (media && media.filePath) {
             upstreamContext.mediaPath = media.filePath;
             upstreamContext.mediaWidth = media.width;
             upstreamContext.mediaHeight = media.height;
             upstreamContext.mediaFps = media.fps;
          }
        }
      }

      const actionType: string = node.data?.actionType ?? '';
      const parser = nodeParsers.get(actionType);
      
      if (!parser) {
        console.warn(`[ActionParser] 未知节点类型，使用降级编译策略: ${actionType}`);
        sequence.push({
          nodeId: node.id,
          actionType: actionType,
          label: node.data?.label || '未知任务',
          params: node.data?.params || {},
          dependsOn: dependsOnIds,
          mergedInputs: upstreamContext,
        });
        continue;
      }

      const task = parser.parse(node, upstreamContext);
      if (task) {
        sequence.push(task);
      }
    }

    return sequence;
  }

  /**
   * 💥 拓扑图提纯：剥离前端视觉属性，只保留算力引擎需要的有向无环图(DAG)核心数据
   */
  static compile(nodes: Node[], edges: Edge[]): PipelinePayload {
    if (!nodes || nodes.length === 0) {
      throw new Error('当前工作流为空，无法执行计算。');
    }

    const cleanNodes = nodes.map(node => ({
      id: node.id,
      type: node.type || 'unknown',
      data: node.data 
    }));

    const cleanEdges = edges.map(edge => ({
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle || undefined,
      targetHandle: edge.targetHandle || undefined
    }));

    return {
      nodes: cleanNodes,
      edges: cleanEdges
    };
  }
}
