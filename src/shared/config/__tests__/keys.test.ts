import { describe, it, expect } from 'vitest';
import { CONFIG_KEYS, isSensitiveConfig, SENSITIVE_CONFIG_KEYS } from '../keys';

describe('CONFIG_KEYS', () => {
  it('has all domain keys', () => {
    expect(CONFIG_KEYS.LLM_PROVIDER).toBe('llm.provider');
    expect(CONFIG_KEYS.TTS_PROVIDER).toBe('tts.provider');
    expect(CONFIG_KEYS.EXPORT_OUTPUT_DIR).toBe('export.outputDir');
    expect(CONFIG_KEYS.UI_LANGUAGE).toBe('ui.language');
    expect(CONFIG_KEYS.UI_THEME).toBe('ui.theme');
  });

  it('has no duplicate values', () => {
    const v = Object.values(CONFIG_KEYS);
    expect(new Set(v).size).toBe(v.length);
  });

  it('includes all required domains', () => {
    const values = Object.values(CONFIG_KEYS);
    expect(values.some(v => v.startsWith('llm.'))).toBe(true);
    expect(values.some(v => v.startsWith('tts.'))).toBe(true);
    expect(values.some(v => v.startsWith('export.'))).toBe(true);
    expect(values.some(v => v.startsWith('pipeline.'))).toBe(true);
    expect(values.some(v => v.startsWith('storage.'))).toBe(true);
    expect(values.some(v => v.startsWith('voice.'))).toBe(true);
    expect(values.some(v => v.startsWith('ui.'))).toBe(true);
    expect(values.some(v => v.startsWith('feature.'))).toBe(true);
  });
});

describe('SENSITIVE_CONFIG_KEYS', () => {
  it('includes API key', () => {
    expect(SENSITIVE_CONFIG_KEYS).toContain(CONFIG_KEYS.LLM_DEEPSEEK_API_KEY);
  });
});

describe('isSensitiveConfig', () => {
  it('returns true for API key', () => {
    expect(isSensitiveConfig(CONFIG_KEYS.LLM_DEEPSEEK_API_KEY)).toBe(true);
  });

  it('returns false for non-sensitive keys', () => {
    expect(isSensitiveConfig(CONFIG_KEYS.UI_THEME)).toBe(false);
    expect(isSensitiveConfig(CONFIG_KEYS.EXPORT_OUTPUT_DIR)).toBe(false);
  });

  it('returns false for unknown keys', () => {
    expect(isSensitiveConfig('unknown.key')).toBe(false);
  });
});
