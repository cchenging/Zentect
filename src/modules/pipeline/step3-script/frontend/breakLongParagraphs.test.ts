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

  it("超框含逗号 → 按逗号断，每条 ≤24", () => {
    expect(texts("今天天气真的很好，所以我们一起去公园散步，然后又回家吃饭了")).toEqual([
      "今天天气真的很好，",
      "所以我们一起去公园散步，",
      "然后又回家吃饭了",
    ]);
  });

  it("25 字无标点超框 → 硬按 24 字截断（24+1）", () => {
    expect(texts("一".repeat(25))).toEqual(["一".repeat(24), "一".repeat(1)]);
  });

  it("含句号级标点的长句 → 先按句号断", () => {
    expect(texts("第一句话特别长而且没有逗号。第二句话很短。")).toEqual([
      "第一句话特别长而且没有逗号。",
      "第二句话很短。",
    ]);
  });

  it("52 字无标点 → 硬切为 24+24+4", () => {
    expect(texts("一".repeat(52))).toEqual(["一".repeat(24), "一".repeat(24), "一".repeat(4)]);
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