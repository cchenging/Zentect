import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { resolveForMedia } = vi.hoisted(() => ({ resolveForMedia: vi.fn() }));
vi.mock('../MediaTrimPolicy', async () => {
  const actual = await vi.importActual('../MediaTrimPolicy') as any;
  return { ...actual, resolveForMedia };
});

import { TrimmedSourceResolver } from '../TrimmedSourceResolver';

const FF = 'F:/Tools/Zentect/resources/bin/win/ffmpeg.exe';
const PROBE = 'F:/Tools/Zentect/resources/bin/win/ffprobe.exe';

function durationSec(p: string): number {
  const out = execFileSync(PROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString().trim();
  return Math.round(parseFloat(out) * 100) / 100;
}

describe('TrimmedSourceResolver（真实 ffmpeg 冒烟）', () => {
  let srcWav: string;
  beforeAll(() => {
    srcWav = path.join(os.tmpdir(), 'trim_resolver_smoke_src.wav');
    // 生成 10s 测试音频
    execFileSync(FF, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-ar', '16000', '-ac', '1', srcWav]);
  });
  afterAll(() => {
    try { fs.unlinkSync(srcWav); } catch { /* ignore */ }
  });

  it('mode=body 应切出正剧段（10s 源 - 2s OP - 1s ED = 7s）', async () => {
    resolveForMedia.mockReturnValue({ trimStartMs: 2000, trimEndMs: 1000, srcDurationMs: 10000 });
    const src = await TrimmedSourceResolver.resolve({
      projectId: 'p_test', mediaId: `media_smoke_${Date.now()}`,
      mediaPath: srcWav, mode: 'body', ext: '.wav',
      getFfmpegPath: () => FF,
    });
    expect(src.shouldTrim).toBe(true);
    expect(src.trimmedPath).not.toBe(srcWav);
    expect(fs.existsSync(src.trimmedPath)).toBe(true);
    // body 坐标换算（toMediaWindow 真实实现）
    expect(src.toSource(0)).toBeCloseTo(2.0, 1);
    expect(src.toSource(7)).toBeCloseTo(9.0, 1);
    expect(src.toBody(9)).toBeCloseTo(7.0, 1);
    // 实际输出时长 ≈ 7s（验证 ffmpeg -ss/-to 已按源坐标换算）
    expect(durationSec(src.trimmedPath)).toBeGreaterThanOrEqual(6.9);
    expect(durationSec(src.trimmedPath)).toBeLessThanOrEqual(7.1);
  });

  it('mode=body 视频窗口应切出正剧段（P1-4 场景切片/抽帧源）', async () => {
    const srcMp4 = path.join(os.tmpdir(), `trim_resolver_smoke_v_${Date.now()}.mp4`);
    execFileSync(FF, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=10:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', srcMp4]);
    try {
      resolveForMedia.mockReturnValue({ trimStartMs: 2000, trimEndMs: 1000, srcDurationMs: 10000 });
      const src = await TrimmedSourceResolver.resolve({
        projectId: 'p_test', mediaId: `media_smoke_${Date.now()}`,
        mediaPath: srcMp4, mode: 'body', ext: '.mp4',
        getFfmpegPath: () => FF,
      });
      expect(src.shouldTrim).toBe(true);
      expect(fs.existsSync(src.trimmedPath)).toBe(true);
      // 视频流 copy 切片，时长约 7s（关键帧对齐允许小偏差）
      const d = durationSec(src.trimmedPath);
      expect(d).toBeGreaterThanOrEqual(6.5);
      expect(d).toBeLessThanOrEqual(7.5);
    } finally {
      try { fs.unlinkSync(srcMp4); } catch { /* ignore */ }
    }
  });

  it('无裁剪时应透传原路径（shouldTrim=false）', async () => {
    resolveForMedia.mockReturnValue({ trimStartMs: 0, trimEndMs: 0, srcDurationMs: 10000 });
    const src = await TrimmedSourceResolver.resolve({
      projectId: 'p_test', mediaId: `media_smoke_${Date.now()}`,
      mediaPath: srcWav, mode: 'body', ext: '.wav',
      getFfmpegPath: () => FF,
    });
    expect(src.shouldTrim).toBe(false);
    expect(src.trimmedPath).toBe(srcWav);
  });
});
