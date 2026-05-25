// 📁 路径：src/main/utils/processManager.ts
import { spawn, ChildProcess } from 'child_process';
import { app } from 'electron';
import os from 'os';
import { exec } from 'child_process';
import { AppLogger } from '../core/AppLogger';

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  onProgress?: (progress: number, rawMessage: string) => void;
  // 用于解析进度的正则提取器 (比如 FFmpeg 的 time=xx:xx:xx)
  progressRegex?: RegExp;
  totalDurationRegex?: RegExp; 
}

export class ProcessManager {
  private static activeProcesses = new Map<number, ChildProcess>();

  /**
   * 注册子进程：必须在 spawn 之后立刻调用
   */
  static register(cp: ChildProcess, _label?: string) {
    if (cp.pid) {
      this.activeProcesses.set(cp.pid, cp);
      cp.on('exit', () => {
        if (cp.pid) this.activeProcesses.delete(cp.pid);
      });
    }
  }

  /**
   * 工业级物理强杀：连同它的所有子进程（进程树）一起超度
   */
  static killTree(pid: number) {
    if (!this.activeProcesses.has(pid)) return;
    
    try {
      if (os.platform() === 'win32') {
        exec(`taskkill /pid ${pid} /T /F`, () => {});
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch (e) {
      AppLogger.error('ProcessManager', `强杀 PID ${pid} 失败`, e);
    } finally {
      this.activeProcesses.delete(pid);
    }
  }

  /**
   * 软件退出前的终极清洗
   */
  static killAll() {
    AppLogger.info('ProcessManager', `清理 ${this.activeProcesses.size} 个残留子进程`);
    for (const pid of this.activeProcesses.keys()) {
      this.killTree(pid);
    }
  }

  /**
   * 💥 核心：安全执行原生二进制应用，并实时萃取进度
   */
  public static async spawnSafe(options: ProcessOptions): Promise<string> {
    const { command, args, cwd, onProgress, progressRegex, totalDurationRegex } = options;
    
    return new Promise((resolve, reject) => {
      AppLogger.info('ProcessManager', `[ProcessManager] Spawning: ${command} ${args.join(' ')}`);
      
      const child: ChildProcess = spawn(command, args, { cwd, shell: process.platform === 'win32' });
      
      // 自动注册到进程管理器，确保异常退出时能被清理
      ProcessManager.register(child, command);
      
      let outputLog = '';
      let errorLog = '';
      let totalDurationSec = 0.01; // 防止除0异常

      // 将 HH:MM:SS.ms 转化为秒
      const timeToSeconds = (timeStr: string) => {
        const parts = timeStr.split(':');
        if (parts.length !== 3) return 0;
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
      };

      // 💥 实时流式解析 stdout/stderr
      const handleStream = (data: Buffer) => {
        const chunk = data.toString();
        outputLog += chunk;

        if (onProgress) {
          // 1. 尝试捕获总时长 (例如 FFmpeg 的 Duration: 00:01:23.45)
          if (totalDurationRegex && totalDurationSec === 0.01) {
            const durationMatch = chunk.match(totalDurationRegex);
            if (durationMatch && durationMatch[1]) {
              totalDurationSec = timeToSeconds(durationMatch[1]);
            }
          }

          // 2. 尝试捕获当前进度 (例如 FFmpeg 的 time=00:00:15.23)
          if (progressRegex) {
            const progressMatch = chunk.match(progressRegex);
            if (progressMatch && progressMatch[1]) {
              const currentSec = timeToSeconds(progressMatch[1]);
              let percent = Math.min(99, Math.round((currentSec / totalDurationSec) * 100));
              if (isNaN(percent)) percent = 0;
              onProgress(percent, `Processing: ${progressMatch[1]}`);
            }
          } else {
             // 如果没有正则，就把原始日志截断传出去
             onProgress(-1, chunk.substring(0, 50).trim());
          }
        }
      };

      child.stdout?.on('data', handleStream);
      // FFmpeg 通常把日志写在 stderr
      child.stderr?.on('data', (data) => {
        handleStream(data);
        errorLog += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          AppLogger.info('ProcessManager', `[ProcessManager] Process completed successfully: ${command}`);
          resolve(outputLog);
        } else {
          AppLogger.error('ProcessManager', `[ProcessManager] Process crashed with code ${code}`, { errorLog });
          reject(new Error(`原生进程执行失败 (Code: ${code}): ${errorLog.split('\n').slice(-5).join(' | ')}`));
        }
      });

      child.on('error', (err) => {
        AppLogger.error('ProcessManager', `[ProcessManager] Failed to start process: ${command}`, { error: err.message });
        reject(err);
      });
    });
  }
}

app.on('before-quit', () => ProcessManager.killAll());
