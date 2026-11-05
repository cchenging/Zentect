// Module: export/backend - 导出前产物门禁（设计 3.6 回归测试）
// 三重校验：步骤5 completed + 版本戳 valid !== false + source !== 'backend'；
// 旧项目（缺少元数据 / legacy 戳）只警告放行。

import { describe, it, expect, vi } from 'vitest';
import { assembleExportProjectSync } from '../ExportProjectAssembler';

const stamp = (overrides: Record<string, unknown> = {}) => ({
  rev: 3,
  fromKey: 'k3',
  keyVersion: 1,
  valid: true,
  source: 'renderer',
  ...overrides,
});

function buildData(meta: Record<string, unknown> = {}) {
  return {
    projectName: '门禁测试',
    mediaItems: [{ id: 'm1', type: 'video', filePath: 'F:/videos/src.mp4' }],
    matchResults: [{
      id: 'seg_1',
      shotId: 'seg_1',
      text: '一句话',
      mediaId: 'c1',
      videoTimelineStartMs: 1000,
      videoTimelineEndMs: 4000,
      chunkData: { id: 'c1', startMs: 0, endMs: 999999 },
    }],
    ...meta,
  };
}

const deps = (data: Record<string, unknown>) => ({
  projectRepo: { loadFullProjectData: vi.fn(() => data) },
  dehydratePath: (p: string) => p,
});

const OPTIONS = { includeSubtitleStyle: false, unmatchedPolicy: 'keep' as const };

describe('ExportProjectAssembler 产物门禁', () => {
  it('旧项目缺少 stepStatuses / artifactStamps → 警告放行', () => {
    expect(() => assembleExportProjectSync('p1', OPTIONS, deps(buildData()))).not.toThrow();
  });

  it('legacy 版本戳 → 警告放行', () => {
    const data = buildData({
      stepStatuses: ['completed', 'completed', 'completed', 'completed', 'completed'],
      artifactStamps: { revs: { 5: 0 }, stamps: { 5: stamp({ rev: 0, source: 'legacy', valid: true }) } },
    });
    expect(() => assembleExportProjectSync('p1', OPTIONS, deps(data))).not.toThrow();
  });

  it('步骤5 状态非 completed → 阻断', () => {
    const data = buildData({
      stepStatuses: ['completed', 'completed', 'completed', 'completed', 'idle'],
      artifactStamps: { revs: {}, stamps: {} },
    });
    expect(() => assembleExportProjectSync('p1', OPTIONS, deps(data))).toThrow(/步骤5状态/);
  });

  it('版本戳 valid=false（上游已变更）→ 阻断', () => {
    const data = buildData({
      stepStatuses: ['completed', 'completed', 'completed', 'completed', 'completed'],
      artifactStamps: { revs: { 5: 3 }, stamps: { 5: stamp({ valid: false }) } },
    });
    expect(() => assembleExportProjectSync('p1', OPTIONS, deps(data))).toThrow(/已过期/);
  });

  it('版本戳 source=backend（后端直写未验证）→ 阻断', () => {
    const data = buildData({
      stepStatuses: ['completed', 'completed', 'completed', 'completed', 'completed'],
      artifactStamps: { revs: { 5: 3 }, stamps: { 5: stamp({ source: 'backend', valid: false }) } },
    });
    expect(() => assembleExportProjectSync('p1', OPTIONS, deps(data))).toThrow(/后端直写/);
  });

  it('步骤5 completed + renderer 有效版本戳 → 放行', () => {
    const data = buildData({
      stepStatuses: ['completed', 'completed', 'completed', 'completed', 'completed'],
      artifactStamps: { revs: { 5: 3 }, stamps: { 5: stamp() } },
    });
    expect(() => assembleExportProjectSync('p1', OPTIONS, deps(data))).not.toThrow();
  });
});
