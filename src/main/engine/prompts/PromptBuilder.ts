// 📁 路径：src/main/engine/prompts/PromptBuilder.ts
import { PERSONAS } from './personas'
import { CONSTRAINTS } from './constraints'

/**
 * 👑 统一提示词装配中枢 (Prompt Hub)
 * 拒绝过度设计，只负责将业务对象转化为大模型可读的指令。
 */
export class PromptBuilder {
  /**
   * 构建脚本生成 System Prompt
   * @param targetLanguage 目标语言代码（默认 zh-CN）
   * @param roles 可选，人物角色列表，注入后 LLM 生成解说词时使用统一人物名称
   */
  public static buildScriptPrompt(
    targetLanguage: string = 'zh-CN',
    roles?: Array<{ id: string; name: string; representative?: any }>,
  ): string {
    let prompt = `${PERSONAS.SCREENWRITER}\n【巴别塔协议】：使用 [${targetLanguage}]\n${CONSTRAINTS.NO_MERGE_SENTENCES}\n${CONSTRAINTS.JSON_ONLY}`;
    // 🎭 注入人物名单约束：让 LLM 生成解说词时使用统一人物名称
    if (roles && roles.length > 0) {
      const roleLines = roles
        .filter(r => r && r.name)
        .map(r => `- ${r.name}`);
      if (roleLines.length > 0) {
        prompt += `\n\n【人物命名约束】：画面中可能出现以下人物，解说词中请优先使用其名称，严禁使用"男子/女子/青年/中年人"等模糊代称：\n${roleLines.join('\n')}`;
      }
    }
    return prompt.trim();
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
   * 视觉分析 — 构造 VLM 识图 System Prompt（剪辑师视角）
   * 重构：从"图像描述算法"转为"顶级影视剪辑师"，聚焦戏剧动作与微表情
   * 严禁描述背景颜色/家具材质/墙壁/衣服样式等静态杂物，避免分散下游 LLM 注意力
   */
  public static buildVisionPrompt(): string {
    return `# Role: 顶级影视剪辑师 & 视觉动作分析师

## Task
分析传入的视频关键帧，提取【对影视解说最关键的关键场景、戏剧动作与人物微表情】。输出必须具体、可匹配画面。

## ⚡ 剪辑师提取准则 (Strict Rules)
1. **场景优先（画面匹配第一抓手）**：必须用 2-6 字概括关键场景/环境（如"深夜办公室""车内""雨夜街头""海边"）。只禁止与剧情无关的杂物细节（家具材质、墙壁花纹、衣服款式），场景类型必须写！
2. **聚焦关键动作 (Key Action)**：关注主体人物的手部动作、身体姿态转折、道具交互（如：拔枪/按住水杯/猛地抬头）。
3. **识别微表情 (Micro-Emotion)**：关注眼神变化、咬牙、冷笑、脸色阴沉等内心戏表现。
4. **识别镜头语言 (Shot Type)**：判断是【特写】、【近景】、【中景】还是【全景】。
5. **氛围与光影**：仅用 2-4 字概括整体氛围（如"昏暗压抑"、"高对比冷调"）。
6. **🔴 严禁占位词（最高优先级）**：禁止输出"无动作/无构图/无氛围/无表情/无/未知"等空泛占位！
   - 静态镜头写具体状态："无动作" → "人物静坐桌边"；"无构图" → "主体居中对称"；"无氛围" → "氛围平静"；"无表情" → "面无表情，眼神空洞"
   - 每个字段都必须写出肉眼可见的具体内容，不许用"无"搪塞`.trim();
  }
  /**
   * Build vision extract prompt for VLM frame analysis
   * Returns system + user prompts with ASR context and frame window info
   * @param asrText 该批次对应的 ASR 台词
   * @param _unused 历史遗留占位参数
   * @param strategy 分析策略标识
   * @param frameWindow 帧窗口信息
   * @param roles step1 识别出的人物角色列表，注入后 VLM 描述时直接使用名称
   */
  public static buildVisionExtractPrompt(
    asrText: string,
    _unused: string,
    strategy: string,
    frameWindow?: unknown[],
    roles?: Array<{ id: string; name: string; avatar?: string; representative?: any; faces?: any[] }>,
  ): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = PromptBuilder.buildVisionPrompt();

    const parts: string[] = [];
    if (asrText) {
      parts.push(`【该时间段原声台词上下文】\n"${asrText}"\n（台词仅供参考剧情走向，描述时严禁复述台词原文，只描述画面可见的戏剧动作）`);
    }
    // 🎭 注入人物名单：让 VLM 知道画面中可能出现的人物名称
    // 仅注入有 name 的角色（用户已命名或自动命名为"角色_X"的都算）
    // VLM 在描述时可直接用"张三走入画面"代替"男子走入画面"，提升解说可读性
    // 🔧 修复：自动命名的"角色_N"（步骤1 聚类默认名）不注入——"角色_2开车"机械出戏，
    // 让 VLM 用"男子/女子"泛称；用户手动命名后自动生效
    const isAutoNamed = (n: string) => /^角色_\d+$/.test(n || '');
    if (roles && roles.length > 0) {
      const roleLines = roles
        .filter(r => r && r.name && !isAutoNamed(r.name))
        .map(r => {
          // 附加性别/年龄信息（若有），帮助 VLM 更准确匹配画面中的人物
          const rep = r.representative || {};
          const attrs: string[] = [];
          if (rep.gender !== undefined) attrs.push(rep.gender === 1 || rep.gender === 'M' ? '男' : '女');
          if (rep.age) attrs.push(`${rep.age}岁`);
          const attrStr = attrs.length > 0 ? `（${attrs.join('，')}）` : '';
          return `- ${r.name}${attrStr}`;
        });
      if (roleLines.length > 0) {
        parts.push(`【已知人物角色】\n画面中可能出现以下人物，描述时请优先使用其名称：\n${roleLines.join('\n')}`);
      }
    }
    if (frameWindow && frameWindow.length > 0) {
      parts.push(`【帧序列信息】\n共 ${frameWindow.length} 帧，请逐帧分析`);
    }
    if (strategy) {
      parts.push(`【分析策略】${strategy}`);
    }
    parts.push('请严格按剪辑师准则分析每张图片，输出 narrativeAction（核心动作）/ emotionalState（微表情）/ shotType（镜头语言，特写|近景|中景|全景）/ visualAtmosphere（氛围）/ spatialRelation（构图）/ keywords（关键词）。');

    const userPrompt = parts.join('\n\n');
    return { systemPrompt, userPrompt };
  }
}
