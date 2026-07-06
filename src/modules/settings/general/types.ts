// 📁 路径：src/modules/settings/general/types.ts
// 接口契约：通用设置（§3.7.4）

/** 通用设置 */
export interface GeneralSettings {
  /** 项目存储位置 */
  projectPath: string;
  /** 视频导出位置 */
  exportPath: string;
  /** 剪映草稿位置 */
  jianyingPath: string;
  /** 主题：深色 / 浅色 / 跟随系统 */
  theme: 'dark' | 'light' | 'system';
  /** 界面语言 */
  language: 'zh-CN' | 'en';
  /** GPU 加速 */
  gpuAcceleration: boolean;
  /** 自动保存间隔（秒），0 表示禁用 */
  autoSaveInterval: number;
  /** Python 路径 */
  pythonPath?: string;
  /** MOSS-TTS 模型目录 */
  mossModelDir?: string;
}

/** 健康检查状态 */
export type HealthStatus = 'ok' | 'warn' | 'error';

/** 健康检查项 */
export interface HealthCheckItem {
  /** 检查项唯一标识 */
  key: string;
  /** 显示标签 */
  label: string;
  /** 检查状态 */
  status: HealthStatus;
  /** 详细说明 */
  detail: string;
}

/** 健康检查结果 */
export interface HealthCheckResult {
  items: HealthCheckItem[];
  hardware: {
    cpu?: { percent: number; model: string; cores: number };
    memory?: { percent: number; freeMB: number; totalMB: number };
    disk?: { freeGB: number; totalGB: number };
  };
}
