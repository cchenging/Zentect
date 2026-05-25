// 📁 新建文件: src/main/cli/index.ts
// V1.2: 命令行工具入口 — 支持无界面执行管线、队列管理、配置查看

import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
import { SkillRouter } from '../engine/SkillRouter';
import { BatchQueueEngine } from '../engine/BatchQueueEngine';
import { PathManager } from '../utils/pathManager';
import * as fs from 'fs';
import * as path from 'path';

/** 解析命令行参数 */
function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = i + 1 < args.length && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      parsed[key] = val;
    } else if (!args[i].startsWith('-') && args[i] !== 'run' && args[i] !== 'queue' && args[i] !== 'config') {
      parsed._positional = (parsed._positional ? parsed._positional + ' ' : '') + args[i];
    }
  }
  return parsed;
}

export async function runCli(args: string[]): Promise<void> {
  AppLogger.info(LOG_TAGS.SYSTEM, `[CLI] 启动命令行模式, args=[${args.join(', ')}]`);

  const command = args[0];
  const params = parseArgs(args.slice(1));

  switch (command) {
    // ===== run — 无界面执行技能管线 =====
    case 'run': {
      const { skill, input } = params;
      if (!input) {
        console.error('错误: --input <video_file> 参数是必需的');
        console.error('用法: zentect run --input <video> --skill quick-narrate');
        process.exit(1);
      }
      if (!fs.existsSync(input)) {
        console.error(`错误: 文件不存在 — ${input}`);
        process.exit(1);
      }

      const skillId = skill || 'quick-narrate';
      const router = new SkillRouter();

      // 验证技能
      const skillDef = router.getSkill(skillId);
      if (!skillDef) {
        console.error(`错误: 未知技能 — "${skillId}"`);
        console.error(`可用技能: ${router.listSkills().map(s => `${s.id}(${s.name})`).join(', ')}`);
        process.exit(1);
      }

      console.log(`\n🎬 Zentect CLI v1.2`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  输入文件 : ${path.basename(input as string)}`);
      console.log(`  执行技能 : ${skillDef.name}`);
      console.log(`  工作目录 : ${PathManager.getProjectDir('cli_session')}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      // 构造批量作业提交到队列
      const projectInput = {
        projectId: `cli_${Date.now()}`,
        projectName: path.basename(input as string, path.extname(input as string)),
        mediaPath: input as string,
        shots: [],
      };

      try {
        const jobs = await router.executeAndEnqueue(skillId, [projectInput]);
        if (jobs.length > 0) {
          console.log(`✅ 作业已加入队列 (${jobs.length} 个任务)，开始处理...\n`);
          const queue = BatchQueueEngine.getInstance();
          await queue.start();
          console.log('⏳ 后台处理中，可用 zentect queue status 查看进度');
        }
      } catch (err: any) {
        console.error(`❌ 执行失败: ${err.message}`);
        process.exit(2);
      }
      break;
    }

    // ===== queue — 队列管理 =====
    case 'queue': {
      const queue = BatchQueueEngine.getInstance();
      const subCmd = params._positional || 'status';

      if (subCmd === 'status') {
        const status = queue.getStatus();
        console.log(JSON.stringify(status, null, 2));
      } else if (subCmd === 'start') {
        await queue.start();
        console.log('队列已启动');
      } else if (subCmd === 'pause') {
        queue.pause();
        console.log('队列已暂停');
      } else {
        console.error(`未知子命令: ${subCmd}`);
        console.error('用法: zentect queue [status|start|pause]');
        process.exit(1);
      }
      break;
    }

    // ===== config — 查看当前配置 =====
    case 'config': {
      const subCmd = params._positional || 'list';
      if (subCmd === 'list') {
        console.log('配置信息: (V2.0 完善)');
        console.log(`  项目区: ${PathManager.getProjectDir('cli_session')}`);
      }
      break;
    }

    default:
      console.error(`未知命令: ${command}`);
      console.error('可用命令: run, queue, config');
      process.exit(1);
  }

  AppLogger.info(LOG_TAGS.SYSTEM, '[CLI] 命令行模式执行完毕');
  process.exit(0);
}
