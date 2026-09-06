// Module: export/backend - ExportProjectAssembler BGM 装配回归测试
// 背景：曲库点选的 BGM 持久化为对象 { id, filePath, name, bpm }（ProjectRepository 约定），
//       装配器必须取 .filePath——若把对象直接当路径传给 dehydrateMagicPath，会被其类型
//       守卫归一为空串，剪映草稿 BGM 轨道静默丢失（2026-09-03 修复点，本文件防回归）。

import { describe, it, expect, vi } from 'vitest';
import { assembleExportProjectSync } from '../ExportProjectAssembler';

/** 构造最小可装配项目数据（1 条已匹配镜头 + 空 TTS，避免额外依赖） */
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

/** 构造装配依赖：repo 返回给定数据；dehydratePath 可注入自定义实现，默认恒等 */
function buildDeps(data: Record<string, unknown>, dehydrate?: (p: string) => string) {
  const dehydratePath = vi.fn(dehydrate ?? ((p: string) => p));
  return {
    deps: {
      projectRepo: { loadFullProjectData: vi.fn(() => data) },
      dehydratePath,
    },
    dehydratePath,
  };
}

/** 通用装配选项：跳过字幕样式读取（免注入 settingsService） */
const BASE_OPTIONS = { includeSubtitleStyle: false } as const;

describe('ExportProjectAssembler BGM 装配', () => {
  it('曲库点选 BGM（activeBgm 对象形态）→ bgmPath 取 filePath（核心回归用例）', () => {
    const { deps } = buildDeps(buildProjectData({
      activeBgm: { id: 'lib-1', filePath: 'F:/Tools/Zentect/resources/bgm-library/chill/song.mp3', name: 'Song', bpm: 120 },
    }));
    const { project } = assembleExportProjectSync('p1', BASE_OPTIONS, deps);
    expect(project.bgmPath).toBe('F:/Tools/Zentect/resources/bgm-library/chill/song.mp3');
  });

  it('activeBgm 字符串形态（历史数据）→ 原样采用', () => {
    const { deps } = buildDeps(buildProjectData({ activeBgm: 'F:/music/old.mp3' }));
    const { project } = assembleExportProjectSync('p1', BASE_OPTIONS, deps);
    expect(project.bgmPath).toBe('F:/music/old.mp3');
  });

  it('分离伴奏 extractedBgm 优先于曲库 activeBgm', () => {
    const { deps } = buildDeps(buildProjectData({
      mediaItems: [
        { id: 'm1', type: 'video', filePath: 'F:/videos/src.mp4' },
        { id: 'm2', type: 'audio', extractedBgm: 'F:/sep/instrumental.mp3' },
      ],
      activeBgm: { id: 'lib-1', filePath: 'F:/library/song.mp3', name: 'Song' },
    }));
    const { project } = assembleExportProjectSync('p1', BASE_OPTIONS, deps);
    expect(project.bgmPath).toBe('F:/sep/instrumental.mp3');
  });

  it('activeBgm 对象缺 filePath → bgmPath undefined（不静默造路径）', () => {
    const { deps } = buildDeps(buildProjectData({
      activeBgm: { id: 'lib-1', name: 'Song' },
    }));
    const { project } = assembleExportProjectSync('p1', BASE_OPTIONS, deps);
    expect(project.bgmPath).toBeUndefined();
  });

  it('无 extractedBgm 且无 activeBgm → bgmPath undefined', () => {
    const { deps } = buildDeps(buildProjectData());
    const { project } = assembleExportProjectSync('p1', BASE_OPTIONS, deps);
    expect(project.bgmPath).toBeUndefined();
  });

  it('bgmPath 经 dehydratePath 脱水（magic:// → Windows 物理路径）', () => {
    const { deps, dehydratePath } = buildDeps(
      buildProjectData({
        activeBgm: { id: 'lib-1', filePath: 'magic://local/F:/music/song.mp3', name: 'Song' },
      }),
      (p) => (p.startsWith('magic://local/') ? p.replace('magic://local/', '').replace(/\//g, '\\') : p),
    );
    const { project } = assembleExportProjectSync('p1', BASE_OPTIONS, deps);
    expect(project.bgmPath).toBe('F:\\music\\song.mp3');
    expect(dehydratePath).toHaveBeenCalled();
  });
});
