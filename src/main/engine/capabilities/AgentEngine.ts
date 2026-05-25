import { WebContents } from 'electron'
import { ProviderManager } from '../config/ProviderManager'
import { PromptBuilder } from '../prompts/PromptBuilder'
import { LLMFactory } from '../adapters/LLMFactory'
import { ChatHistoryRepository } from '../../database/repositories/ChatHistoryRepository'
import { MediaRepository } from '../../database/repositories/MediaRepository'
import { AppLogger } from '../../core/AppLogger'
import { LOG_TAGS } from '../../../shared/utils/LogConstants'
import { IPC_CHANNELS } from '../../../shared/utils/IpcConstants'

export class AgentEngine {
  private chatRepo = new ChatHistoryRepository()
  private mediaRepo = new MediaRepository()

  /**
   * Agent 流式对话 — 从 AIEngine.agentStreamChat 拆出独立能力
   * 内置 5 个 Tool：修改台词/删除镜头/搜索素材/人声提取/视频抽帧
   */
  async streamChat(
    webContents: WebContents,
    projectId: string,
    prompt: string,
    context: Record<string, unknown>,
    history: any[] = [],
    provider?: string
  ): Promise<void> {
    try {
      webContents.send(IPC_CHANNELS.AGENT_STREAM_START)

      try {
        this.chatRepo.saveMessage(projectId, 'user', prompt)
      } catch (e: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `写入用户对话历史失败: ${e.message}`)
      }

      const config = ProviderManager.getLLMConfig('helper', provider)
      const agentData = this.mediaRepo.getAgentContextData(projectId)
      const systemPrompt = PromptBuilder.buildAgentPrompt(context, agentData)
      const adapter = LLMFactory.createFromConfig(config)

      const tools = this.buildTools()
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt }
      ]

      const result = await adapter.streamChatToBrowser(
        webContents,
        messages,
        config.model,
        0.5,
        IPC_CHANNELS.AGENT_STREAM_CHUNK,
        tools
      )

      if (result.toolCall) {
        webContents.send(IPC_CHANNELS.AGENT_TOOL_CALL, result.toolCall)
      }

      try {
        this.chatRepo.saveMessage(projectId, 'assistant', result.text || '')
      } catch (e: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `写入助手回复历史失败: ${e.message}`)
      }

      webContents.send(IPC_CHANNELS.AGENT_STREAM_DONE)
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.AI_ENGINE, `Agent 对话异常`, err)
      webContents.send(IPC_CHANNELS.AGENT_STREAM_DONE, { error: err.message })
    }
  }

  /** 工具集定义 */
  private buildTools(): any[] {
    return [
      {
        type: 'function',
        function: {
          name: 'update_shot_text',
          description: '修改台词',
          parameters: {
            type: 'object',
            properties: { shotId: { type: 'string' }, newText: { type: 'string' } },
            required: ['shotId', 'newText']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'delete_shot',
          description: '删除镜头',
          parameters: {
            type: 'object',
            properties: { shotId: { type: 'string' } },
            required: ['shotId']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_broll',
          description: '搜索素材库',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'isolate_vocals',
          description: '人声提取',
          parameters: {
            type: 'object',
            properties: { shotId: { type: 'string' } },
            required: ['shotId']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'extract_video_frames',
          description: '视频抽帧工具。调用时须向用户解释三种策略区别，提醒可在界面修改策略。',
          parameters: {
            type: 'object',
            properties: {
              mediaId: { type: 'string' },
              strategy: { type: 'string', enum: ['keyframe', 'fps', 'uniform'] },
              fps: { type: 'number', description: '仅 strategy=fps 时生效，默认 1' }
            },
            required: ['mediaId', 'strategy']
          }
        }
      }
    ]
  }
}
