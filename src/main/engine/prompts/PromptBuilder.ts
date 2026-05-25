// 📁 路径：src/main/engine/prompts/PromptBuilder.ts
import { PERSONAS } from './personas'
import { CONSTRAINTS } from './constraints'

/**
 * 👑 统一提示词装配中枢 (Prompt Hub)
 * 拒绝过度设计，只负责将业务对象转化为大模型可读的指令。
 */
export class PromptBuilder {
  public static buildScriptPrompt(targetLanguage: string = 'zh-CN'): string {
    return `${PERSONAS.SCREENWRITER}\n【巴别塔协议】：使用 [${targetLanguage}]\n${CONSTRAINTS.NO_MERGE_SENTENCES}\n${CONSTRAINTS.JSON_ONLY}`.trim()
  }

  // 💥 修改：增加 agentData 入参，内部完成字符串拼装
  static buildAgentPrompt(context: any, agentData?: { medias: any[]; shots: any[] }): string {
    // 💥 执宪点：统一处理 Windows 路径转义，不再让 Engine 操心
    const safeContext = JSON.stringify(context || {}).replace(/\\/g, '/')

    // 💥 核心重构：注入“顾问式”交互法则，禁止自作聪明！
    let prompt = `
你叫 Zentect Agent，是本视频剪辑软件的首席智能助手。
当前工程上下文状态：
${safeContext}

【核心工作流】
1. 理解用户的自然语言意图。
2. 只要用户的意图可以通过调用下方的 Tools（函数工具）来实现，你就必须调用对应的工具。
3. 你的回复不仅要包含工具的 JSON 动作，还必须包含一段友好、专业的文本回复给用户。

【💥 最高交互宪法：禁止独裁与信息隐瞒】
当用户要求执行一个拥有多个策略或选项的动作时（例如“视频抽帧”、“导出格式”等），如果用户在要求时没有明确指定具体用哪种策略：
1. 你**绝对不能**在文本回复中保持沉默并私自决定。
2. 你必须生成工具调用（可以选一个最合理的作为默认值填入 JSON），但你**必须在文本回复中明确告诉用户所有的可用选项**！
3. 话术规范示例："我已经为您调出了抽帧操作面板。我们目前支持三种策略：**1. 极速关键帧**（适合长视频）、**2. 均匀采样**（按场景切换）、**3. 固定帧率**。我已经在下方卡片中为您默认选择了 xxx，您可以根据需要直接在卡片上切换策略，确认无误后点击执行即可。"

记住：你是一个专业的顾问，永远要让用户拥有"知情权"和"最终决定权"。
`.trim()

    // 🌟 无缝织入数据库时序特征 (God's Eye)
    if (agentData) {
      if (agentData.medias && agentData.medias.length > 0) {
        prompt += `

【系统级媒体资产约束】：
如果你需要调用工具处理视频，只能且必须使用以下列表中的物理 mediaId:
`
        prompt +=
          agentData.medias.map((m) => `- 视频: "${m.name}" => mediaId: "${m.id}"`).join('\n') + '\n'
      }

      if (agentData.shots && agentData.shots.length > 0) {
        const flowLines = agentData.shots
          .map((s) => {
            // 💥 直接使用标准属性，无需任何容错和猜测
            const time = `[${s.start}s - ${s.end}s]`
            const action = s.visionText ? `🎬动作: ${s.visionText}` : ''
            const line = s.text ? `💬台词: "${s.text}"` : ''
            return `${time} ${action} ${line}`.trim()
          })
          .filter((line) => line.length > 0)

        if (flowLines.length > 0) {
          prompt +=
            `
【当前工程全息时间轴 (Semantic Flow)】:\n` +
            flowLines.join('\n') +
            '\n'
        }
      }
    }

    return prompt
  }

  // 消灭原来那个 import types，改用通用的简单传参
  public static formatBrollQuery(userQuery: string): string {
    return `用户正在寻找以下画面：${userQuery}。请分析其视觉特征并执行搜索。`
  }

  /**
   * 视觉分析 — 构造 VLM 识图 System Prompt
   * 要求模型对图片进行语义级理解，输出结构化描述
   */
  public static buildVisionPrompt(): string {
    return `你是一名专业的影视视觉分析师。
请仔细观察图片内容，从以下维度进行结构化描述：

1. **主体识别**：画面中有哪些主要人物/物体？他们的位置关系是怎样的？
2. **动作与姿态**：人物正在做什么？面部表情和肢体语言如何？
3. **场景与环境**：拍摄地点是什么类型的空间？光线条件和色调如何？
4. **构图分析**：镜头角度（俯拍/仰拍/平视）、景别（特写/中景/全景）是怎样的？
5. **视觉风格**：画面传递了什么样的情绪或氛围？

请用中文输出分析结果，语言简洁专业。`.trim()
  }
}
