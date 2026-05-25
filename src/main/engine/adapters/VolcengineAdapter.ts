// 📁 路径：src/main/engine/adapters/VolcengineAdapter.ts
import { OpenAICompatibleAdapter } from './OpenAICompatibleAdapter';

export class VolcengineAdapter extends OpenAICompatibleAdapter {
  public readonly providerName = 'volcengine';
  // 💥 极致复用：因为底层已经写好，火山引擎直接继承通用推流逻辑！
}
