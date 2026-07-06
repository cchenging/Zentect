// Module: media/import - useMediaImport hook (frontend)
// 封装文件对话框打开 + 导入 API 调用流程

import { useCallback, useState } from 'react';
import type { MediaItem } from '../types';

interface UseMediaImportOptions {
  projectId: string | undefined;
  /** 调用系统文件对话框获取文件路径 */
  openMediaDialog: () => Promise<string[]>;
  /** 调用导入 API (projectId, filePaths) => MediaItem[] */
  importApi: (projectId: string, filePaths: string[]) => Promise<MediaItem[]>;
  /** 导入成功后回调 */
  onImported?: (items: MediaItem[]) => void;
}

interface UseMediaImportReturn {
  /** 触发导入流程 */
  handleImport: () => Promise<MediaItem[]>;
  /** 是否正在导入 */
  isImporting: boolean;
}

export function useMediaImport(options: UseMediaImportOptions): UseMediaImportReturn {
  const { projectId, openMediaDialog, importApi, onImported } = options;
  const [isImporting, setIsImporting] = useState(false);

  const handleImport = useCallback(async (): Promise<MediaItem[]> => {
    if (!projectId) return [];
    setIsImporting(true);
    try {
      const filePaths = await openMediaDialog();
      if (!filePaths || filePaths.length === 0) return [];

      const newItems = await importApi(projectId, filePaths);
      if (Array.isArray(newItems) && newItems.length > 0) {
        onImported?.(newItems);
      }
      return Array.isArray(newItems) ? newItems : [];
    } finally {
      setIsImporting(false);
    }
  }, [projectId, openMediaDialog, importApi, onImported]);

  return { handleImport, isImporting };
}
