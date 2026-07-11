// 📁 新建文件: src/main/services/PublishService.ts
// V1.2: 发布素材包生成 — 自动生成标题/封面/描述，导出到 publish 目录

import * as fs from 'fs';
import * as path from 'path';
import { PathManager } from '../utils/pathManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { ProviderManager } from '../engine/config/ProviderManager';
import { LLMFactory } from '../engine/adapters/LLMFactory';
import sharp from 'sharp';

/** 发布素材包请求 */
export interface PublishRequest {
  projectId: string;
  projectName: string;
  shots: PublishShot[];
  mediaPath: string;
  mp4Path?: string;
}

/** 单个镜头信息（用于生成描述） */
export interface PublishShot {
  id: string;
  label: string;
  script: string;
  startTime: number;
  endTime: number;
}

/** 发布素材包结果 */
export interface PublishResult {
  success: boolean;
  publishDir: string;
  title: string;
  description: string;
  coverPath: string;
  error?: string;
}

export class PublishService {
  /** 生成完整发布素材包 */
  async generatePackage(req: PublishRequest): Promise<PublishResult> {
    try {
      const publishDir = path.join(PathManager.getProjectExportDir(req.projectId), 'publish');
      if (!fs.existsSync(publishDir)) fs.mkdirSync(publishDir, { recursive: true });

      // 1. 生成标题（AI 调用 + 降级）
      const title = await this.generateTitle(req);
      AppLogger.info(LOG_TAGS.EXPORT, `[PublishService] 标题: ${title}`);

      // 2. 生成描述
      const description = await this.generateDescription(req);
      AppLogger.info(LOG_TAGS.EXPORT, `[PublishService] 描述: ${description.slice(0, 50)}...`);

      // 3. 生成封面
      const coverPath = await this.generateCover(req, publishDir);

      // 4. 写入发布信息文件
      const publishInfo = { title, description, cover: path.basename(coverPath), generatedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(publishDir, 'publish_info.json'), JSON.stringify(publishInfo, null, 2), 'utf-8');

      return { success: true, publishDir, title, description, coverPath };
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.EXPORT, '[PublishService] 素材包生成失败', err);
      return { success: false, publishDir: '', title: '', description: '', coverPath: '', error: err.message };
    }
  }

  /** AI 生成标题 — LLM 调用失败时降级为默认模板 */
  private async generateTitle(req: PublishRequest): Promise<string> {
    try {
      const shotsSummary = req.shots.slice(0, 5).map(s => s.script.slice(0, 30)).join(' | ');
      const prompt = `为以下视频内容生成一个吸引人的中文标题（15字以内，不要引号）：\n视频名称：${req.projectName}\n内容摘要：${shotsSummary}`;
      const config = ProviderManager.getLLMConfig('chat');
      const adapter = LLMFactory.createFromConfig(config);
      const messages = [{ role: 'system' as const, content: '你是一个专业的视频标题生成器。' }, { role: 'user' as const, content: prompt }];
      const result = await adapter.chat(messages, config.model, config.temperature);
      const clean = (result.text || '').replace(/["""]/g, '').trim();
      return clean.slice(0, 30) || req.projectName;
    } catch {
      AppLogger.warn(LOG_TAGS.EXPORT, '[PublishService] AI 标题生成失败，使用默认标题');
      return `【${req.projectName}】精彩解说合集`;
    }
  }

  /** AI 生成描述 — LLM 调用失败时降级为模板文本 */
  private async generateDescription(req: PublishRequest): Promise<string> {
    try {
      const scriptSamples = req.shots.map(s => s.script).join('\n').slice(0, 500);
      const prompt = `为以下视频写一段100字左右的中文发布描述（适合B站/抖音风格）：\n${scriptSamples}`;
      const config = ProviderManager.getLLMConfig('chat');
      const adapter = LLMFactory.createFromConfig(config);
      const messages = [{ role: 'system' as const, content: '你是一个视频内容推广专家。' }, { role: 'user' as const, content: prompt }];
      const result = await adapter.chat(messages, config.model, config.temperature);
      return (result.text || '').slice(0, 200).trim() || `本期视频解说：${req.shots[0]?.script?.slice(0, 50) || '精彩内容'}...`;
    } catch {
      return `📹 ${req.projectName}\n\n本期为大家带来精彩解说分析，欢迎点赞关注！#视频解说`;
    }
  }

  /** 生成封面图 — 从视频截取关键帧，使用 sharp 叠加标题文字 */
  private async generateCover(req: PublishRequest, publishDir: string): Promise<string> {
    const coverPath = path.join(publishDir, 'cover.jpg');
    const targetMp4 = req.mp4Path || req.mediaPath;

    if (!fs.existsSync(targetMp4)) {
      AppLogger.warn(LOG_TAGS.EXPORT, '[PublishService] 源视频不存在，跳过封面生成');
      return coverPath;
    }

    try {
      // 使用 VideoProcessor 截取关键帧
      const { VideoProcessor } = await import('../engine/media/VideoProcessor');
      const tempDir = path.join(publishDir, '.temp');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

      const coverFileName = await VideoProcessor.generateCover(targetMp4, tempDir, 'publish_cover');
      const extractedCoverPath = coverFileName ? path.join(tempDir, coverFileName) : null;

      if (extractedCoverPath && fs.existsSync(extractedCoverPath)) {
        // V1.2: 使用 sharp 在封面上叠加标题文字水印
        const titleText = req.projectName.slice(0, 12);
        const coverBuffer = await sharp(extractedCoverPath)
          .resize(1280, 720, { fit: 'cover', position: 'center' })
          .composite([{
            input: await this.createTextOverlay(titleText, 1280),
            gravity: 'south',
          }])
          .jpeg({ quality: 90 })
          .toBuffer();
        fs.writeFileSync(coverPath, coverBuffer);
      }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    } catch (err: any) {
      AppLogger.warn(LOG_TAGS.EXPORT, '[PublishService] 封面生成失败:', err.message);
      // 降级：尝试直接复制原始帧
      try {
        const tempDir = path.join(publishDir, '.temp');
        const { VideoProcessor } = await import('../engine/media/VideoProcessor');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const fallbackName = await VideoProcessor.generateCover(targetMp4, tempDir, 'publish_cover');
        if (fallbackName) {
          const srcPath = path.join(tempDir, fallbackName);
          if (fs.existsSync(srcPath)) fs.copyFileSync(srcPath, coverPath);
        }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      } catch {}
    }

    return coverPath;
  }

  /** 使用 sharp 创建半透明文字叠加层 */
  private async createTextOverlay(text: string, width: number): Promise<Buffer> {
    const svgText = `
      <svg width="${width}" height="120" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="black" stop-opacity="0" />
            <stop offset="100%" stop-color="black" stop-opacity="0.7" />
          </linearGradient>
        </defs>
        <rect width="${width}" height="120" fill="url(#fade)" />
        <text x="${width / 2}" y="75" text-anchor="middle"
          font-family="Arial, sans-serif" font-size="42" font-weight="bold"
          fill="white" stroke="rgba(0,0,0,0.5)" stroke-width="2">
          ${text}
        </text>
      </svg>`;
    return sharp(Buffer.from(svgText)).png().toBuffer();
  }
}
