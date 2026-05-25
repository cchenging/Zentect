import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RuntimeVersionGuard } from '../RuntimeVersionGuard'

const { mockFsExistsSync, mockFsReadFileSync } = vi.hoisted(() => ({
  mockFsExistsSync: vi.fn(),
  mockFsReadFileSync: vi.fn(),
}))

vi.mock('fs', () => ({
  default: {
    existsSync: mockFsExistsSync,
    readFileSync: mockFsReadFileSync,
    statSync: vi.fn(() => ({ size: 1024 })),
  },
}))

vi.mock('os', () => ({
  default: {
    cpus: vi.fn(() => [{ times: { user: 1, nice: 0, sys: 0, idle: 9, irq: 0 } }]),
    totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024),
    freemem: vi.fn(() => 8 * 1024 * 1024 * 1024),
    loadavg: vi.fn(() => [1.5, 1.2, 0.9]),
    platform: vi.fn(() => 'win32'),
  },
}))

vi.mock('../../shared/utils/LogConstants', () => ({
  LOG_TAGS: {
    SYSTEM: 'SYSTEM',
    AI_DAEMON: 'AI_DAEMON',
    AI_ENGINE: 'AI_ENGINE',
    ENGINE: 'ENGINE',
    PIPELINE: 'PIPELINE',
    DATABASE: 'DATABASE',
    MEDIA_ENGINE: 'MEDIA_ENGINE',
  },
}))

vi.mock('../../utils/pathManager', () => ({
  PathManager: {
    getResourcesPath: vi.fn(() => '/fake/resources'),
    getModelsPath: vi.fn(() => '/fake/resources/models'),
  },
}))

describe('RuntimeVersionGuard — Artifact Integrity', () => {
  let guard: RuntimeVersionGuard

  beforeEach(() => {
    guard = RuntimeVersionGuard.getInstance()
    vi.clearAllMocks()
    mockFsExistsSync.mockReturnValue(false)
    mockFsReadFileSync.mockReturnValue('{}')
  })

  describe('checkArtifactIntegrity', () => {
    it('build-manifest.json 不存在时应返回 valid: true (降级跳过)', () => {
      mockFsExistsSync.mockImplementation((_p: string) => false)

      const result = guard.checkArtifactIntegrity()

      expect(result.valid).toBe(true)
      expect(result.error).toContain('未找到 build-manifest.json')
    })

    it('缺少 SHA256 信息时应降级跳过', () => {
      mockFsExistsSync.mockImplementation((p: string) => {
        if (p.includes('build-manifest.json')) return true
        return false
      })
      mockFsReadFileSync.mockReturnValue(JSON.stringify({
        artifacts: { ai_daemon: { path: '/some/path', sha256: '', size_bytes: 0 } }
      }))

      const result = guard.checkArtifactIntegrity()

      expect(result.valid).toBe(true)
    })

    it('产物文件不存在时应返回失败', () => {
      mockFsExistsSync.mockImplementation((p: string) => {
        if (p.includes('build-manifest.json')) return true
        return false
      })
      mockFsReadFileSync.mockReturnValue(JSON.stringify({
        artifacts: { ai_daemon: { path: '/nonexistent/exe', sha256: 'abc123', size_bytes: 100 } }
      }))

      const result = guard.checkArtifactIntegrity()

      expect(result.valid).toBe(false)
      expect(result.error).toContain('产物文件不存在')
    })

    it('SHA256 匹配时应返回 valid: true', () => {
      const testContent = Buffer.from('hello world')
      const crypto = require('crypto')
      const expectedHash = crypto.createHash('sha256').update(testContent).digest('hex')

      mockFsExistsSync.mockImplementation((p: string) => {
        if (p.includes('build-manifest.json')) return true
        if (p === '/some/exe/path') return true
        return false
      })
      mockFsReadFileSync.mockImplementation((p: string) => {
        if (p.includes('build-manifest.json')) {
          return JSON.stringify({
            artifacts: { ai_daemon: { path: '/some/exe/path', sha256: expectedHash, size_bytes: 100 } }
          })
        }
        if (p === '/some/exe/path') return testContent
        return '{}'
      })

      const result = guard.checkArtifactIntegrity()

      expect(result.valid).toBe(true)
      expect(result.expectedSha256).toBe(expectedHash)
      expect(result.actualSha256).toBe(expectedHash)
    })

    it('SHA256 不匹配时应返回 valid: false', () => {
      mockFsExistsSync.mockImplementation((p: string) => {
        if (p.includes('build-manifest.json')) return true
        if (p === '/some/exe/path') return true
        return false
      })
      mockFsReadFileSync.mockImplementation((p: string) => {
        if (p.includes('build-manifest.json')) {
          return JSON.stringify({
            artifacts: { ai_daemon: { path: '/some/exe/path', sha256: 'wrong_hash_here', size_bytes: 100 } }
          })
        }
        if (p === '/some/exe/path') return Buffer.from('tampered content')
        return '{}'
      })

      const result = guard.checkArtifactIntegrity()

      expect(result.valid).toBe(false)
      expect(result.error).toContain('SHA256 不匹配')
    })
  })

  describe('checkRuntimeCompatibility', () => {
    it('缺少 runtime_version.json 时返回不兼容', () => {
      mockFsExistsSync.mockReturnValue(false)

      const result = guard.checkRuntimeCompatibility()

      expect(result.compatible).toBe(false)
      expect(result.issues.length).toBeGreaterThan(0)
    })

    it('存在有效 version 和 buildHash 时返回兼容', () => {
      mockFsExistsSync.mockImplementation((p: string) => {
        if (p.includes('runtime_version.json')) return true
        return false
      })
      mockFsReadFileSync.mockReturnValue(JSON.stringify({
        version: '3.10.11',
        buildHash: 'abc123def456',
        minClientVersion: '0.0.0',
        modelCompatVersion: '1.0'
      }))

      const result = guard.checkRuntimeCompatibility()

      expect(result.compatible).toBe(true)
      expect(result.runtimeVersion).toBe('3.10.11')
    })

    it('客户端版本低于 minClientVersion 时返回不兼容', () => {
      mockFsExistsSync.mockImplementation((p: string) => {
        if (p.includes('runtime_version.json')) return true
        return false
      })
      mockFsReadFileSync.mockReturnValue(JSON.stringify({
        version: '3.10.11',
        buildHash: 'abc123',
        minClientVersion: '99.0.0',
        modelCompatVersion: '1.0'
      }))

      const result = guard.checkRuntimeCompatibility()

      expect(result.compatible).toBe(false)
      expect(result.issues.some(i => i.includes('客户端版本'))).toBe(true)
    })
  })
})
