// 📁 新建文件: src/main/mcp/MCPClient.ts
// V1.2: MCP 客户端骨架 — 初始化注册表和 stdio 传输通道，具体服务端注册留 V2.0

import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

// — MCP 协议类型定义（JSON-RPC 2.0 子集）—

/** MCP 工具定义 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

/** MCP 资源定义 */
export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** JSON-RPC 请求 */
interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, any>;
}

/** MCP 连接状态 */
type MCPConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** MCP 传输通道 — 目前仅实现 stdio */
interface MCPTransport {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

// — MCP 客户端 —

export class MCPClient extends EventEmitter {
  private tools: Map<string, MCPTool> = new Map();
  private resources: Map<string, MCPResource> = new Map();
  private connectedServers: Map<string, MCPConnectionState> = new Map();
  private childProcesses: Map<string, ChildProcess> = new Map();
  private requestId = 0;

  // =========================================================================
  // 🔧 工具注册表（本地注册，V2.0 扩展为远程服务器工具发现）
  // =========================================================================

  /** 注册本地工具 */
  registerTool(tool: MCPTool): void {
    this.tools.set(tool.name, tool);
    AppLogger.info(LOG_TAGS.SYSTEM, `[MCP] 注册工具: ${tool.name}`);
  }

  /** 注销工具 */
  unregisterTool(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) AppLogger.info(LOG_TAGS.SYSTEM, `[MCP] 注销工具: ${name}`);
    return deleted;
  }

  /** 列出已注册工具 */
  listTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }

  /** 获取指定工具 */
  getTool(name: string): MCPTool | undefined {
    return this.tools.get(name);
  }

  // =========================================================================
  // 📁 资源注册表（本地注册，V2.0 扩展为远程资源发现）
  // =========================================================================

  /** 注册本地资源 */
  registerResource(resource: MCPResource): void {
    this.resources.set(resource.uri, resource);
  }

  /** 列出已注册资源 */
  listResources(): MCPResource[] {
    return Array.from(this.resources.values());
  }

  // =========================================================================
  // 🔗 Stdio 传输通道（骨架 — V2.0 实现完整握手协议）
  // =========================================================================

  /**
   * 连接远程 MCP 服务器（stdio 传输）
   * V1.2: 骨架 — 仅验证命令是否存在，不执行完整握手
   * V2.0: 实现 initialize → tools/list → resources/list 完整协议
   */
  async connectServer(serverId: string, transport: MCPTransport): Promise<void> {
    if (this.connectedServers.get(serverId) === 'connected') {
      AppLogger.warn(LOG_TAGS.SYSTEM, `[MCP] 服务器 ${serverId} 已连接`);
      return;
    }

    AppLogger.info(LOG_TAGS.SYSTEM, `[MCP] 正在连接服务器: ${serverId} (${transport.command} ${(transport.args || []).join(' ')})`);

    this.connectedServers.set(serverId, 'connecting');

    try {
      // V1.2 骨架: 仅启动子进程，不执行 JSON-RPC 握手
      // V2.0: 此处将添加 initialize 请求 + tools/list 发现
      const child = spawn(transport.command, transport.args || [], {
        env: { ...process.env, ...(transport.env || {}) },
        cwd: transport.cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.childProcesses.set(serverId, child);

      child.on('error', (err) => {
        AppLogger.error(LOG_TAGS.SYSTEM, `[MCP] 服务器 ${serverId} 子进程错误`, err);
        this.connectedServers.set(serverId, 'error');
        this.emit('error', { serverId, error: err });
      });

      child.on('exit', (code) => {
        AppLogger.info(LOG_TAGS.SYSTEM, `[MCP] 服务器 ${serverId} 进程退出, code=${code}`);
        this.connectedServers.set(serverId, 'disconnected');
        this.childProcesses.delete(serverId);
        this.emit('disconnect', { serverId, code });
      });

      // 监听 stdout — V2.0 将解析 JSON-RPC 响应
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        AppLogger.debug(LOG_TAGS.SYSTEM, `[MCP] ${serverId} stdout: ${text.slice(0, 200)}`);
      });

      child.stderr?.on('data', (data: Buffer) => {
        AppLogger.warn(LOG_TAGS.SYSTEM, `[MCP] ${serverId} stderr: ${data.toString().slice(0, 200)}`);
      });

      this.connectedServers.set(serverId, 'connected');
      AppLogger.info(LOG_TAGS.SYSTEM, `[MCP] 服务器 ${serverId} 连接成功（骨架模式）`);

    } catch (err: any) {
      this.connectedServers.set(serverId, 'error');
      AppLogger.error(LOG_TAGS.SYSTEM, `[MCP] 连接服务器 ${serverId} 失败`, err);
      throw err;
    }
  }

  /** 断开服务器连接 */
  disconnectServer(serverId: string): void {
    const child = this.childProcesses.get(serverId);
    if (child && !child.killed) {
      child.kill();
      AppLogger.info(LOG_TAGS.SYSTEM, `[MCP] 终止服务器子进程: ${serverId}`);
    }
    this.childProcesses.delete(serverId);
    this.connectedServers.set(serverId, 'disconnected');
  }

  /** 断开所有服务器连接 */
  disconnectAll(): void {
    this.childProcesses.forEach((child, serverId) => {
      if (!child.killed) {
        child.kill();
        AppLogger.info(LOG_TAGS.SYSTEM, `[MCP] 终止服务器: ${serverId}`);
      }
    });
    this.childProcesses.clear();
    this.connectedServers.clear();
  }

  // — JSON-RPC 消息构造（V2.0 用于与远程 MCP 服务器通信）—

  /** 构造 JSON-RPC 请求 — V1.2 骨架定义，V2.0 在 connectServer 握手中使用 */
  private buildRequest(method: string, params?: Record<string, any>): JSONRPCRequest {
    return {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params,
    };
  }

  // =========================================================================
  // 🏗️ 生命周期
  // =========================================================================

  constructor() {
    super();
    // V1.2 骨架: 预验证 JSON-RPC 消息构造器可用
    void this.buildRequest('ping');
  }

  /** 获取当前连接状态 */
  getStatus(): Record<string, MCPConnectionState> {
    return Object.fromEntries(this.connectedServers);
  }

  /** 关闭 MCP 客户端 — 终止所有子进程，清理注册表 */
  shutdown(): void {
    this.disconnectAll();
    this.tools.clear();
    this.resources.clear();
    AppLogger.info(LOG_TAGS.SYSTEM, '[MCP] 客户端已关闭');
  }
}
