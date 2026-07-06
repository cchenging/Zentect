import { MainNotifier } from '../core/MainNotifier'
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants'

type EventHandler = (...args: any[]) => void

interface PipelineProgressEvent {
  projectId: string
  stepId: string
  stepName: string
  stepProgress: number
  overallProgress: number
  status: 'running' | 'completed' | 'failed' | 'degraded' | 'suspended'
  message?: string
}

interface PipelineLifecycleEvent {
  projectId: string
  mediaId: string
  success: boolean
  error?: string
}

interface UserActionRequiredEvent {
  projectId: string
  mediaId: string
  stepId: string
  actionType: string
  context: Record<string, unknown>
}

class EventEmitter {
  private listeners = new Map<string, Set<EventHandler>>()

  on(event: string, handler: EventHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler)
  }

  off(event: string, handler: EventHandler): void {
    this.listeners.get(event)?.delete(handler)
  }

  protected emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach((h) => {
      try {
        h(...args)
      } catch {
        /* 吞掉订阅者异常，防止拖垮 Pipeline */
      }
    })
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event)
    } else {
      this.listeners.clear()
    }
  }
}

export class TaskEventBus extends EventEmitter {
  private static instance: TaskEventBus
  private mainNotifierEnabled = true

  private constructor() {
    super()
  }

  static getInstance(): TaskEventBus {
    if (!TaskEventBus.instance) {
      TaskEventBus.instance = new TaskEventBus()
    }
    return TaskEventBus.instance
  }

  setMainNotifierEnabled(enabled: boolean): void {
    this.mainNotifierEnabled = enabled
  }

  emitPipelineProgress(event: PipelineProgressEvent): void {
    this.emit('pipeline:progress', event)
    if (this.mainNotifierEnabled) {
      MainNotifier.notify(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS, event)
    }
  }

  emitPipelineCompleted(event: PipelineLifecycleEvent): void {
    this.emit('pipeline:completed', event)
    if (this.mainNotifierEnabled) {
      MainNotifier.notify(IPC_CHANNELS.EVENT_TASK_COMPLETED, {
        mediaId: event.mediaId,
        projectId: event.projectId,
        result: event
      })
    }
  }

  emitPipelineFailed(event: PipelineLifecycleEvent): void {
    this.emit('pipeline:failed', event)
    if (this.mainNotifierEnabled) {
      MainNotifier.notify(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS, {
        projectId: event.projectId,
        status: 'failed',
        error: event.error
      })
    }
  }

  emitPipelineSuspended(event: { projectId: string; mediaId: string; stepId: string }): void {
    this.emit('pipeline:suspended', event)
    if (this.mainNotifierEnabled) {
      MainNotifier.notify(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS, {
        projectId: event.projectId,
        stepId: event.stepId,
        status: 'suspended'
      })
    }
  }

  emitPipelineResumed(event: { projectId: string; mediaId: string }): void {
    this.emit('pipeline:resumed', event)
  }

  emitUserActionRequired(event: UserActionRequiredEvent): void {
    this.emit('pipeline:require-user-action', event)
    if (this.mainNotifierEnabled) {
      MainNotifier.notify(IPC_CHANNELS.ENGINE_REQUIRE_USER_ACTION, event)
    }
  }

  destroy(): void {
    this.removeAllListeners()
    this.mainNotifierEnabled = false
  }
}
