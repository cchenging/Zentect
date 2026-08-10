// 📁 路径：src/modules/export/createExportRegistry.ts
// 导出注册表工厂：集中注册所有出口（jianying / mp4），编排层统一获取。
//
// 设计原则：新增出口只需「实现 IExporter + 在此注册一行」，编排层无感知。
// 返回全新实例，避免模块级单例污染（真模块化：状态隔离）。

import { ExportRegistry } from './contracts/ExportRegistry';
import { JianyingExporter } from './jianying/backend/JianyingExporter';
import { Mp4Exporter } from './mp4/backend/Mp4Exporter';

/**
 * 构建并注册所有导出出口的注册表。
 *
 * @returns 已注册 jianying + mp4 的 ExportRegistry
 */
export function buildExportRegistry(): ExportRegistry {
  const registry = new ExportRegistry();
  registry.register(new JianyingExporter());
  registry.register(new Mp4Exporter());
  return registry;
}