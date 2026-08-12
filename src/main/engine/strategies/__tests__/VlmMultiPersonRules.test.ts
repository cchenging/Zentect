// 📁 路径: src/main/engine/strategies/__tests__/VlmMultiPersonRules.test.ts
// 🎯 GAP 3: VLM Prompt 多人物强规则 + downstream 空占位词规范化（错就错不兜底 '无' / 'none' → undefined）
//
// 规则（用户明确规定，唯一真源）:
//   ① 禁止罗列人物外观特征：不准写"穿黑西装的男子""戴眼镜的女士"等并列描述
//   ② 强制输出"谁对谁做了什么"的 A-Verb-B 交互动作，不准"左边A右边B"的并列
//   ③ 交互描述控制在 15 字以内（短句，避免废话）
//
// downstream 规范化核心准则（错就错不兜底）:
//   - VLM 可能违反 prompt 输出"无" / "none" / "无动作" / "无交互" 等占位词
//   - 遇到以下任一情况 → 强制转 undefined（传空比传假值更安全，Step3 不会误判）：
//       • primarySubject/interaction/dramaticConflict/subject/... 字符串是空占位词
//       • secondarySubjects/characters 是空数组 []（Step3 空数组解析为"有"的假值）
//   - 正常有意义姓名/动作 → 原样透传（不做修正）

import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../../prompts/PromptBuilder';
import { VisionExtractStrategy } from '../VisionExtractStrategy';

describe('GAP3-A: PromptBuilder.buildVisionPrompt 多人物强规则 3 子点存在性', () => {
  const systemPrompt = PromptBuilder.buildVisionPrompt();

  it('[GAP3A-1] 规则①：必须包含"禁止罗列人物外观穿着/特征"表述（不准"穿黑西装男子/戴眼镜女士"）', () => {
    // 关键关键词：罗列 / 穿着 / 外观 / 黑西装 / 戴眼镜 / 男子 / 女士
    // 任意命中 3 个关键词组合，且提示是"禁止/严禁"语气
    expect(systemPrompt).toMatch(/(禁止|严禁|不准|不得)[^；。\n]{0,30}(罗列|外观|穿着|服饰|服装|特征)/i);
  });

  it('[GAP3A-2] 规则②：强制 A-Verb-B 结构 — 必须包含"谁对谁做了什么"或"交互动作"表述', () => {
    expect(systemPrompt).toMatch(/(谁对谁做了什么|A-Verb-B|交互动作|对\s*.*做|向\s*.*(走|打|问|递|说|举|推|拉|抱))/i);
  });

  it('[GAP3A-3] 规则③：交互字数上限 — 必须包含"15 字以内"或"15字以内"硬约束', () => {
    expect(systemPrompt).toMatch(/15\s*字\s*以\s*内|≤\s*15\s*字|max\s*15\s*char/i);
  });
});

describe('GAP3-B: VisionExtractStrategy.normalizeDownstreamFields — 占位词 → undefined 规范化（错就错不兜底）', () => {
  const AnyVES = VisionExtractStrategy as any;

  it('[GAP3B-1] 正常透传：有意义姓名/动作/数组 → 原样保留，不被误判', () => {
    const out = AnyVES.normalizeDownstreamFields({
      primarySubject: '张三',
      interaction: '张三举枪质问李四',
      secondarySubjects: ['李四'],
      characters: ['张三', '李四'],
      subject: '张三',
      dramaticConflict: '对峙升级',
      shotStyle: '双人对峙',
      narrativeAction: '张三举枪',
      emotionalState: '愤怒紧绷',
      scene: '废弃仓库',
      keywords: ['举枪', '对峙'],
      shotType: '中景',
      cameraMovement: '固定',
      visualAtmosphere: '昏暗压抑',
      spatialRelation: '张三居左前景，李四居右后',
    }, '张三：你别过来！');

    expect(out.primarySubject).toBe('张三');
    expect(out.interaction).toBe('张三举枪质问李四');
    expect(out.secondarySubjects).toEqual(['李四']);
    expect(out.characters).toEqual(['张三', '李四']);
    expect(out.asrText).toBe('张三：你别过来！');
  });

  it('[GAP3B-2] 中文占位词（"无"/"无动作"/"无交互"/"无人物"/"无人"）→ 字符串字段强制 undefined', () => {
    const out = AnyVES.normalizeDownstreamFields({
      primarySubject: '无',
      interaction: '无交互',
      subject: '无人物',
      dramaticConflict: '无冲突',
      shotStyle: '无',
    }, '');

    expect(out.primarySubject).toBeUndefined();
    expect(out.interaction).toBeUndefined();
    expect(out.subject).toBeUndefined();
    expect(out.dramaticConflict).toBeUndefined();
    expect(out.shotStyle).toBeUndefined();
    // 空字符串 asrText → undefined（Step3 消费时 "空" 等同于"无"，遵循错就错不传假值）
    expect(out.asrText).toBeUndefined();
  });

  it('[GAP3B-3] 英文占位词（"none"/"None"/"NONE"/"null"/"Null"/"empty"/"undefined"）→ 强制 undefined', () => {
    const out = AnyVES.normalizeDownstreamFields({
      primarySubject: 'NONE',
      interaction: 'No interaction',
      subject: 'null',
      dramaticConflict: 'EMPTY',
      scene: 'none',
      narrativeAction: 'Null',
    }, '');

    expect(out.primarySubject).toBeUndefined();
    expect(out.interaction).toBeUndefined(); // "No interaction" 视为占位 → undefined
    expect(out.subject).toBeUndefined();
    expect(out.dramaticConflict).toBeUndefined();
    expect(out.scene).toBeUndefined();
    expect(out.narrativeAction).toBeUndefined();
  });

  it('[GAP3B-4] 空数组 secondarySubjects / characters → 强制 undefined（Step3 解析时 [] 会被当作"有内容"的假值）', () => {
    // ⚠️ 类型定义说明：action: string / emotion: string / keywords: string[] 是必选字段（无 ?），
    //    因此 keywords 空数组保持 [] 是正确的（非 undefined）；仅 secondarySubjects? / characters? 这类
    //    可选数组字段，空数组 → undefined（避免 Step3 把 [] 解析为"有陪体/有角色"）
    const out = AnyVES.normalizeDownstreamFields({
      secondarySubjects: [],
      characters: [],
      keywords: [],
    }, '');

    expect(out.secondarySubjects).toBeUndefined();
    expect(out.characters).toBeUndefined();
    expect(Array.isArray(out.keywords)).toBe(true); // keywords 必选，空数组保持
    expect(out.keywords!.length).toBe(0);
  });
});
