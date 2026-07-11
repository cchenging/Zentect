export interface ProjectRecord {
  id: string;
  name: string;
  type?: string;
  coverPath: string | null;
  duration: string | null;
  size?: number;
  step5Status?: string;
  createdAt: string;
  updatedAt: string;
}

export type Project = ProjectRecord;