import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';
import { CheckpointRepository } from '../pipeline/CheckpointRepository';

export interface RecoveryStatus {
  projectId: string;
  hasIncomplete: boolean;
  failedStepId: string | null;
  failedStepLabel: string | null;
  errorMessage: string | null;
  completedSteps: string[];
  totalSteps: number;
}

export class PipelineRecoveryService {
  private checkpointRepo = new CheckpointRepository();

  probeAllProjects(knownProjectIds: string[]): RecoveryStatus[] {
    const results: RecoveryStatus[] = [];

    for (const projectId of knownProjectIds) {
      try {
        const status = this.probeProject(projectId);
        if (status) results.push(status);
      } catch (err) {
        AppLogger.error(LOG_TAGS.ENGINE, `探测项目 ${projectId} 恢复状态失败`, err);
      }
    }

    if (results.length > 0) {
      AppLogger.warn(LOG_TAGS.ENGINE, `检测到 ${results.length} 个项目存在未完成的 Pipeline`);
    }

    return results;
  }

  probeProject(projectId: string): RecoveryStatus | null {
    const allCheckpoints = this.checkpointRepo.findByProject(projectId);
    if (allCheckpoints.length === 0) return null;

    const incomplete = this.checkpointRepo.findIncompleteByProject(projectId);
    if (incomplete.length === 0) return null;

    const runningCheckpoints = incomplete.filter(c => c.status === 'running');
    runningCheckpoints.forEach(c => {
      try {
        this.checkpointRepo.upsert({
          projectId,
          mediaId: c.media_id,
          stepId: c.step_id,
          stepOrder: c.step_order,
          status: 'failed',
          errorMessage: 'SYS_CRASH_RECOVERY',
        });
      } catch (err) {
        AppLogger.error(LOG_TAGS.ENGINE, `标记 checkpoint 失败: ${c.step_id}`, err);
      }
    });

    const failedSteps = this.checkpointRepo
      .findByProject(projectId)
      .filter(c => c.status === 'failed')
      .sort((a, b) => a.step_order - b.step_order);

    const completedSteps = allCheckpoints
      .filter(c => c.status === 'completed' || c.status === 'degraded')
      .map(c => c.step_id);

    return {
      projectId,
      hasIncomplete: incomplete.length > 0,
      failedStepId: failedSteps[0]?.step_id || null,
      failedStepLabel: failedSteps[0]?.step_id || null,
      errorMessage: failedSteps[0]?.error_message || null,
      completedSteps,
      totalSteps: allCheckpoints.length,
    };
  }

  continuePipeline(projectId: string): { shouldContinue: boolean; completedSteps: string[] } {
    const allCheckpoints = this.checkpointRepo.findByProject(projectId);
    const completedSteps = allCheckpoints
      .filter(c => c.status === 'completed' || c.status === 'degraded')
      .map(c => c.step_id);

    const incomplete = allCheckpoints.filter(
      c => c.status === 'failed' || c.status === 'running'
    );

    return {
      shouldContinue: incomplete.length > 0,
      completedSteps,
    };
  }

  abandonPipeline(projectId: string): void {
    this.checkpointRepo.deleteByProject(projectId);
    AppLogger.info(LOG_TAGS.ENGINE, `Pipeline 恢复已放弃: project=${projectId}`);
  }
}
