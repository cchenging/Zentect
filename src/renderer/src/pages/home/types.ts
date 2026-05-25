export interface ProjectRecord {
  id: string;
  name: string;
  coverPath: string | null;
  duration: string | null;
  createdAt: string;
  updatedAt: string;
  diskSize?: number; // 💥 新增：主进程递归计算返回的物理体积
}

export type Project = ProjectRecord;