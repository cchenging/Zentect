import { ProviderManager } from '../config/ProviderManager'
import { PromptBuilder } from '../prompts/PromptBuilder'
import { LLMFactory } from '../adapters/LLMFactory'
import { AppLogger } from '../../core/AppLogger'
import { LOG_TAGS } from '../../../shared/utils/LogConstants'
import { AppError, ErrorCode } from '../../../shared/utils/AppError'
import fs from 'fs'

export class VisionAnalyzer {
  /**
   * 视觉分析 — 将图片交由 VLM 进行语义理解
   * @param imagePath 图片绝对路径
   * @returns 视觉分析结果文本
   */
  async analyze(imagePath: string): Promise<string> {
    const config = ProviderManager.getLLMConfig('visual')

    if (config.baseURL.includes('deepseek.com')) {
      throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, 'DeepSeek 暂不支持识图功能')
    }

    const cleanPath = imagePath.replace(/^file:\/{2,3}/, '')
    if (!fs.existsSync(cleanPath)) {
      throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, `找不到图片: ${cleanPath}`)
    }

    const base64Image = fs.readFileSync(cleanPath).toString('base64')
    const dataUrl = `data:image/jpeg;base64,${base64Image}`

    const systemPrompt = PromptBuilder.buildVisionPrompt()
    const adapter = LLMFactory.createFromConfig(config)

    const response = await adapter.chat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: systemPrompt },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      config.model,
      config.temperature
    )

    const result = response.success ? response.text || '' : '视觉分析失败'
    AppLogger.info(LOG_TAGS.AI_ENGINE, `[VisionAnalyzer] 分析完成 (${result.length} 字符)`)
    return result
  }
}
