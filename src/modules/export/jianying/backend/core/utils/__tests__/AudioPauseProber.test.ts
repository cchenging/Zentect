// 📁 路径：src/modules/export/jianying/backend/core/utils/__tests__/AudioPauseProber.test.ts
// 配音静音探针：解析 ffmpeg silencedetect 输出 + 二进制路径推导 + 缺文件保护

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  parseSilenceDetectOutput,
  probeAudioPausesSync,
  resolveFfmpegPath,
} from '../AudioPauseProber';
import type { ExportBinDeps } from '../FfprobeProber';

const sampleStderr = [
  '[silencedetect @ 000001] silence_start: 0',
  '[silencedetect @ 000001] silence_end: 0.083 | silence_duration: 0.083',
  '[silencedetect @ 000001] silence_start: 2.07',
  '[silencedetect @ 000001] silence_end: 2.374 | silence_duration: 0.304',
  '[silencedetect @ 000001] silence_start: 3.712',
  '[silencedetect @ 000001] silence_end: 3.996 | silence_duration: 0.284',
  '[silencedetect @ 000001] silence_start: 5.303', // 末尾未闭合：静到文件结束
].join('\n');

describe('parseSilenceDetectOutput', () => {
  it('成对解析静音区间（毫秒），丢弃末尾未闭合静音', () => {
    expect(parseSilenceDetectOutput(sampleStderr)).toEqual([
      { startMs: 0, endMs: 83 },
      { startMs: 2070, endMs: 2374 },
      { startMs: 3712, endMs: 3996 },
    ]);
  });

  it('无静音/空输出 → 空数组', () => {
    expect(parseSilenceDetectOutput('')).toEqual([]);
    expect(parseSilenceDetectOutput('[silencedetect @ 0] nothing here')).toEqual([]);
  });
});

describe('resolveFfmpegPath', () => {
  it('显式注入优先', () => {
    const deps: ExportBinDeps = {
      getFfprobePath: () => 'C:/nonexistent/ffprobe.exe',
      getFfmpegPath: () => process.execPath,
    };
    expect(resolveFfmpegPath(deps)).toBe(process.execPath);
  });

  it('未注入时按 ffprobe 同目录推导；目标不存在 → 空串', () => {
    const deps: ExportBinDeps = { getFfprobePath: () => 'C:/nonexistent/ffprobe.exe' };
    expect(resolveFfmpegPath(deps)).toBe('');
  });

  it('ffprobe 路径缺失 → 空串', () => {
    expect(resolveFfmpegPath({ getFfprobePath: () => '' })).toBe('');
  });
});

describe('probeAudioPausesSync', () => {
  it('文件不存在 → 空数组（不抛错、不启动进程）', () => {
    const diag = path.join('C:', 'nonexistent', 'tts.mp3');
    expect(probeAudioPausesSync({ getFfprobePath: () => '' }, diag)).toEqual([]);
  });
});
