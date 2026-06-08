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