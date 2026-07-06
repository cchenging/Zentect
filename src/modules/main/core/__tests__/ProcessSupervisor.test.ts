import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProcessSupervisor, RestartCallback } from '../ProcessSupervisor'
import { EventEmitter } from 'events'

vi.mock('electron', () => ({
  app: { on: vi.fn() },
}))

vi.mock('../../utils/processManager', () => ({
  ProcessManager: {
    register: vi.fn(),
    killTree: vi.fn(),
    killAll: vi.fn(),
  },
}))

vi.mock('../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../infra/logger/LogConstants', () => ({
  LOG_TAGS: { SYSTEM: 'SYSTEM' },
}))

/** 创建一个模拟的 ChildProcess（基于 EventEmitter） */
function createMockProcess(pid: number): any {
  const proc = new EventEmitter() as any
  proc.pid = pid
  proc.kill = vi.fn()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  return proc
}

describe('ProcessSupervisor — Auto Restart Integration', () => {
  let supervisor: ProcessSupervisor

  beforeEach(() => {
    (ProcessSupervisor as any).instance = undefined
    supervisor = ProcessSupervisor.getInstance()
    vi.useFakeTimers()
  })

  afterEach(() => {
    supervisor.shutdown()
    vi.useRealTimers()
  })

  describe('process lifecycle tracking', () => {
    it('注册进程后 count 和 labels 应正确', () => {
      const proc = createMockProcess(1001)
      supervisor.supervise(proc, 'test-service', 3)
      expect(supervisor.count).toBe(1)
      expect(supervisor.labels).toContain('test-service')
    })

    it('无 PID 进程不应注册', () => {
      const proc = createMockProcess(0)
      proc.pid = undefined
      supervisor.supervise(proc, 'no-pid', 3)
      expect(supervisor.count).toBe(0)
    })

    it('uptime 应返回非零值', () => {
      const proc = createMockProcess(1002)
      supervisor.supervise(proc, 'timed-service', 3)
      const uptime = supervisor.getUptime('timed-service')
      expect(uptime).toBeGreaterThanOrEqual(0)
    })

    it('restartCount 初始为 0', () => {
      const proc = createMockProcess(1003)
      supervisor.supervise(proc, 'fresh-service', 3)
      expect(supervisor.getRestartCount('fresh-service')).toBe(0)
    })
  })

  describe('auto-restart on process exit', () => {
    it('进程退出时触发 onRestart 回调（带正确参数）', async () => {
      const proc = createMockProcess(2001)
      const onRestart: RestartCallback = vi.fn().mockResolvedValue(null)

      supervisor.supervise(proc, 'auto-restart-svc', 3, onRestart)

      proc.emit('exit', 1, 'SIGTERM')

      // 2000ms restart delay
      await vi.advanceTimersByTimeAsync(2000)

      expect(onRestart).toHaveBeenCalledTimes(1)
      expect(onRestart).toHaveBeenCalledWith('auto-restart-svc', 1)
    })

    it('restart 成功后新进程被重新注册', async () => {
      const oldProc = createMockProcess(3001)
      const newProc = createMockProcess(3002)

      const onRestart: RestartCallback = vi.fn().mockResolvedValue(newProc)

      supervisor.supervise(oldProc, 'reboot-svc', 3, onRestart)

      oldProc.emit('exit', 1, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)

      expect(onRestart).toHaveBeenCalledTimes(1)
      expect(supervisor.labels).toContain('reboot-svc')
      expect(supervisor.count).toBe(1)
    })

    it('restart 回调返回 null 时放弃重启', async () => {
      const proc = createMockProcess(4001)
      const onRestart: RestartCallback = vi.fn().mockResolvedValue(null)

      supervisor.supervise(proc, 'fail-restart', 3, onRestart)

      proc.emit('exit', 1, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)

      expect(onRestart).toHaveBeenCalledTimes(1)
      // 进程已移除
      expect(supervisor.labels).not.toContain('fail-restart')
    })

    it('重启回调异常时不崩溃', async () => {
      const proc = createMockProcess(5001)
      const onRestart: RestartCallback = vi.fn().mockRejectedValue(new Error('BOOM'))

      supervisor.supervise(proc, 'crash-restart', 3, onRestart)

      proc.emit('exit', 1, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(2000)

      expect(onRestart).toHaveBeenCalledTimes(1)
      // 不应抛出异常导致测试失败
    })

    it('达到 maxRestarts 时放弃自动恢复', async () => {
      const oldProc = createMockProcess(6001)
      const newProc = createMockProcess(6002)
      const anotherProc = createMockProcess(6003)
      let spawnCount = 0
      const onRestart: RestartCallback = vi.fn().mockImplementation(async () => {
        spawnCount++
        if (spawnCount === 1) return newProc
        if (spawnCount === 2) return anotherProc
        return null
      })

      supervisor.supervise(oldProc, 'maxed-out', 2, onRestart)

      // 第 1 次退出 → restartCount=0, 小于 maxRestarts=2 → 触发重启
      oldProc.emit('exit', 1, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)
      expect(onRestart).toHaveBeenCalledTimes(1)
      expect(onRestart).toHaveBeenCalledWith('maxed-out', 1)

      // 第 2 次退出 → restartCount=1, 小于 maxRestarts=2 → 仍可重启
      newProc.emit('exit', 1, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)
      expect(onRestart).toHaveBeenCalledTimes(2)
      expect(onRestart).toHaveBeenCalledWith('maxed-out', 2)

      // 第 3 次退出 → restartCount=2, 等于 maxRestarts=2 → 放弃，回调不再调用
      anotherProc.emit('exit', 1, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)
      expect(onRestart).toHaveBeenCalledTimes(2)
    })

    it('多次退出触发多次 restart 回调（递增 restartCount）', async () => {
      const p1 = createMockProcess(7001)
      const p2 = createMockProcess(7002)
      const p3 = createMockProcess(7003)

      let callCount = 0
      const onRestart: RestartCallback = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) return p2
        if (callCount === 2) return p3
        return null
      })

      supervisor.supervise(p1, 'multi-restart', 5, onRestart)

      // 第 1 次退出
      p1.emit('exit', 1, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)
      expect(onRestart).toHaveBeenCalledTimes(1)
      expect(onRestart).toHaveBeenCalledWith('multi-restart', 1)

      // 第 2 次退出（新进程 p2）
      p2.emit('exit', 1, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)
      expect(onRestart).toHaveBeenCalledTimes(2)
      expect(onRestart).toHaveBeenCalledWith('multi-restart', 2)
    })
  })

  describe('shutdown / stop behavior', () => {
    it('shutdown 时不应触发 restart', async () => {
      const proc = createMockProcess(8001)
      const onRestart: RestartCallback = vi.fn().mockResolvedValue(null)

      supervisor.supervise(proc, 'shutdown-svc', 3, onRestart)
      supervisor.shutdown()

      proc.emit('exit', 1, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)

      expect(onRestart).not.toHaveBeenCalled()
    })

    it('stopProcess 后退出不触发 restart', async () => {
      const proc = createMockProcess(9001)
      const onRestart: RestartCallback = vi.fn().mockResolvedValue(null)

      supervisor.supervise(proc, 'stopped-svc', 3, onRestart)
      supervisor.stopProcess('stopped-svc')

      proc.emit('exit', 1, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)

      expect(onRestart).not.toHaveBeenCalled()
      expect(supervisor.labels).not.toContain('stopped-svc')
    })

    it('shutdown 清理所有 restartCallbacks', () => {
      const proc = createMockProcess(10001)
      const onRestart: RestartCallback = vi.fn().mockResolvedValue(null)

      supervisor.supervise(proc, 'cleanup-svc', 3, onRestart)
      expect(supervisor.count).toBe(1)

      supervisor.shutdown()
      expect(supervisor.count).toBe(0)
      expect(supervisor.labels).toHaveLength(0)
    })
  })

  describe('no callback — no restart', () => {
    it('未传入 onRestart 时退出不执行重启', async () => {
      const proc = createMockProcess(11001)
      supervisor.supervise(proc, 'no-cb-svc', 3)

      proc.emit('exit', 1, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)

      expect(supervisor.labels).not.toContain('no-cb-svc')
    })
  })
})
