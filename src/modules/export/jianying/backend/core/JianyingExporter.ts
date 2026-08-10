// 📁 路径：src/modules/export/jianying/backend/core/JianyingExporter.ts
// 剪映导出主流程编排：validate → 命名 → 素材/轨道装配 → 草稿内容组装 → 写盘
//
// 职责：串联各子模块（resolvers / assemblers / writers），不实现具体格式逻辑。
// 设计原则：错就错、不降级、不兜底；validate 前置 fail-fast。

import * as fs from 'fs';
import * as path from 'path';
import type { JianyingExportInput, JianyingExportOutput, SubtitleStyle } from '../../types';
import { DEFAULT_SUBTITLE_STYLE } from '../../types';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';
import { resolveDraftName } from './resolvers/DraftNameResolver';
import { resolveMetaInfo } from './resolvers/MetaInfoResolver';
import { assembleDraftContent } from './assemblers/DraftContentAssembler';
import { buildKeyValue } from '../writers/KeyValueWriter';
import { buildDraftVirtualStore } from '../writers/VirtualStoreWriter';
import type { CompileShot } from '../../types';

/** BGM 素材整片铺底所需的输入片段（由 buildCompileShots 产出） */
export interface CompileContext {
  /** 编译后的镜头数组 */
  shots: CompileShot[];
}

/**
 * 校验导出输入与草稿根目录，前置 fail-fast。
 *
 * @param input 导出输入参数
 * @param jianyingRoot 剪映草稿根目录
 */
export function validateInput(input: JianyingExportInput, jianyingRoot: string): void {
  if (!input || !input.projectId) {
    throw new AppError(ErrorCode.SYS_INVALID_INPUT, '缺少 projectId');
  }
  if (!fs.existsSync(jianyingRoot)) {
    throw new AppError(ErrorCode.FS_PATH_INVALID, '未找到剪映草稿目录，请在设置中手动指定。');
  }
}

/**
 * 清洗非法文件名字符为下划线。
 *
 * @param name 原始项目名
 * @returns 清洗后的安全名
 */
export function sanitizeProjectName(name: string): string {
  return (name || 'Zentect').replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * 剪映草稿导出主流程。
 *
 * @param input 导出输入参数
 * @param jianyingRoot 剪映草稿根目录
 * @param compileShots 已编译镜头（由 buildCompileShots 产出）
 * @param subtitleStyle 字幕样式（缺省用默认样式）
 * @returns 导出结果（文件夹路径 + 名称）
 */
export function exportJianying(
  input: JianyingExportInput,
  jianyingRoot: string,
  compileShots: CompileShot[],
  subtitleStyle: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
): JianyingExportOutput {
  validateInput(input, jianyingRoot);

  // 草稿名：Z_项目名 (自增序号)，保证每次导出为全新文件夹
  const safeName = sanitizeProjectName(input.projectName || 'Zentect');
  const draftName = resolveDraftName(safeName, jianyingRoot);
  const draftFolder = path.join(jianyingRoot, draftName);
  fs.mkdirSync(draftFolder, { recursive: true });

  // 编译草稿内容（以 scriptParagraphs 为主数据源）
  const draftContent = assembleDraftContent(
    compileShots,
    input.mediaPath || input.outputDir,
    input.bgmPath,
    subtitleStyle,
  );

  // 写入 draft_content.json（主数据）
  fs.writeFileSync(
    path.join(draftFolder, 'draft_content.json'),
    JSON.stringify(draftContent, null, 2),
  );

  // 写入 draft_meta.json（剪映读取的基础元数据）
  const meta = {
    draft_name: draftName,
    draft_id: draftContent.id,
    draft_type: 'short_video',
  };
  fs.writeFileSync(
    path.join(draftFolder, 'draft_meta.json'),
    JSON.stringify(meta),
  );

  // 写入 draft_meta_info.json（剪映草稿列表扫描依赖，draft_version 与 content 一致为 360000）
  const metaInfo = resolveMetaInfo({
    draftFolder,
    jianyingRoot,
    draftName,
    draftContent,
  });
  fs.writeFileSync(
    path.join(draftFolder, 'draft_meta_info.json'),
    JSON.stringify(metaInfo, null, 2),
    'utf-8',
  );

  // 写入 key_value.json（剪映 8.9.0+ "本地"素材面板显示，手册坑位 7/8）
  fs.writeFileSync(
    path.join(draftFolder, 'key_value.json'),
    JSON.stringify(buildKeyValue(draftContent), null, 2),
    'utf-8',
  );

  // 写入 draft_virtual_store.json（剪映 8.9.0+ 素材导入仓库，手册坑位 7）
  fs.writeFileSync(
    path.join(draftFolder, 'draft_virtual_store.json'),
    JSON.stringify(buildDraftVirtualStore(draftContent), null, 2),
    'utf-8',
  );

  return { filePath: draftFolder, fileName: draftName };
}