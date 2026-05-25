import Dexie, { type EntityTable } from 'dexie';

// 💥 L2 缓存表结构定义：草稿表 (新增 name 字段)
export interface ProjectDraft {
  projectId: string;          
  name?: string;              // 🌟 新增：工作流的可视化名称
  canvasSnapshot: string;     
  mediaItems: string;         // 媒体资产快照 JSON
  updatedAt: number;          
  syncStatus: 'PENDING' | 'SYNCED'; 
}

class LocalWorkspaceDB extends Dexie {
  // 声明表映射
  projectDrafts!: EntityTable<ProjectDraft, 'projectId'>;

  constructor() {
    super('ZentectLocalDB');
    
    this.version(1.1).stores({
      projectDrafts: 'projectId, name, updatedAt, syncStatus'
    });
  }
}

// 导出单例实例，供整个渲染进程安全调用
export const localDB = new LocalWorkspaceDB();
