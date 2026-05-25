// 📁 路径：src/renderer/src/core/WorkflowValidator.ts

import type { Connection } from '@xyflow/react';
import type { FlowNode } from '../store/storeTypes';
import { CONNECTION_RULES } from '../store/constants';

/**
 * 工作流连线校验器
 * 职责：将连线校验规则从 UI 组件中剥离，提供独立的业务校验逻辑
 * 原则：单一职责，只负责校验并返回结果，不直接操作 UI
 */
export class WorkflowValidator {
  /**
   * 校验连线是否合法，返回错误信息（若为 null 则表示校验通过）
   * 
   * @param params React Flow 的 Connection 对象
   * @param nodes 当前画布所有节点
   * @returns 错误信息字符串，校验通过返回 null
   */
  static validateConnection(params: Connection, nodes: FlowNode[]): string | null {
    const sourceNode = nodes.find(n => n.id === params.source);
    const targetNode = nodes.find(n => n.id === params.target);

    // 防御 1：节点丢失
    if (!sourceNode || !targetNode) {
      return '连线错误：源节点或目标节点不存在';
    }

    // 防御 2：防止节点自己连自己（自环）
    if (sourceNode.id === targetNode.id) {
      return '连线错误：禁止节点自环';
    }

    // 防御 3：查表校验类型拓扑合法性
    const allowedTargets = CONNECTION_RULES[sourceNode.type] || [];
    if (!allowedTargets.includes(targetNode.type)) {
      return `连线错误：[${sourceNode.data?.label || sourceNode.type}] 不能连接到 [${targetNode.data?.label || targetNode.type}]`;
    }

    // 防御 4：禁止同类 ProcessNode 互连（防止冗余计算链路）
    if (sourceNode.type === 'processNode' && targetNode.type === 'processNode') {
      if (sourceNode.data?.label === targetNode.data?.label) {
        return `冗余连接：禁止将两个 [${sourceNode.data.label}] 节点串联`;
      }
    }

    // 防御 5：Vector 节点只能作为数据汇聚层，只能输出给剧本节点
    if (sourceNode.type === 'vectorNode') {
      if (targetNode.type !== 'scriptNode') {
        return '特征向量只能输出给剧本节点';
      }
    }

    // 所有校验通过
    return null;
  }

  /**
   * 批量校验：校验多条连线（用于导入工作流模板等场景）
   * 
   * @param connections 待校验的连线列表
   * @param nodes 当前画布所有节点
   * @returns 校验结果数组，每项包含 connection 和 error（若为 null 表示通过）
   */
  static validateConnections(connections: Connection[], nodes: FlowNode[]): { connection: Connection; error: string | null }[] {
    return connections.map(conn => ({
      connection: conn,
      error: this.validateConnection(conn, nodes),
    }));
  }
}
