// 📁 路径: src/main/engine/strategies/__tests__/LocalWhisperStrategy.test.ts
// 🎯 GAP 1: ASR 引擎自动路由 + 噪声过滤 单元测试
// 重点验证:
//   1. resolveEngineByLang — 根据归一化语言代码自动路由 senseVoice / faster-whisper / auto
//   2. cleanText — 过滤 [MUSIC]/[blank]/[SOUND] 方括号噪声, (笑声)/(掌声)/(呼吸)/圆括号噪声, 保留台词括号内容
//   3. 多空白压缩: 多个噪声标记移除后残留连续空白, 必须压成单空格 + trim()

import { describe, it, expect } from 'vitest';
import { LocalWhisperStrategy } from '../LocalWhisperStrategy';

// ⚠️ 访问私有静态工具函数 (TypeScript 测试环境绕过 private 限制 — 纯函数测试友好)
const AnyStrategy = LocalWhisperStrategy as any;

// ============================================================
// GAP-1a: engine='auto' 自动路由 — 6 条用例
// 规则: 中日韩粤(zh/ja/ko/yue) → senseVoice, 其它明确语言 → faster-whisper, auto → auto (传 Python 端预检测)
// ============================================================
describe('LocalWhisperStrategy.resolveEngineByLang — GAP-1a ASR 引擎自动路由', () => {
  it('[GAP1A-1] language=zh (中文) → 应路由 sensevoice', () => {
    expect(AnyStrategy.resolveEngineByLang('zh')).toBe('sensevoice');
  });

  it('[GAP1A-2] language=ja (日文) → 应路由 sensevoice', () => {
    expect(AnyStrategy.resolveEngineByLang('ja')).toBe('sensevoice');
  });

  it('[GAP1A-3] language=ko (韩文) → 应路由 sensevoice', () => {
    expect(AnyStrategy.resolveEngineByLang('ko')).toBe('sensevoice');
  });

  it('[GAP1A-4] language=yue (粤语) → 应路由 sensevoice', () => {
    expect(AnyStrategy.resolveEngineByLang('yue')).toBe('sensevoice');
  });

  it('[GAP1A-5] language=en (英文) → 应路由 faster-whisper', () => {
    expect(AnyStrategy.resolveEngineByLang('en')).toBe('faster-whisper');
  });

  it('[GAP1A-6] language=auto (未识别需预检测) → 保留 auto 传 Python 端', () => {
    expect(AnyStrategy.resolveEngineByLang('auto')).toBe('auto');
  });
});

// ============================================================
// GAP-1b: cleanText 噪声过滤 — 6 条用例
// 规则: 仅删除白名单内明确的 ASR 噪声标记, 绝对不碰台词括号内容 (例如 "张三(30岁)" 必须完整保留)
// ============================================================
describe('LocalWhisperStrategy.cleanText — GAP-1b 噪声标记过滤', () => {
  it('[GAP1B-1] [MUSIC] 方括号英文噪声标记 → 完全移除', () => {
    expect(AnyStrategy.cleanText('[MUSIC]')).toBe('');
  });

  it('[GAP1B-2] [blank] 方括号英文噪声标记 → 完全移除', () => {
    expect(AnyStrategy.cleanText('[blank]')).toBe('');
  });

  it('[GAP1B-3] (笑声) 圆括号中文噪声标记 → 完全移除', () => {
    expect(AnyStrategy.cleanText('(笑声)')).toBe('');
  });

  it('[GAP1B-4] (掌声) 圆括号中文噪声标记 → 完全移除', () => {
    expect(AnyStrategy.cleanText('(掌声)')).toBe('');
  });

  it('[GAP1B-5] [SOUND] (呼吸) 多噪声标记 + 正常台词 → 噪声移除, 台词保留, 连续空白压成单空格', () => {
    expect(AnyStrategy.cleanText('[SOUND] (呼吸) 你好，我是张三')).toBe('你好，我是张三');
  });

  it('[GAP1B-6] <|zh|> Whisper 特殊 token + [MUSIC] + (咳嗽) 复合噪声 → 全部移除', () => {
    expect(AnyStrategy.cleanText('<|zh|> 正常台词 [MUSIC] (咳嗽)')).toBe('正常台词');
  });
});
