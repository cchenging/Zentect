// Module: export/mp4 - 单元测试

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExportProject } from '../../contracts/ExportProject';
import { compileSrt, writeSrtFile, compileAss, writeAssFile, buildAssStyle } from '../backend/SubtitleAssembler';
import { assembleRenderShots } from '../backend/RenderShotsAssembler';
import { buildRenderJob } from '../backend/RenderJobFactory';
import { Mp4Exporter } from '../backend/Mp4Exporter';
import { AppError } from '@modules/infra/error/AppError';
import type { SubtitleStyle } from '../../jianying/types';

/** 测试用剪映字幕样式 */
const TEST_STYLE: SubtitleStyle = {
  color: [1, 1, 1],
  fontSize: 3.5,
  strokeColor: [0, 0, 0],
  strokeWidth: 0.02,
  alignment: 1,
  letterSpacing: 0,
  lineSpacing: 0.02,
  lineMaxWidth: 0.82,
  verticalOffset: 0.3,
};

/** 构造测试用 ExportProject */
function makeProject(overrides: Partial<ExportProject> = {}): ExportProject {
  return {
    projectId: 'proj-1',
    projectName: '测试项目',
    mediaPath: 'C:/media/video.mp4',
    bgmPath: 'C:/media/bgm.mp3',
    shots: [
      {
        id: 'shot-1',
        text: '第一句',
        aiText: 'AI第一句',
        start: 0,
        end: 5,
        duration: 5,
        audioPath: 'C:/tts/1.mp3',
        appliedSpeedFactor: 1.0,
      },
      {
        id: 'shot-2',
        text: '第二句',
        start: 5,
        end: 8,
        duration: 3,
      },
    ],
    ...overrides,
  };
}

