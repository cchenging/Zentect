// 📁 路径：src/main/core/NetworkPipeline.ts
// Layer 4: 大模型脏数据清洗管道 — 过滤 LLM 输出中的冗余标记，智能提取 JSON
export class NetworkPipeline {
  /**
   * 物理过滤大模型产生的冗余废话标记，智能捕获并剥离干净的 JSON 段
   * @param dirtyText 大模型原始输出（可能包含 ```json 标签、前后废话等）
   * @returns 清洗后的纯 JSON 字符串
   */
  public static sanitizeJson(dirtyText: string): string {
    if (!dirtyText || typeof dirtyText !== 'string') return dirtyText;

    // 剥离 Markdown 代码块标记
    let clean = dirtyText.replace(/```json/gi, '').replace(/```/g, '').trim();

    // 智能截取首个目标符到最后一个目标符
    const startArr = clean.indexOf('[');
    const startObj = clean.indexOf('{');
    const startIdx =
      startArr !== -1 && startObj !== -1
        ? Math.min(startArr, startObj)
        : Math.max(startArr, startObj);

    const endArr = clean.lastIndexOf(']');
    const endObj = clean.lastIndexOf('}');
    const endIdx = Math.max(endArr, endObj);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      return clean.substring(startIdx, endIdx + 1);
    }

    return clean;
  }

  /**
   * 安全解析 JSON — 先清洗再解析，解析失败返回 null 而非抛异常
   * @param dirtyText 大模型原始输出
   * @returns 解析后的对象，失败返回 null
   */
  public static safeParseJson<T = any>(dirtyText: string): T | null {
    try {
      const cleanJson = this.sanitizeJson(dirtyText);
      return JSON.parse(cleanJson) as T;
    } catch {
      return null;
    }
  }

  /**
   * 强制解析 JSON — 先清洗再解析，解析失败抛出标准 AppError
   * @param dirtyText 大模型原始输出
   * @returns 解析后的对象
   */
  public static strictParseJson<T = any>(dirtyText: string): T {
    const cleanJson = this.sanitizeJson(dirtyText);
    try {
      return JSON.parse(cleanJson) as T;
    } catch (parseError: any) {
      // 抛出标准错误，由 ExceptionHub 捕获归一化
      const error = new Error(`LLM JSON contract damaged: ${parseError.message}`);
      (error as any).isContractError = true;
      throw error;
    }
  }
}
