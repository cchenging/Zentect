// Module: export/backend - ExportProjectAssembler 字幕样式随风格包浓度派生（第三增量）
// 背景：风格包只控文案/配音时，成片字幕仍用全局样式；本文件锁定「浓度 → 字号/描边/行宽」的叠加口径。

import { describe, it, expect, vi } from 'vitest';
import { assembleExportProjectSync } from '../ExportProjectAssembler';

/** 用户全局字幕样式（SettingsService 返回值） */
const GLOBAL_STYLE = {
  color: [1, 1, 1],
  fontSize: 3.5,
  strokeColor: [0, 0, 0],
  strokeWidth: 0.02,
  alignment: 1,
  letterSpacing: 0,
  lineSpacing: 0.02,
  lineMaxWidth: 0.82,
  verticalOffset: 0.3,
  fontSizeLandscape: 5.0,
};

function buildProjectData(overrides: Record<string, unknown> = {}) {
  return {
    projectName: '测试项目',
    mediaItems: [{ id: 'm1', type: 'video', filePath: 'F:/videos/src.mp4' }],
    matchResults: [{
      id: 'seg_1',
      shotId: 'shot_1',
      mediaId: 'm2',
      text: '测试文案',
      chunkData: null,
      videoTimelineStartMs: 0,
      videoTimelineEndMs: 3000,
    }],
    ttsResults: [],
    ...overrides,
  };
}

function buildDeps(data: Record<string, unknown>) {
  return {
    projectRepo: { loadFullProjectData: vi.fn(() => data) },
    settingsService: { getSubtitleStyle: vi.fn(() => ({ ...GLOBAL_STYLE })) },
    dehydratePath: (p: string) => p,
  };
}

describe('ExportProjectAssembler 字幕样式 × 风格包浓度', () => {
  it('默认包（正常浓度）→ 原样使用全局字幕样式，不写任何派生字段', () => {
    const { project } = assembleExportProjectSync('p1', {}, buildDeps(buildProjectData()));
    expect(project.subtitleStyle).toEqual(GLOBAL_STYLE);
    expect(project.subtitleStyle).not.toHaveProperty('lineWidthDelta');
  });

  it('稳（level=0）→ 字号/横屏字号/描边按倍率收敛，行宽放宽 +3', () => {
    const { project } = assembleExportProjectSync(
      'p1',
      {},
      buildDeps(buildProjectData({ stylePack: { persona: 'dongbei', level: 0 } })),
    );
    expect(project.subtitleStyle?.fontSize).toBe(3.29);
    expect(project.subtitleStyle?.fontSizeLandscape).toBe(4.7);
    expect(project.subtitleStyle?.strokeWidth).toBe(0.018);
    expect(project.subtitleStyle?.lineWidthDelta).toBe(3);
  });

  it('拉满（level=2）→ 字号放大、描边加粗，行宽收紧 -3', () => {
    const { project } = assembleExportProjectSync(
      'p1',
      {},
      buildDeps(buildProjectData({ stylePack: { persona: 'animal', level: 2 } })),
    );
    expect(project.subtitleStyle?.fontSize).toBe(3.78);
    expect(project.subtitleStyle?.fontSizeLandscape).toBe(5.4);
    expect(project.subtitleStyle?.strokeWidth).toBe(0.025);
    expect(project.subtitleStyle?.lineWidthDelta).toBe(-3);
  });
});
