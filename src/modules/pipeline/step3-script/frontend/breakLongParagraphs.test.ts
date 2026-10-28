// 断句算法单测：验证 breakLongParagraphs 符合字幕安全框行规
// 约定：横屏中文每行最多 24 字（安全框容量）；安全框内整句保留，超框才断，断点优先标点。
import { describe, expect, it } from "vitest";
import { breakLongParagraphs } from "./breakLongParagraphs";

/** 便捷：只取切分后的文本列表 */
function texts(input: string, duration = 6): string[] {
  return breakLongParagraphs([{ id: "p1", text: input, duration }]).map((o) => o.text);
}

describe("breakLongParagraphs 字幕安全框断句", () => {
  it("安全框内带逗号短句 → 整句保留，不拆", () => {
    expect(texts("老舅的货，价廉优")).toEqual(["老舅的货，价廉优"]);
  });

  it("≤24 字含逗号 → 未超框，整句保留", () => {
    expect(texts("今天天气很好，我们去公园散步吧")).toEqual([
      "今天天气很好，我们去公园散步吧",
    ]);
  });

  it("超框含逗号 → 按逗号断，每条 ≤24，断点标点保留在碎片末尾（供步骤4 TTS 韵律）", () => {
    expect(texts("今天天气真的很好，所以我们一起去公园散步，然后又回家吃饭了")).toEqual([
      "今天天气真的很好，所以我们一起去公园散步，",
      "然后又回家吃饭了",
    ]);
  });

  it("仅超框 1~2 字 → 贪心装箱，不拆成一串短碎片（回归：seg_46 25 字被切成 5/9/5/6）", () => {
    expect(texts("同一句话，被人翻来覆去地念，像在提醒，又像在试探。")).toEqual([
      "同一句话，被人翻来覆去地念，",
      "像在提醒，又像在试探。",
    ]);
  });

  it("破折号「——」作单一断点，且不留纯标点残片（回归：seg_1 被打磨改写成 34 字）", () => {
    expect(
      texts("他当众深情告白，同一张照片里却挨着另一个女人——她还以为那是误会。"),
    ).toEqual([
      "他当众深情告白，同一张照片里却挨着另一个女人——",
      "她还以为那是误会。",
    ]);
  });

  it("无标点超长句：硬切给延续逗号预留 1 字，尾片不出现 1~2 字残片", () => {
    const input = "字幕安全框的字数上限是二十四个字这里故意写超一点啊";
    expect(input.length).toBe(25);
    const out = texts(input);
    expect(out).toEqual([
      "字幕安全框的字数上限是二十四个字这，",
      "里故意写超一点啊",
    ]);
    out.forEach((t) => expect(t.length).toBeLessThanOrEqual(24));
  });

  it("顿号/逗号级断点标点原样保留（回归：银行抽奖、）", () => {
    expect(
      texts("韩智恩被告知中了银行头奖、头等舱、免费酒店，天底下哪有这么好的事？"),
    ).toEqual([
      "韩智恩被告知中了银行头奖、头等舱、免费酒店，",
      "天底下哪有这么好的事？",
    ]);
  });

  it("25 字无标点超框 → 硬切并回补尾片，每片 ≤24（首片补延续逗号）", () => {
    // 23+2 会留下 2 字残片 ⇒ 从前片匀 6 字给尾片：17(+，)/8
    expect(texts("一".repeat(25))).toEqual(["一".repeat(17) + "，", "一".repeat(8)]);
  });

  it("含句号级标点的长句 → 先按句号断", () => {
    expect(texts("第一句话特别长而且没有逗号。第二句话很短。")).toEqual([
      "第一句话特别长而且没有逗号。",
      "第二句话很短。",
    ]);
  });

  it("52 字无标点 → 硬切为 24+22+8，前两片补延续逗号、末片保留原文", () => {
    // 23+23+6 会留下 6 字残片 ⇒ 匀 2 字给尾片：23(+，)/21(+，)/8
    expect(texts("一".repeat(52))).toEqual([
      "一".repeat(23) + "，",
      "一".repeat(21) + "，",
      "一".repeat(8),
    ]);
  });

  it("子句时长不低于 1.2 秒", () => {
    const out = breakLongParagraphs([{ id: "p1", text: "今天天气很好，我们去公园散步，然后回家吃饭", duration: 3 }]);
    out.forEach((sub) => expect(sub.duration).toBeGreaterThanOrEqual(1.2));
  });

  it("子句继承父段落角色名单", () => {
    const out = breakLongParagraphs([
      { id: "p1", text: "今天天气很好，我们去公园散步，然后回家吃饭", characters: ["老王", "老李"] },
    ]);
    out.forEach((sub) => expect(sub.characters).toEqual(["老王", "老李"]));
  });
});