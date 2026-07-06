// Home 模块接口契约

export interface ProjectRecord {
  id: string;
  name: string;
  type?: string;
  coverPath: string | null;
  duration: string | null;
  createdAt: string;
  updatedAt: string;
  diskSize?: number;
}

export type Project = ProjectRecord;

/** 首页列表输入 */
export interface HomeListInput {
  searchQuery: string;
  viewMode: 'grid' | 'list';
}

/** 首页列表输出 */
export interface HomeListOutput {
  projects: ProjectRecord[];
  totalCount: number;
}
