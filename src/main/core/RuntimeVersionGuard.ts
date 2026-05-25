import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { PathManager } from '../utils/pathManager'
import { AppLogger } from './AppLogger'
import { LOG_TAGS } from '../../shared/utils/LogConstants'

interface VersionInfo {
  /** 语义化版本号，如 "1.2.0" */
  version: string
  /** 构建哈希 */
  buildHash: string
  /** 兼容的最低客户端版本 */
  minClientVersion: string
  /** 依赖的模型兼容版本范围 */
  modelCompatVersion: string
}

interface CompatibilityResult {
  compatible: boolean
  runtimeVersion: string
  clientVersion: string
  issues: string[]
}

interface ArtifactIntegrityResult {
  valid: boolean
  exePath: string | null
  expectedSha256: string
  actualSha256: string
  error: string | null
}

/**
 * 运行时版本守卫
 * 启动时校验 Python runtime 与当前客户端的版本兼容性，
 * 版本不匹配时给出明确错误提示；
 * 同时支持构建产物 (PyInstaller exe) SHA256 完整性校验
 */
export class RuntimeVersionGuard {
  private static instance: RuntimeVersionGuard

  private constructor() {
    // singleton
  }

  static getInstance(): RuntimeVersionGuard {
    if (!RuntimeVersionGuard.instance) {
      RuntimeVersionGuard.instance = new RuntimeVersionGuard()
    }
    return RuntimeVersionGuard.instance
  }

  /** 检查 Python runtime 版本是否兼容 */
  checkRuntimeCompatibility(): CompatibilityResult {
    const issues: string[] = []
    const clientVersion = this.getClientVersion()
    let runtimeVersion = 'unknown'

    try {
      const versionFile = path.join(
        PathManager.getResourcesPath(),
        'models',
        'runtime_version.json'
      )

      if (!fs.existsSync(versionFile)) {
        issues.push('未找到 runtime 版本清单 (runtime_version.json)，可能未正确构建')
        return {
          compatible: false,
          runtimeVersion,
          clientVersion,
          issues
        }
      }

      const raw = fs.readFileSync(versionFile, 'utf-8')
      const info: VersionInfo = JSON.parse(raw)
      runtimeVersion = info.version

      if (!info.version) {
        issues.push('runtime 版本清单缺少 version 字段')
      }

      if (!info.buildHash) {
        issues.push('runtime 版本清单缺少 buildHash，无法校验完整性')
      }

      if (info.minClientVersion && !this.compareVersions(clientVersion, info.minClientVersion)) {
        issues.push(
          `客户端版本 ${clientVersion} 低于 runtime 要求的最低版本 ${info.minClientVersion}`
        )
      }
    } catch (err: any) {
      issues.push(`解析 runtime 版本清单失败: ${err.message}`)
    }

    const compatible = issues.length === 0

    if (!compatible) {
      AppLogger.error(LOG_TAGS.SYSTEM, `[RuntimeVersionGuard] 版本不兼容: ${issues.join('; ')}`)
    }

    return { compatible, runtimeVersion, clientVersion, issues }
  }

  /** 检查模型清单完整性 */
  checkModelManifest(): { valid: boolean; missing: string[]; mismatched: string[] } {
    const missing: string[] = []
    const mismatched: string[] = []

    try {
      const manifestPath = path.join(PathManager.getResourcesPath(), 'models', 'manifest.json')

      if (!fs.existsSync(manifestPath)) {
        missing.push('models/manifest.json')
        return { valid: false, missing, mismatched }
      }

      const raw = fs.readFileSync(manifestPath, 'utf-8')
      const manifest = JSON.parse(raw)

      if (!manifest.models || !Array.isArray(manifest.models)) {
        missing.push('manifest.json 缺少 models 数组')
        return { valid: false, missing, mismatched }
      }

      for (const model of manifest.models) {
        const modelPath = path.join(PathManager.getModelsPath(), model.path || '')

        if (!fs.existsSync(modelPath)) {
          missing.push(model.path || model.name || 'unknown')
          continue
        }

        if (model.expectedSize) {
          const stat = fs.statSync(modelPath)
          if (stat.size !== model.expectedSize) {
            mismatched.push(
              `${model.name}: 期望 ${model.expectedSize} bytes, 实际 ${stat.size} bytes`
            )
          }
        }
      }

      const valid = missing.length === 0 && mismatched.length === 0

      if (!valid) {
        AppLogger.warn(
          LOG_TAGS.SYSTEM,
          `[RuntimeVersionGuard] 模型清单问题: 缺失 ${missing.length}, 不匹配 ${mismatched.length}`
        )
      }

      return { valid, missing, mismatched }
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.SYSTEM, `[RuntimeVersionGuard] 模型清单检查失败`, err)
      return { valid: false, missing: [err.message], mismatched: [] }
    }
  }

  /** 校验 PyInstaller 构建产物的 SHA256 完整性 */
  checkArtifactIntegrity(): ArtifactIntegrityResult {
    const defaultResult: ArtifactIntegrityResult = {
      valid: false,
      exePath: null,
      expectedSha256: '',
      actualSha256: '',
      error: null
    }

    try {
      const buildManifestPath = path.join(
        PathManager.getResourcesPath(),
        'dist', 'ai-runtime', 'build-manifest.json'
      )

      if (!fs.existsSync(buildManifestPath)) {
        defaultResult.error = '未找到 build-manifest.json，跳过产物完整性校验'
        defaultResult.valid = true
        return defaultResult
      }

      const raw = fs.readFileSync(buildManifestPath, 'utf-8')
      const manifest = JSON.parse(raw)
      const expectedSha256 = manifest?.artifacts?.ai_daemon?.sha256 || ''
      const exePath = manifest?.artifacts?.ai_daemon?.path || ''

      defaultResult.expectedSha256 = expectedSha256
      defaultResult.exePath = exePath

      if (!expectedSha256 || !exePath) {
        defaultResult.error = 'build-manifest.json 缺少 SHA256 或路径信息'
        defaultResult.valid = true
        return defaultResult
      }

      if (!fs.existsSync(exePath)) {
        defaultResult.error = `产物文件不存在: ${exePath}`
        return defaultResult
      }

      const fileData = fs.readFileSync(exePath)
      const actualHash = crypto.createHash('sha256').update(fileData).digest('hex')

      defaultResult.actualSha256 = actualHash
      defaultResult.valid = actualHash === expectedSha256

      if (!defaultResult.valid) {
        defaultResult.error = `SHA256 不匹配: 期望 ${expectedSha256}, 实际 ${actualHash}`
        AppLogger.error(LOG_TAGS.SYSTEM, `[RuntimeVersionGuard] ${defaultResult.error}`)
      } else {
        AppLogger.info(LOG_TAGS.SYSTEM, `[RuntimeVersionGuard] 产物完整性校验通过: ${exePath}`)
      }

      return defaultResult
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.SYSTEM, '[RuntimeVersionGuard] 产物完整性校验失败', err)
      return { ...defaultResult, valid: false, error: err.message }
    }
  }

  private getClientVersion(): string {
    try {
      const pkgPath = path.join(process.cwd(), 'package.json')
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        return pkg.version || '0.0.0'
      }
    } catch {
      // package.json may not exist or be malformed
    }
    return '0.0.0'
  }

  /** 简易语义化版本比对：a >= b 返回 true */
  private compareVersions(a: string, b: string): boolean {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)

    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const va = pa[i] || 0
      const vb = pb[i] || 0
      if (va > vb) return true
      if (va < vb) return false
    }
    return true
  }
}
