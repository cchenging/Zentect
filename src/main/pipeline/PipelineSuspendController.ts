import { TaskEventBus } from '../engine/TaskEventBus'
import { AppLogger } from '../core/AppLogger'
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants'

interface SuspendContext {
  projectId: string
  mediaId: string
  stepId: string
  actionType: string
  context: Record<string, unknown>
  suspendedAt: number
}

interface ResumeInput {
  projectId: string
  mediaId: string
  userInput: Record<string, unknown>
}

export class PipelineSuspendController {
  private suspensions = new Map<string, SuspendContext>()
  private resumeResolvers = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()
  private eventBus = TaskEventBus.getInstance()

  suspend(
    projectId: string,
    mediaId: string,
    stepId: string,
    actionType: string,
    context: Record<string, unknown> = {}
  ): Promise<void> {
    const key = `${projectId}_${mediaId}`

    return new Promise<void>((resolve, reject) => {
      const suspendCtx: SuspendContext = {
        projectId,
        mediaId,
        stepId,
        actionType,
        context,
        suspendedAt: Date.now()
      }

      this.suspensions.set(key, suspendCtx)
      this.resumeResolvers.set(key, { resolve, reject })

      this.eventBus.emitPipelineSuspended({ projectId, mediaId, stepId })
      this.eventBus.emitUserActionRequired({
        projectId,
        mediaId,
        stepId,
        actionType,
        context
      })

      AppLogger.info(
        LOG_TAGS.ENGINE,
        `Pipeline 挂起等待用户操作: project=${projectId}, step=${stepId}, action=${actionType}`
      )
    })
  }

  /** 恢复挂起的 Pipeline，调用 resolve 让 Promise 继续执行 */
  resume(input: ResumeInput): { success: boolean; message: string } {
    const key = `${input.projectId}_${input.mediaId}`

    const suspendCtx = this.suspensions.get(key)
    if (!suspendCtx) {
      return { success: false, message: `未找到 project=${input.projectId} 的挂起记录` }
    }

    const resolver = this.resumeResolvers.get(key)
    if (!resolver) {
      return { success: false, message: `挂起记录存在但恢复器丢失 (project=${input.projectId})` }
    }

    const durationMs = Date.now() - suspendCtx.suspendedAt
    AppLogger.info(
      LOG_TAGS.ENGINE,
      `Pipeline 恢复执行: project=${input.projectId}, step=${suspendCtx.stepId}, 挂起时长=${(durationMs / 1000).toFixed(1)}s`
    )

    this.eventBus.emitPipelineResumed({ projectId: input.projectId, mediaId: input.mediaId })

    resolver.resolve()

    this.suspensions.delete(key)
    this.resumeResolvers.delete(key)

    return { success: true, message: 'Pipeline 已恢复执行' }
  }

  /** 放弃挂起的 Pipeline，必须 reject 挂起 Promise 防止死锁 */
  abandon(projectId: string, mediaId: string): void {
    const key = `${projectId}_${mediaId}`
    const resolver = this.resumeResolvers.get(key)
    if (resolver) {
      // 必须 reject，否则 Promise 永远挂起导致 Pipeline 死锁
      resolver.reject(new Error(`Pipeline 挂起已被放弃: project=${projectId}`))
    }
    this.suspensions.delete(key)
    this.resumeResolvers.delete(key)
    AppLogger.warn(LOG_TAGS.ENGINE, `Pipeline 挂起已放弃: project=${projectId}`)
  }

  getSuspension(projectId: string, mediaId: string): SuspendContext | undefined {
    const key = `${projectId}_${mediaId}`
    return this.suspensions.get(key)
  }

  isSuspended(projectId: string, mediaId: string): boolean {
    const key = `${projectId}_${mediaId}`
    return this.suspensions.has(key)
  }

  getActiveSuspensions(): SuspendContext[] {
    return Array.from(this.suspensions.values())
  }

  destroy(): void {
    this.suspensions.clear()
    this.resumeResolvers.clear()
  }
}
