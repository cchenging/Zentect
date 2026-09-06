// Module: export/backend - ExportProjectAssembler 时间窗容错回归测试
// 背景：daemon KM 历史脏数据存在"videoTimelineStartMs==EndMs / 逆序"形态（如 seg_7 的
//       32544.9/32544.9），旧 `??` 链只挡 nullish 挡不住非空无效值 → start<end 校验
//       fail-fast 炸整次剪映导出（2026-09-03 修复点，本文件防回归）。
//       修复后三级取值：有效 timeline → 切片窗口回退 → 原语义（0 / 0+配音时长）。

import { describe, it, expect, vi } from 'vitest';
import { assembleExportProjectSync } from '../ExportProjectAssembler';

/** 构造最小可装配项目数据（1 条镜头，时间窗/切片/TTS 可覆盖） */
function buildProjectData(matchResult: Record<string, unknown>, ttsResults: unknown[] = []) {
  return {
    projectName: '测试项目',
    mediaItems: [{ id: 'm1', type: 'video', filePath: 'F:/videos/src.mp4' }],
    matchResults: [{
      id: 'seg_7',
      shotId: 'seg_7',
      text: '原声：我爷不行了啥 我爷爷不行了',
      keepOriginalAudio: true,
      ...matchResult,
    }],
    ttsResults,
  };
}

/** 构造装配依赖：repo 返回给定数据，dehydratePath 恒等 */
function buildDeps(data: Record<string, unknown>) {
  return {
    projectRepo: { loadFullProjectData: vi.fn(() => data) },
    dehydratePath: (p: string) => p,
  };
}

/** 通用装配选项：跳过字幕样式读取（免注入 settingsService）。
 *  ⚠️ unmatchedPolicy='keep'：本组测试校验装配层"坏窗口容错"，用 keep 显式保留旧"未匹配定格"语义；默认 block 的拦截行为由下方专有用例覆盖。 */
const BASE_OPTIONS = { includeSubtitleStyle: false, unmatchedPolicy: 'keep' as const };

describe('ExportProjectAssembler 时间窗容错（坏 timeline 三级取值）', () => {
  it('🎯 核心回归（seg_7 实录）：timeline 两端相等 + 切片窗口合法 → 不抛错，回退切片窗口', () => {
    const { project } = assembleExportProjectSync('p1', BASE_OPTIONS, buildDeps(buildProjectData({
      mediaId: 'chunk_095_seg29',
      videoTimelineStartMs: 32544.9,
      videoTimelineEndMs: 32544.9,
      chunkData: { id: 'chunk_095_seg29', startMs: 679640, endMs: 682640 },
    })));
    expect(project.shots).toHaveLength(1);
    expect(project.shots[0].videoTimelineStartMs).toBe(679640);   // 修复前：此处抛"时间窗无效"
    expect(project.shots[0].videoTimelineEndMs).toBe(682640);
    expect(project.shots[0].start).toBeCloseTo(679.64, 6);        // 秒级源坐标
    expect(project.shots[0].end).toBeCloseTo(682.64, 6);
  });

  it('🎯 timeline 有效 → 原样采用（优先级高于切片窗口，正常路径零影响）', () => {
    const { project } = assembleExportProjectSync('p1', BASE_OPTIONS, buildDeps(buildProjectData({
      mediaId: 'c_1',
      videoTimelineStartMs: 1000,
      videoTimelineEndMs: 4000,
      chunkData: { id: 'c_1', startMs: 0, endMs: 999999 },
    })));
    expect(project.shots[0].videoTimelineStartMs).toBe(1000);
    expect(project.shots[0].videoTimelineEndMs).toBe(4000);
  });

  it('🎯 0/0 无切片 + 有配音 → unmatched 定格兜底（原语义保留不回退）', () => {
    const { project } = assembleExportProjectSync('p1', BASE_OPTIONS, buildDeps(buildProjectData({
      mediaId: '',
      videoTimelineStartMs: 0,
      videoTimelineEndMs: 0,
      chunkData: null,
    }, [{ id: 'seg_7', audioUrl: 'F:/tts/seg_7.mp3', duration: 3.5 }])));
    expect(project.shots).toHaveLength(1);
    expect(project.shots[0].unmatched).toBe(true);
    expect(project.shots[0].start).toBe(0);
    expect(project.shots[0].end).toBe(3.5);                       // 目标时长=配音时长
  });

  it('🎯 0/0 无切片无配音 → 跳过该镜头（不因单个坏镜头中断导出）', () => {
    const { project } = assembleExportProjectSync('p1', BASE_OPTIONS, buildDeps(buildProjectData({
      mediaId: '',
      videoTimelineStartMs: 0,
      videoTimelineEndMs: 0,
      chunkData: null,
    })));
    expect(project.shots).toHaveLength(0);
  });
});

describe('ExportProjectAssembler 未匹配段策略（2026-09-05 拦截式，杜绝末帧定格混入片尾字卡）', () => {
  /** 未匹配但有配音的项目数据 */
  const unmatchedTtsData = () => buildProjectData(
    {
      mediaId: '',
      videoTimelineStartMs: 0,
      videoTimelineEndMs: 0,
      chunkData: null,
      id: 'seg_noMatch',
    },
    [{ id: 'seg_noMatch', audioUrl: 'F:/tts/seg_noMatch.mp3', duration: 3.5 }],
  );

  it('🚫 默认(block)：未匹配段存在 → 装配抛错并列全量段 id（拦截式）', () => {
    const data = unmatchedTtsData();
    expect(() => assembleExportProjectSync('p1', { includeSubtitleStyle: false }, buildDeps(data)))
      .toThrow(/seg_noMatch/);
  });

  it('✅ skip：未匹配段被跳过（配音/字幕一并丢弃），正常镜头照常导出', () => {
    const base: any = unmatchedTtsData();
    base.matchResults.push({
      id: 'seg_ok',
      shotId: 'seg_ok',
      text: '正常镜头',
      keepOriginalAudio: false,
      mediaId: 'chunk_1_seg0',
      videoTimelineStartMs: 1000,
      videoTimelineEndMs: 4000,
      chunkData: { id: 'chunk_1_seg0', startMs: 1000, endMs: 4000 },
    });
    const { project } = assembleExportProjectSync('p1', { includeSubtitleStyle: false, unmatchedPolicy: 'skip' }, buildDeps(base));
    expect(project.shots.map((s: any) => s.id)).not.toContain('seg_noMatch');
    expect(project.shots.map((s: any) => s.id)).toContain('seg_ok');
  });

  it('✅ keep：显式保留旧语义（未匹配 → unmatched 定格 shot），供下游 exporter 定格单测使用', () => {
    const { project } = assembleExportProjectSync('p1', { includeSubtitleStyle: false, unmatchedPolicy: 'keep' }, buildDeps(unmatchedTtsData()));
    expect(project.shots).toHaveLength(1);
    expect(project.shots[0].unmatched).toBe(true);
  });
});
