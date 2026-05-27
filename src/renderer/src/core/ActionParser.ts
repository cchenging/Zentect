import { useEditorStore } from '../store/useStore';
import { AppNotifier } from './AppNotifier';
import type { PipelineTask, AIAction } from '../../../shared/types';
import { nodeParsers } from './parsers';
import { AICommandRegistry } from './commands';
import type { PipelineNodeRef } from './parsers/types';

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

  static compileToSequence(nodes: PipelineNodeRef[], edges: { source: string; target: string }[], targetNodeId?: string): PipelineTask[] {
    const sequence: PipelineTask[] = [];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    let validNodes = nodes.filter(n => n.data?.actionType);

    if (targetNodeId) {
      const target = nodeMap.get(targetNodeId);
      validNodes = target && target.data?.actionType ? [target] : [];
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

    const incomingEdgesMap = new Map<string, Array<{ source: string }>>();
    for (const edge of edges) {
      const list = incomingEdgesMap.get(edge.target);
      if (list) list.push(edge);
      else incomingEdgesMap.set(edge.target, [{ source: edge.source }]);
    }

    for (const nodeId of sortedNodeIds) {
      const node = nodeMap.get(nodeId)!;
      const upstreamContext: Record<string, any> = {};

      const incomingEdges = incomingEdgesMap.get(nodeId) || [];
      for (const inEdge of incomingEdges) {
        const srcNode = nodeMap.get(inEdge.source);
        if (srcNode) {
          const srcTask = sequence.find(t => t.nodeId === srcNode.id);
          if (srcTask?.result) {
            Object.assign(upstreamContext, srcTask.result);
          }
        }
      }

      for (const [parserKey, parser] of Object.entries(nodeParsers)) {
        const task = parser.parse(node, upstreamContext);
        if (task) {
          sequence.push(task);
          break;
        }
      }
    }

    return sequence;
  }
}
