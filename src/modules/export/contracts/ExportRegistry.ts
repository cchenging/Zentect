// 📁 路径：src/modules/export/contracts/ExportRegistry.ts
// 契约层：出口注册表（id → IExporter 映射），编排层统一获取出口

import { AppError, ErrorCode } from '../../infra/error/AppError';
import type { IExporter } from './IExporter';

/**
 * 出口注册表：按 id 索引所有 IExporter。
 * 新增出口只需 register 一行，编排层无感知。
 */
export class ExportRegistry {
  private readonly exporters = new Map<string, IExporter>();

  /** 注册一个出口，重复 id 抛错暴露冲突 */
  register(exporter: IExporter): void {
    if (this.exporters.has(exporter.id)) {
      throw new AppError(ErrorCode.SYS_INVALID_INPUT, `导出出口重复注册: ${exporter.id}`);
    }
    this.exporters.set(exporter.id, exporter);
  }

  /** 按 id 获取出口，不存在抛错（fail-fast，不返回 undefined 兜底） */
  get(id: string): IExporter {
    const exporter = this.exporters.get(id);
    if (!exporter) {
      throw new AppError(ErrorCode.SYS_INVALID_INPUT, `未知导出出口: ${id}`);
    }
    return exporter;
  }

  /** 是否已注册某出口 */
  has(id: string): boolean {
    return this.exporters.has(id);
  }

  /** 全部已注册出口 id */
  ids(): string[] {
    return Array.from(this.exporters.keys());
  }
}