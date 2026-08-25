// scripts/clean-src-js.cjs
// 清理 src 下"与 .ts 同名的孤儿 .js 编译产物"（tsc 裸编译残留）。
//
// 背景：本项目 electron-vite 打包时若源码目录存在 .js/.ts 同名文件，
//       会优先加载 .js（Vite 默认扩展名 .js 排在 .ts 前面），导致 .ts 修改不生效。
//       历史上一批裸 `tsc` 把 416 个 .js 输出到 src 下，就踩过这个坑。
//
// 本脚本只删除"存在同名 .ts"的 .js（即 tsc 编译产物），
// 不会误删纯 JS 模块（无对应 .ts 的 .js 一律保留）。
// 在 dev.bat / dev.ps1 启动时自动调用，作为 tsconfig noEmit 之外的兜底。

const fs = require('fs')
const path = require('path')

/** 项目根目录（基于本脚本位置解析，避免依赖调用方 cwd） */
const PROJECT_ROOT = path.resolve(__dirname, '..')
/** 需要扫描的源码根目录（与 .ts/.tsx 源码所在范围一致，含 renderer） */
const ROOTS = ['src/main', 'src/modules', 'src/preload', 'src/shared', 'src/renderer']
/** 跳过的目录名（不递归） */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'dist', 'out'])

/**
 * 判断某文件是否为"孤儿编译产物"：
 *  - 文件名以 .js 结尾 → 若存在同名 .ts，则是 tsc 编译产物（删除）
 *  - 文件名以 .jsx 结尾 → 若存在同名 .tsx，则是旧 JSX 残留（删除）
 * @param {string} filePath 文件绝对路径
 * @returns {boolean} 是否应删除
 */
function isOrphanArtifact(filePath) {
  if (filePath.endsWith('.js')) {
    return fs.existsSync(filePath.slice(0, -3) + '.ts')
  }
  if (filePath.endsWith('.jsx')) {
    return fs.existsSync(filePath.slice(0, -4) + '.tsx')
  }
  return false
}

let removed = 0

/**
 * 递归扫描目录，删除存在同名 .ts 的 .js 文件
 * @param {string} dir 当前目录绝对路径
 */
function walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
      } else if (isOrphanArtifact(full)) {
        // 存在同名 .ts/.tsx 的 .js/.jsx → 判定为旧编译产物，删除
        try {
          fs.unlinkSync(full)
          removed++
          console.log(`[clean-src-js] 删除孤儿编译产物: ${path.relative(PROJECT_ROOT, full)}`)
        } catch {
          // 文件可能被占用，忽略
        }
      }
    }
}

for (const root of ROOTS) {
  const abs = path.join(PROJECT_ROOT, root)
  if (fs.existsSync(abs)) walk(abs)
}

if (removed > 0) {
  console.log(`[clean-src-js] 已清理 ${removed} 个孤儿 .js 编译产物（确保 .ts 源码生效）`)
} else {
  console.log('[clean-src-js] 无需清理（源码目录干净）')
}
