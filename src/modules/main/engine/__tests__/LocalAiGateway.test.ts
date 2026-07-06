import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHttpGet, mockHttpPost } = vi.hoisted(() => ({
  mockHttpGet: vi.fn(),
  mockHttpPost: vi.fn(),
}));

vi.mock('../../core/HttpClient', () => ({
  HttpClient: class {
    get = mockHttpGet;
    post = mockHttpPost;
  },
}));

vi.mock('../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_GATEWAY: 'ai-gateway', MEDIA: 'media', TTS: 'tts', AI_ENGINE: 'ai-engine' },
}));

import { LocalAiGateway } from '../LocalAiGateway';

describe('LocalAiGateway', () => {
  let gateway: LocalAiGateway;

  beforeEach(() => {
    LocalAiGateway['instance'] = undefined as any;
    vi.clearAllMocks();
    gateway = LocalAiGateway.getInstance();
  });

  it('is a singleton', () => {
    const g2 = LocalAiGateway.getInstance();
    expect(g2).toBe(gateway);
  });

  it('getClonedVoices returns voice list on success', async () => {
    mockHttpGet.mockResolvedValue({ code: 0, voices: [{ id: 'v1', name: '小新' }] });
    const result = await gateway.getClonedVoices();
    expect(result).toBeDefined();
    expect(result.code).toBe(0);
    expect(result.voices).toHaveLength(1);
  });

  it('getClonedVoices returns error code on failure', async () => {
    mockHttpGet.mockRejectedValue(new Error('Network error'));
    const result = await gateway.getClonedVoices();
    expect(result.code).toBe(-1);
    expect(result.voices).toEqual([]);
  });

  it('deleteClonedVoice succeeds', async () => {
    mockHttpPost.mockResolvedValue({ code: 0 });
    const result = await gateway.deleteClonedVoice('clone-1');
    expect(result).toBeDefined();
  });
});
