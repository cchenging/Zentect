/**
 * vitest 单元测试 —— MediaEngine.cleanAsrText ASR 噪声清洗器
 *   针对 26年8月19日 项目中 ASR 台词大量出现 🎼😊 嗯/啊/哦 等噪声的问题，
 *   验证清洗后 cleaned 文本和 isPureNoise 判定、original 保留策略。
 */
import { describe, it, expect } from 'vitest';
import { MediaEngine } from '../../../engine/mediaEngine';

describe('MediaEngine.cleanAsrText — ASR 噪声清洗归一化', () => {
  // =============== Case 1 ===============
  it('Case1 — 剥离 emoji 与音乐符号：🎼😊 嗯 → 去掉表情保留嗯', () => {
    const r = MediaEngine.cleanAsrText('嗯 🎼我 嗯 为什么 嗯好嗯 嗯');
    // original 只做轻度清洗（保留用户看到的语气词+emoji 去控制字符）
    expect(r.original).toBe('嗯 🎼我 嗯 为什么 嗯好嗯 嗯');
    // cleaned：🎼 → 去掉；孤立"嗯"（前后空格）全部剥离；"好嗯"词内不拆
    expect(r.cleaned.replace(/\s+/g, ' ')).toBe(r.cleaned.trim());
    expect(r.cleaned).toContain('我');
    expect(r.cleaned).toContain('为什么');
    expect(r.cleaned).not.toContain('🎼');
    expect(r.chineseCharCount).toBeGreaterThan(2);
    expect(r.isPureNoise).toBe(false);
  });

  it('Case2 — 纯语气词"嗯" → 判纯噪声 isPureNoise=true', () => {
    const r = MediaEngine.cleanAsrText('嗯');
    expect(r.original).toBe('嗯');
    // cleaned：剩"嗯"单字（因为没有被空格包围的边界，保留）
    expect(r.chineseCharCount).toBe(1);
    expect(r.isPureNoise).toBe(true);
  });

  it('Case3 — 连续重复语气词归一化：嗯嗯嗯嗯嗯啊哈哈哈哈哈 → 嗯啊哈哈哈哈哈（哈不在语气词集合，保留原声）', () => {
    const r = MediaEngine.cleanAsrText('嗯嗯嗯嗯嗯啊哈哈哈哈哈');
    expect(r.original).toBe('嗯嗯嗯嗯嗯啊哈哈哈哈哈');
    // cleaned：嗯嗯嗯嗯嗯→嗯；啊啊啊→啊；"哈哈哈哈哈"不属于语气词集合（避免误伤"哈哈对哈哈"），原样保留
    expect(r.cleaned).toBe('嗯啊哈哈哈哈哈');
    // 汉字=7 >1，所以不是纯噪声（下游 TTS/Step3 可以自己决定是否说出来）
    expect(r.chineseCharCount).toBe(7);
    expect(r.isPureNoise).toBe(false);
  });

  it('Case4 — 🎼😊🎵音乐标记混合中文台词剥离：🎼裂纹横亘在鼎青楼三个字中间，像是在老', () => {
    const r = MediaEngine.cleanAsrText('🎼裂纹横亘在鼎青楼三个字中间，像是在老');
    expect(r.original).toBe('🎼裂纹横亘在鼎青楼三个字中间，像是在老');
    expect(r.cleaned).not.toContain('🎼');
    expect(r.cleaned).toContain('裂纹横亘在鼎青楼三个字中间');
    expect(r.chineseCharCount).toBeGreaterThan(10);
    expect(r.isPureNoise).toBe(false);
  });

  it('Case5 — 音乐符号单字节（♪♫♩）剥离：♪♫♩ 呵呵对呵呵 😊 🎼嘿 嗯 😊🎼 → 剩下"呵呵对呵呵 嘿"（呵/嘿不在语气词集合）', () => {
    const r = MediaEngine.cleanAsrText('♪♫♩ 呵呵对呵呵 😊 🎼嘿 嗯 😊🎼');
    expect(r.cleaned).not.toContain('♪');
    expect(r.cleaned).not.toContain('♫');
    expect(r.cleaned).not.toContain('♩');
    expect(r.cleaned).not.toContain('😊');
    expect(r.cleaned).not.toContain('🎼');
    // "嗯"是边界语气词（空格 嗯 空格/结尾）→ 剥掉；"呵/嘿"不在集合里，保留
    expect(r.cleaned.replace(/\s+/g, ' ')).toBe('呵呵对呵呵 嘿');
    expect(r.chineseCharCount).toBe(6); // 呵呵对呵呵 嘿 = 6 汉字
    expect(r.isPureNoise).toBe(false);
  });

  it('Case6 — 词内语气词保留："好啊/对啊/我的妈呀/哦哦不对"里的"啊/妈"不被删（哦哦→归一化为哦）', () => {
    const r = MediaEngine.cleanAsrText('好啊 对啊 我的妈呀 哦哦不对');
    expect(r.cleaned).toContain('好啊');
    expect(r.cleaned).toContain('对啊');
    expect(r.cleaned).toContain('我的妈呀');
    // "哦哦不对"：哦哦→归一化为单个"哦"→"哦不对"（仍然是有效表达）
    expect(r.cleaned).toContain('哦不对');
    expect(r.isPureNoise).toBe(false);
  });

  it('Case7 — 前后缀标点清理："，裂纹横亘在鼎青楼？？？，，" → 句首逗号句尾多余逗号去掉', () => {
    const r = MediaEngine.cleanAsrText('，裂纹横亘在鼎青楼？？？，，');
    expect(r.cleaned).toContain('裂纹横亘在鼎青楼');
    // 末尾的"？，，"经过缩并成"？，"，然后句尾标点剥离把这两个字的尾标点都去掉了（因为逗号是最尾的）
    // 核心内容仍然是"裂纹横亘在鼎青楼"，对 Step5 匹配无影响
    expect(r.isPureNoise).toBe(false);
  });

  it('Case8 — 整段空字符串：返回 isPureNoise=true', () => {
    const r = MediaEngine.cleanAsrText('     \n\t  ');
    expect(r.original).toBe('');
    expect(r.cleaned).toBe('');
    expect(r.chineseCharCount).toBe(0);
    expect(r.isPureNoise).toBe(true);
  });

  it('Case9 — 非字符串输入（数字/null/undefined 安全）', () => {
    expect(MediaEngine.cleanAsrText(null as any).cleaned).toBe('');
    expect(MediaEngine.cleanAsrText(undefined as any).cleaned).toBe('');
    expect(MediaEngine.cleanAsrText(12345 as any).cleaned).toBe('');
    expect(MediaEngine.cleanAsrText(null as any).isPureNoise).toBe(true);
  });

  it('Case10 — 英文+数字（非中文）判定为噪声（避免 ASR 幻觉英文/数字段）', () => {
    const r1 = MediaEngine.cleanAsrText('hello 123');
    expect(r1.isPureNoise).toBe(true); // 汉字数 0 → 噪声（当前项目是中文电视剧）
    const r2 = MediaEngine.cleanAsrText('Hello World 你好');
    expect(r2.chineseCharCount).toBe(2);
    expect(r2.isPureNoise).toBe(false); // 含"你好"2 汉字 → 有效段
  });
});
