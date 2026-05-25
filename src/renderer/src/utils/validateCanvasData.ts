// 📁 路径：src/renderer/src/utils/validateCanvasData.ts

// 💥 修复核心：必须加上 `type` 关键字！明确告诉 Vite 这是类型导入，运行时直接擦除
import type { FlowNode, FlowEdge } from '../store/storeTypes';

/**
 * 💥 Phase 2.3: 画布数据验证器
 * 职责：验证从数据库读取的 JSON 数据是否合法
 * 原则：防御性编程，防止脏数据导致应用崩溃
 */

export interface CanvasData {
  nodes: FlowNode[];
  edges: FlowEdge[];
  workflowState?: 'idle' | 'processing' | 'finetuning';
}

export const validateCanvasData = (data: any): CanvasData => {
  // 1. 基础类型检查
  if (!data || typeof data !== 'object') {
    throw new Error('画布数据格式错误：必须是非空对象');
  }

  // 2. 检查 nodes 字段
  if (!data.nodes) {
    throw new Error('画布数据格式错误：缺少 nodes 字段');
  }
  
  if (!Array.isArray(data.nodes)) {
    throw new Error('画布数据格式错误：nodes 必须是数组');
  }

  // 3. 检查 edges 字段
  if (!data.edges) {
    throw new Error('画布数据格式错误：缺少 edges 字段');
  }
  
  if (!Array.isArray(data.edges)) {
    throw new Error('画布数据格式错误：edges 必须是数组');
  }

  // 4. 验证每个节点的必需字段
  for (const node of data.nodes) {
    if (!node.id) {
      throw new Error('节点数据错误：缺少 id 字段');
    }
    
    if (!node.position || typeof node.position !== 'object') {
      throw new Error(`节点 ${node.id} 数据错误：缺少有效的 position 字段`);
    }
    
    if (typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
      throw new Error(`节点 ${node.id} 数据错误：position 坐标必须是数字`);
    }
    
    if (!node.type) {
      throw new Error(`节点 ${node.id} 数据错误：缺少 type 字段`);
    }
    
    // 验证 type 是否合法
    const validTypes = ['sourceNode', 'processNode', 'vectorNode', 'scriptNode', 'playerNode'];
    if (!validTypes.includes(node.type)) {
      throw new Error(`节点 ${node.id} 数据错误：未知的节点类型 "${node.type}"`);
    }
    
    // 验证 data 字段（可选，但如果存在必须是对象）
    if (node.data !== undefined && (typeof node.data !== 'object' || node.data === null)) {
      throw new Error(`节点 ${node.id} 数据错误：data 字段必须是对象`);
    }
  }

  // 5. 验证每条连线的必需字段
  for (const edge of data.edges) {
    if (!edge.id) {
      throw new Error('连线数据错误：缺少 id 字段');
    }
    
    if (!edge.source) {
      throw new Error(`连线 ${edge.id} 数据错误：缺少 source 字段`);
    }
    
    if (!edge.target) {
      throw new Error(`连线 ${edge.id} 数据错误：缺少 target 字段`);
    }
    
    // 验证 source 和 target 是否对应真实存在的节点
    const sourceNode = data.nodes.find((n: any) => n.id === edge.source);
    const targetNode = data.nodes.find((n: any) => n.id === edge.target);
    
    if (!sourceNode) {
      console.warn(`连线 ${edge.id} 警告：源节点 ${edge.source} 不存在`);
    }
    
    if (!targetNode) {
      console.warn(`连线 ${edge.id} 警告：目标节点 ${edge.target} 不存在`);
    }
  }

  // 6. 返回验证通过的数据
  return data as CanvasData;
};

/**
 * 💥 安全解析器：结合 JSON.parse 和验证
 */
export const safeParseCanvasData = (jsonString: string): CanvasData | null => {
  try {
    const parsed = JSON.parse(jsonString);
    return validateCanvasData(parsed);
  } catch (error: any) {
    console.error('[CanvasDataValidator] 解析失败:', error.message);
    return null;
  }
};

/**
 * 💥 容错恢复：如果验证失败，返回默认的空画布数据
 */
export const recoverCanvasData = (data: any): CanvasData => {
  try {
    return validateCanvasData(data);
  } catch (error: any) {
    console.warn('[CanvasDataValidator] 数据验证失败，使用默认空画布:', error.message);
    return {
      nodes: [],
      edges: []
    };
  }
};