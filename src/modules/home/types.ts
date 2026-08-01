// Home 模块接口契约

export interface ProjectRecord {
  id: string;
  name: string;
  type?: string;
  coverPath: string | null;
  duration: string | null;
  size?: number;
  step5Status?: string;
  /** 🎬 P2-A 剧集层：关联的剧集 ID（NULL 表示独立项目） */
  showId?: string | null;
  /** 🎬 P2-A 剧集层：集数 */
  episodeNumber?: number | null;
  createdAt: string;
  updatedAt: string;
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
