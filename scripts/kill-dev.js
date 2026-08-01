/**
 * 精准清理 Zentect 开发环境残留进程
 * 按项目根目录绝对路径匹配，不会误杀其他项目的 electron/node/python 进程
 * 用法：pnpm run kill  或  node scripts/kill-dev.js
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// 项目根目录绝对路径（小写化用于命令行匹配，Windows 路径不区分大小写）
const PROJECT_ROOT = path.resolve(__dirname, '..').toLowerCase();
const PROJECT_ROOT_WIN = PROJECT_ROOT.replace(/\//g, '\\');

let killed = 0;

/**
 * 定位 PowerShell 可执行文件绝对路径
 * npm/pnpm 环境下 PATH 可能不含 System32，需主动拼接
 */
function findPowerShell() {
  const windir = process.env.windir || process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(windir, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

/**
 * 通过 PowerShell Get-CimInstance 获取所有进程及其命令行
 * 精准匹配需要命令行参数，tasklist 不提供此信息
 */
function getProcesses() {
  const psExe = findPowerShell();
  if (!psExe) {
    console.log('[kill-dev] 警告：未找到 PowerShell，跳过精准清理');
    return [];
  }
  try {
    // 用 -EncodedCommand 避免引号转义问题
    // $ProgressPreference='SilentlyContinue' 抑制 CLIXML 进度输出，避免污染 JSON
    const script = `$ProgressPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='node.exe' OR Name='python.exe'" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const raw = execSync(`"${psExe}" -NoProfile -EncodedCommand ${encoded}`, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    // 过滤 CLIXML 残留（#< CLIXML 开头的行）和首尾空白
    const output = raw.replace(/#<\s*CLIXML[\s\S]*?(?=\{|\[|$)/g, '').trim();
    if (!output) return [];
    let list;
    try {
      list = JSON.parse(output);
    } catch {
      list = [JSON.parse(output)];
    }
    return Array.isArray(list) ? list : [list];
  } catch (e) {
    console.log('[kill-dev] 警告：PowerShell 调用失败，跳过精准清理');
    return [];
  }
}

/** 判断进程是否属于本项目（按项目根目录绝对路径匹配） */
function isProjectProcess(p) {
  const cmd = (p.CommandLine || '').toLowerCase();
  const cmdWin = cmd.replace(/\//g, '\\');

  // 匹配项目根路径（如 f:\tools\zentect）
  // electron.exe：命令行包含项目路径（加载 main/index.js 时带项目路径）
  if (p.Name === 'electron.exe' && cmdWin.includes(PROJECT_ROOT_WIN)) {
    return true;
  }

  // node.exe：electron-vite dev 进程，命令行包含项目路径下的 electron-vite.js
  if (p.Name === 'node.exe') {
    // 匹配 electron-vite.js dev（命令行含项目路径）
    if (cmdWin.includes(PROJECT_ROOT_WIN) &&
        (cmdWin.includes('electron-vite') || cmdWin.includes('\\vite\\') && cmdWin.includes('zentect'))) {
      return true;
    }
  }

  // python.exe：ai_daemon.py / tts_worker.py，命令行包含项目 resources/scripts 路径
  if (p.Name === 'python.exe') {
    const scriptsPath = path.join(PROJECT_ROOT_WIN, 'resources', 'scripts').toLowerCase();
    if (cmdWin.includes(scriptsPath) &&
        (cmdWin.includes('ai_daemon.py') || cmdWin.includes('tts_worker.py'))) {
      return true;
    }
  }

  return false;
}

/** 杀指定 PID */
function killPid(pid) {
  try {
    process.kill(pid, 'SIGKILL');
    console.log(`  已杀 PID=${pid}`);
    killed++;
  } catch (e) {
    // 进程已退出或无权限，忽略
  }
}

/** 主清理逻辑 */
function main() {
  const procs = getProcesses();
  if (procs.length === 0) {
    console.log('[kill-dev] 未发现可疑进程或 PowerShell 不可用');
    return;
  }

  const targets = procs.filter(isProjectProcess);

  if (targets.length === 0) {
    console.log('[kill-dev] 未发现 Zentect 残留进程');
    return;
  }

  console.log(`[kill-dev] 发现 ${targets.length} 个本项目残留进程，开始精准清理...`);
  console.log(`[kill-dev] 项目根目录: ${PROJECT_ROOT_WIN}`);
  for (const t of targets) {
    const cmdPreview = (t.CommandLine || '').substring(0, 80);
    console.log(`  → ${t.Name} (PID=${t.ProcessId})  ${cmdPreview}`);
    killPid(parseInt(t.ProcessId, 10));
  }
  console.log(`[kill-dev] 共清理 ${killed} 个进程`);

  // 等待端口释放（同步 sleep 2 秒）
  const end = Date.now() + 2000;
  while (Date.now() < end) { /* busy wait */ }

  // 验证端口状态
  try {
    const netstat = execSync('netstat -ano', { encoding: 'utf8' });
    const ports = [8173, 34567, 9881];
    const stillUsed = ports.filter(port =>
      netstat.split('\n').some(line =>
        line.includes(`:${port}`) && line.includes('LISTENING')
      )
    );
    if (stillUsed.length > 0) {
      console.log(`[kill-dev] 警告：端口 ${stillUsed.join(', ')} 仍被占用（可能 TIME_WAIT，30-120s 自动释放）`);
    } else {
      console.log('[kill-dev] 端口 8173/34567/9881 均已释放');
    }
  } catch {}
}

main();
