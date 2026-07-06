// 📁 新建文件: src/main/engine/SkillRouter.ts
// V1.2: 技能路由 — 将技能映射为系统动作并入队

import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';
import { Skill, SkillRouteResult, BUILTIN_SKILLS } from '../../shared/types/skill';
import { BatchQueueEngine, BatchJobInput } from './BatchQueueEngine';

export class SkillRouter {
  private skills: Map<string, Skill> = new Map();

  constructor() {
    BUILTIN_SKILLS.forEach(s => this.skills.set(s.id, s));
  }

  /** 注册自定义技能（预留 V2.0 Recipe 系统入口） */
  registerSkill(skill: Skill): void {
    this.skills.set(skill.id, skill);
    AppLogger.info(LOG_TAGS.ENGINE, `[SkillRouter] 注册技能: ${skill.name} (${skill.id})`);
  }

  /** 获取所有可用技能 */
  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /** 根据技能 ID 获取技能定义 */
  getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  /** 执行技能路由 — 将技能+参数映射为系统动作 */
  route(skillId: string, params: Record<string, any> = {}): SkillRouteResult {
    const skill = this.skills.get(skillId);
    if (!skill) throw new Error(`未知技能: ${skillId}`);

    // 合并参数：默认值 + 用户参数
    const resolvedParams: Record<string, any> = {};
    for (const [key, def] of Object.entries(skill.params)) {
      resolvedParams[key] = params[key] !== undefined ? params[key] : def.defaultValue;
    }

    AppLogger.info(LOG_TAGS.ENGINE, `[SkillRouter] 路由技能: ${skill.name}, 动作: ${skill.systemActions.join(', ')}`);

    return {
      skillId: skill.id,
      matchedActions: skill.systemActions,
      pipelinePayload: {
        actionType: skill.systemActions[0] || 'render-mp4',
        params: resolvedParams,
      },
    };
  }

  /** 执行技能并将生成的作业入队 */
  async executeAndEnqueue(
    skillId: string,
    projectInputs: Array<{ projectId: string; projectName: string; mediaPath: string; shots: any[] }>,
    params: Record<string, any> = {},
  ): Promise<BatchJobInput[]> {
    this.route(skillId, params);

    const jobs: BatchJobInput[] = projectInputs.map(input => ({
      projectId: input.projectId,
      projectName: input.projectName,
      mediaPath: input.mediaPath,
      shots: input.shots,
    }));

    const queueEngine = BatchQueueEngine.getInstance();
    queueEngine.addJobs(jobs);
    await queueEngine.start();

    AppLogger.info(LOG_TAGS.ENGINE, `[SkillRouter] 技能 [${skillId}] 已入队 ${jobs.length} 个任务`);
    return jobs;
  }
}
