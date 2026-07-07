# 📁 scripts/dev.ps1 — Zentect dev 启动脚本（Windows PowerShell 5 UTF-8 适配）
#
# 根因说明：
#   · PowerShell 5 默认 [Console]::OutputEncoding = GB2312 (简体中文)
#   · 即便 Node 的 console.* 内部以 UTF-8 写出，PowerShell 接收端仍按 GB2312 解码
#     → 出现 "鏍稿績寮曟搸" 这种典型的 "UTF-8 字节被当成 GB2312 解释" 的乱码
#   · 仅在 cmd.exe 子进程里执行 `chcp 65001`（旧的 package.json 写法）无法修复，
#     因为它只改变那个瞬时 cmd 的 CP，不影响 PowerShell 宿主的 OutputEncoding。
#
# 修复步骤（按依赖顺序）：
#   1) 修改 PowerShell 宿主自身的 OutputEncoding / InputEncoding 为 UTF-8
#   2) 设置 $OutputEncoding（PowerShell 向外部程序发送数据时使用的编码）
#   3) 设置 NODE_FORCE_UTF8_STDOUT=1，让 libuv 在 Windows 上直接以 UTF-8 写 stdout
#   4) 再在 UTF-8 CP 下启动 electron-vite dev
#
# 注意：本脚本在 Win10+ / PS5.1 下工作；在 Win11 终端 / Windows Terminal 默认已是 UTF-8，
#       本脚本不会产生副作用，仍可安全使用。
# ============================================================

$ErrorActionPreference = 'Continue'

# --- 1) PowerShell 宿主 & 管道编码 ---
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false)
    $script:OutputEncoding    = [System.Text.UTF8Encoding]::new($false)
} catch {
    # 非交互式环境可能无法设置 Console 编码，忽略
}

# --- 2) 让 Node / Electron / Python 子进程以 UTF-8 输出 ---
$env:NODE_FORCE_UTF8_STDOUT = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:ELECTRON_ENABLE_LOGGING = '1'
$env:LANG  = 'zh_CN.UTF-8'
$env:LC_ALL= 'zh_CN.UTF-8'

# --- 3) 在 UTF-8 代码页下启动 electron-vite dev ---
#    通过 cmd /c 保证 chcp 65001 对同一命令链上的 electron-vite 生效
$cmdLine = 'chcp 65001 > nul & node "./node_modules/electron-vite/bin/electron-vite.js" dev'
Push-Location $PSScriptRoot/..
try {
    & cmd /c $cmdLine
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
