import { LocalExporter } from './export/LocalExporter'

interface ExporterPlugin {
  id: string
  name: string
  description: string
  version: string
  exporter: () => any
}

export class ExporterPluginRegistry {
  private static instance: ExporterPluginRegistry
  private plugins = new Map<string, ExporterPlugin>()

  private constructor() {
    this.registerBuiltins()
  }

  static getInstance(): ExporterPluginRegistry {
    if (!ExporterPluginRegistry.instance) {
      ExporterPluginRegistry.instance = new ExporterPluginRegistry()
    }
    return ExporterPluginRegistry.instance
  }

  private registerBuiltins(): void {
    this.register({
      id: 'jianying',
      name: '剪映草稿 (draft_content.json)',
      description: '导出为剪映桌面版可直接导入的草稿项目',
      version: '1.0.0',
      exporter: () => new LocalExporter()
    })

    this.register({
      id: 'local-json',
      name: 'Zentect 项目文件 (.json)',
      description: '本机完整项目导出，包含所有媒体引用',
      version: '1.0.0',
      exporter: () => new LocalExporter() // 复用同一导出器
    })
  }

  register(plugin: ExporterPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`导出器插件已存在: ${plugin.id}`)
    }
    this.plugins.set(plugin.id, plugin)
  }

  get(id: string): ExporterPlugin | undefined {
    return this.plugins.get(id)
  }

  list(): ExporterPlugin[] {
    return Array.from(this.plugins.values())
  }

  getIds(): string[] {
    return Array.from(this.plugins.keys())
  }
}