// === SubtitleAssembler ===
describe('SubtitleAssembler', () => {
  it('compileSrt 应生成标准 SRT 结构（序号/时间窗/文本/空行）', () => {
    const srt = compileSrt(makeProject());

    expect(srt).toContain('1');
    expect(srt).toContain('00:00:00,000 --> 00:00:05,000');
    expect(srt).toContain('AI第一句'); // aiText 优先
    expect(srt).toContain('2');
    expect(srt).toContain('00:00:05,000 --> 00:00:08,000');
    expect(srt).toContain('第二句');
    // 空行分隔
    expect(srt.split('\n\n').length).toBeGreaterThanOrEqual(2);
  });

  it('compileSrt 应跳过无文本的镜头', () => {
    const project = makeProject();
    project.shots[1].text = undefined;
    project.shots[1].aiText = undefined;

    const srt = compileSrt(project);
    expect(srt).not.toContain('第二句');
    expect(srt).toContain('AI第一句');
  });

  it('writeSrtFile 应写入 SRT 文件并返回路径', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '.tmp');

    const srtPath = writeSrtFile(makeProject(), dir, 'out');

    expect(path.basename(srtPath)).toBe('out.srt');
    expect(fs.existsSync(srtPath)).toBe(true);
    expect(fs.readFileSync(srtPath, 'utf-8')).toContain('AI第一句');

    // 清理
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('buildAssStyle 应按剪映样式生成 ASS Style 行（字号/描边/对齐/垂直偏移）', () => {
    const styleLine = buildAssStyle(TEST_STYLE);

    // 默认 fontSize 3.5 → 91px；描边 0.02 → 24px；verticalOffset 0.3*1080=324
    expect(styleLine).toContain('Microsoft YaHei,91');
    expect(styleLine).toContain(',24,0,2,10,10,324,1');
    // 白色文字 + 黑色描边（ASS 用 BGR）
    expect(styleLine).toContain('&H00FFFFFF');
    expect(styleLine).toContain('&H00000000');
  });

  it('compileAss 应生成 ASS 头 + Dialogue（应用样式，时间窗为 H:MM:SS.cc）', () => {
    const ass = compileAss(makeProject(), TEST_STYLE);

    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain('PlayResY: 1080');
    expect(ass).toContain('Style: Default');
    // dialogue 时间格式
    expect(ass).toContain('0:00:00.00,0:00:05.00');
    expect(ass).toContain('AI第一句');
    expect(ass).toContain('第二句');
  });

  it('compileAss 应跳过无文本镜头', () => {
    const project = makeProject();
    project.shots[1].text = undefined;
    project.shots[1].aiText = undefined;

    const ass = compileAss(project, TEST_STYLE);
    expect(ass).not.toContain('第二句');
    expect(ass).toContain('AI第一句');
  });

  it('writeAssFile 应写入 ASS 文件并返回路径', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '.tmp');

    const assPath = writeAssFile(makeProject(), TEST_STYLE, dir, 'out');

    expect(path.basename(assPath)).toBe('out.ass');
    expect(fs.existsSync(assPath)).toBe(true);
    expect(fs.readFileSync(assPath, 'utf-8')).toContain('[Events]');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// === RenderShotsAssembler ===
describe('RenderShotsAssembler', () => {
  it('assembleRenderShots 应映射起止时间/配音/切片/变速', () => {
    const project = makeProject();
    project.shots[0].chunkData = { filePath: 'C:/chunk/1.mp4', startMs: 1000, endMs: 6000 };

    const shots = assembleRenderShots(project);

    expect(shots).toHaveLength(2);
    expect(shots[0].id).toBe('shot-1');
    expect(shots[0].startTime).toBe(0);
    expect(shots[0].endTime).toBe(5);
    expect(shots[0].ttsAudioPath).toBe('C:/tts/1.mp3');
    expect(shots[0].chunkData).toEqual({ filePath: 'C:/chunk/1.mp4', startMs: 1000, endMs: 6000 });
    expect(shots[0].speedFactor).toBe(1.0);
    expect(shots[1].ttsAudioPath).toBeUndefined();
  });
});

// === RenderJobFactory ===
describe('RenderJobFactory', () => {
  it('buildRenderJob 应透传 fps / preview / subtitlePath', () => {
    const project = makeProject({ fps: 60, preview: true });
    const job = buildRenderJob({
      project,
      outputDir: 'C:/out',
      outputName: '成片',
      subtitlePath: 'C:/out/成片.srt',
    });

    expect(job.projectId).toBe('proj-1');
    expect(job.mediaPath).toBe('C:/media/video.mp4');
    expect(job.bgmPath).toBe('C:/media/bgm.mp3');
    expect(job.fps).toBe(60);
    expect(job.preview).toBe(true);
    expect(job.subtitlePath).toBe('C:/out/成片.srt');
    expect(job.shots).toHaveLength(2);
  });
});

// === Mp4Exporter ===
describe('Mp4Exporter', () => {
  let exporter: Mp4Exporter;

  beforeEach(() => {
    exporter = new Mp4Exporter();
  });

  it('id 应为 mp4', () => {
    expect(exporter.id).toBe('mp4');
  });

  it('validate 缺少 projectId 应抛 AppError', () => {
    expect(() => exporter.validate({ projectId: '' } as any)).toThrow(AppError);
  });

  it('validate 缺少 project 应抛 AppError', () => {
    expect(() => exporter.validate({ projectId: 'p', project: undefined } as any)).toThrow(AppError);
  });

  it('validate 缺少 mediaPath 应抛 AppError', () => {
    const project = makeProject({ mediaPath: undefined });
    expect(() => exporter.validate({ projectId: 'p', project } as any)).toThrow(AppError);
  });

  it('validate 合法输入不应抛错', () => {
    expect(() => exporter.validate({ projectId: 'p', project: makeProject() } as any)).not.toThrow();
  });

  it('export 渲染失败应返回 success=false 与错误信息', async () => {
    // 模拟 FFmpegRenderer.render 返回失败
    vi.doMock('../../../../main/engine/media/FFmpegRenderer', () => ({
      FFmpegRenderer: class {
        async render() {
          return { success: false, outputPath: '', duration: 0, error: 'FFmpeg.exe 未找到' };
        }
      },
    }));

    // 重新加载（避免缓存）：resetModules 清空模块注册表，使 doMock 生效
    vi.resetModules();
    const { Mp4Exporter: ReloadedExporter } = await import('../backend/Mp4Exporter');
    const reloaded = new ReloadedExporter();

    const result = await reloaded.export({
      projectId: 'p',
      project: makeProject(),
      payload: { subtitleMode: 'none' },
    });

    expect(result.success).toBe(false);
    expect(result.exporterId).toBe('mp4');
    expect(result.error).toContain('FFmpeg.exe 未找到');
  });

  it('export 在 both 模式下应生成 ASS（烧录）与 SRT（附字幕）两个产出', async () => {
    // 模拟 FFmpegRenderer.render 成功，返回真实输出路径
    vi.doMock('../../../../main/engine/media/FFmpegRenderer', () => ({
      FFmpegRenderer: class {
        async render(job: any) {
          return { success: true, outputPath: `${job.outputDir}/${job.outputName}.mp4`, duration: 10 };
        }
      },
    }));

    vi.resetModules();
    const { Mp4Exporter: ReloadedExporter } = await import('../backend/Mp4Exporter');
    const reloaded = new ReloadedExporter();

    const project = makeProject({ subtitleStyle: TEST_STYLE as unknown as Record<string, unknown> });
    const result = await reloaded.export({
      projectId: 'p',
      project,
      payload: { subtitleMode: 'both', exportPath: 'C:/out' },
    });

    expect(result.success).toBe(true);
    // 成片 + SRT 附字幕都出现在 fileNames
    expect(result.fileNames?.some((n) => n.endsWith('.mp4'))).toBe(true);
    expect(result.fileNames?.some((n) => n.endsWith('.srt'))).toBe(true);
  });
});