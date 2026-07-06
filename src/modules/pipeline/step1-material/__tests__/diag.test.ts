
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';

const { mockTranscribe } = vi.hoisted(() => ({ mockTranscribe: vi.fn() }));

vi.mock('fs', () => ({
  default: { existsSync: vi.fn(() => false), mkdirSync: vi.fn() },
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));
vi.mock('path', () => ({
  default: { join: vi.fn((...a: string[]) => a.join('/')) },
  join: vi.fn((...a: string[]) => a.join('/')),
}));
vi.mock('../../../../main/engine/media/VideoProcessor', () => ({
  VideoProcessor: { extractFrames: vi.fn() },
}));
vi.mock('../../../../main/engine/media/AudioProcessor', () => ({
  AudioProcessor: { separateAudio: vi.fn(), separateVocalsBgm: vi.fn() },
}));
vi.mock('../../../../main/engine/media/VisionProcessor', () => ({
  VisionProcessor: { scanFaces: vi.fn() },
}));
vi.mock('../../../../main/engine/strategies/LocalWhisperStrategy', () => ({
  LocalWhisperStrategy: vi.fn(function() {
    return { transcribe: mockTranscribe };
  }),
}));
vi.mock('../../../../main/core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../infra/logger/LogConstants', () => ({
  LOG_TAGS: { SCHEDULER: 'SCHEDULER', MEDIA_ENGINE: 'MEDIA_ENGINE' },
}));

import { LocalWhisperStrategy } from '../../../../main/engine/strategies/LocalWhisperStrategy';

describe('CLOSURE_TEST2', () => {
  it('check constructor and transcribe', () => {
    mockTranscribe.mockClear();
    const instance = new LocalWhisperStrategy();
    console.log('instance:', JSON.stringify(instance));
    console.log('transcribe === mockTranscribe:', instance.transcribe === mockTranscribe);
    console.log('typeof instance.transcribe:', typeof instance.transcribe);
    
    instance.transcribe('test');
    console.log('mockTranscribe calls after call:', mockTranscribe.mock.calls.length);
    
    expect(instance.transcribe).toBe(mockTranscribe);
  });
});
