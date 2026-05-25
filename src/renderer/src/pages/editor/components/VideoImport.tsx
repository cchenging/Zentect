// 📁 路径：src/renderer/src/pages/editor/components/VideoImport.tsx
// 视频导入组件 - 提供文件选择、格式验证、上传处理完整流程
import React, { useCallback, useState } from 'react';
import { Video, FileVideo, CheckCircle2, AlertCircle, FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { API } from '../../../api';
import { AppNotifier } from '../../../core/AppNotifier';
import { FrontendLogger } from '../../../utils/logger';

/** 支持的视频格式 */
const SUPPORTED_VIDEO_FORMATS = ['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm'];

/** 单文件大小上限 10GB */
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;

/** 格式验证结果 */
interface ValidationResult {
  valid: boolean;
  error?: string;
}

/** 导入状态 */
type ImportState = 'idle' | 'selected' | 'importing' | 'success' | 'error';

interface VideoImportProps {
  /** 项目ID */
  projectId: string | undefined;
  /** 导入成功回调 */
  onImportSuccess: (items: any[]) => void;
  /** 导入失败回调 */
  onImportError?: (error: string) => void;
}

/**
 * 验证视频文件格式是否受支持
 * @param filePath 文件路径
 * @returns 验证结果
 */
function validateVideoFormat(filePath: string): ValidationResult {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  if (!SUPPORTED_VIDEO_FORMATS.includes(ext)) {
    return {
      valid: false,
      error: `不支持 "${ext}" 格式，请选择 ${SUPPORTED_VIDEO_FORMATS.join('/')} 格式的视频文件`
    };
  }
  return { valid: true };
}

/**
 * 视频导入组件 - 提供完整的视频文件选择、格式验证和导入处理流程
 * 支持通过文件对话框选择和拖拽导入两种方式
 */
export const VideoImport: React.FC<VideoImportProps> = ({
  projectId,
  onImportSuccess,
  onImportError
}) => {
  const [importState, setImportState] = useState<ImportState>('idle');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [dragOver, setDragOver] = useState(false);

  /**
   * 处理文件选择并执行格式验证
   * @param filePaths 选择的文件路径数组
   */
  const handleFileSelection = useCallback((filePaths: string[]) => {
    if (filePaths.length === 0) return;

    // 逐文件验证格式
    const invalidFiles: string[] = [];
    const validFiles: string[] = [];

    for (const filePath of filePaths) {
      const result = validateVideoFormat(filePath);
      if (result.valid) {
        validFiles.push(filePath);
      } else {
        invalidFiles.push(filePath.split(/[\\/]/).pop() || filePath);
      }
    }

    if (invalidFiles.length > 0) {
      setErrorMessage(`以下文件格式不支持: ${invalidFiles.join(', ')}`);
      setImportState('error');
      onImportError?.(`格式不支持: ${invalidFiles.join(', ')}`);
      return;
    }

    setSelectedFiles(validFiles);
    setImportState('selected');
    setErrorMessage('');
  }, [onImportError]);

  /**
   * 通过系统文件对话框选择视频文件
   */
  const handleBrowse = useCallback(async () => {
    try {
      const filePaths: string[] = await API.system.openMediaDialog();
      if (filePaths && filePaths.length > 0) {
        handleFileSelection(filePaths);
      }
    } catch (err: any) {
      FrontendLogger.error('VideoImport', 'Browse Error', undefined, err);
      setErrorMessage('打开文件对话框失败');
      setImportState('error');
    }
  }, [handleFileSelection]);

  /**
   * 处理拖拽文件进入
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  /**
   * 处理拖拽文件离开
   */
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  /**
   * 处理拖拽文件释放
   */
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = Array.from(e.dataTransfer.files)
      .map((f: any) => f.path)
      .filter(Boolean);

    if (files.length > 0) {
      handleFileSelection(files);
    }
  }, [handleFileSelection]);

  /**
   * 执行视频导入：调用后端 API 将文件导入到项目中
   */
  const executeImport = useCallback(async () => {
    if (!projectId || selectedFiles.length === 0) return;

    setImportState('importing');
    try {
      const newItems = await API.media.import(projectId, selectedFiles);
      if (Array.isArray(newItems) && newItems.length > 0) {
        setImportState('success');
        onImportSuccess(newItems);
        AppNotifier.success(`成功导入 ${newItems.length} 个视频文件`);
        // 重置状态
        setTimeout(() => {
          setSelectedFiles([]);
          setImportState('idle');
        }, 1500);
      } else {
        setImportState('error');
        setErrorMessage('导入返回为空，请检查文件是否有效');
        onImportError?.('导入返回为空');
      }
    } catch (error: any) {
      FrontendLogger.error('VideoImport', 'Import Error', undefined, error);
      setImportState('error');
      setErrorMessage(error.message || '视频导入失败');
      onImportError?.(error.message || '视频导入失败');
    }
  }, [projectId, selectedFiles, onImportSuccess, onImportError]);

  /**
   * 重置导入状态
   */
  const resetState = useCallback(() => {
    setSelectedFiles([]);
    setImportState('idle');
    setErrorMessage('');
  }, []);

  /** 获取选中文件的显示名称 */
  const getFileDisplayName = (filePath: string) => {
    return filePath.split(/[\\/]/).pop() || filePath;
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 拖拽区域 */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-3 transition-all cursor-pointer
          ${dragOver ? 'border-accent/50 bg-accent/5' :
            importState === 'selected' ? 'border-accent-green/50 bg-accent-green/5' :
            importState === 'error' ? 'border-accent-rose/50 bg-accent-rose/5' :
            'border-border hover:border-accent/30 hover:bg-accent/5'}`}
        onClick={handleBrowse}
      >
        {importState === 'idle' && (
          <>
            <FileVideo size={36} className="text-muted-foreground/40" />
            <div className="text-[13px] text-muted-foreground font-medium">拖入视频文件或点击选择</div>
            <div className="text-[11px] text-muted-foreground/60">
              支持 {SUPPORTED_VIDEO_FORMATS.join(' / ')}，单文件最大 10GB
            </div>
          </>
        )}

        {importState === 'selected' && (
          <>
            <CheckCircle2 size={36} className="text-accent-green" />
            <div className="text-[13px] font-medium text-foreground">
              已选择 {selectedFiles.length} 个文件
            </div>
            <div className="flex flex-col items-center gap-1 max-w-full">
              {selectedFiles.slice(0, 3).map((f, i) => (
                <span key={i} className="text-[11px] text-accent-green truncate max-w-[280px]">
                  {getFileDisplayName(f)}
                </span>
              ))}
              {selectedFiles.length > 3 && (
                <span className="text-[10px] text-muted-foreground">
                  ...及其他 {selectedFiles.length - 3} 个文件
                </span>
              )}
            </div>
          </>
        )}

        {importState === 'importing' && (
          <>
            <Loader2 size={36} className="text-accent animate-spin" />
            <div className="text-[13px] font-medium text-foreground">正在导入视频...</div>
            <div className="text-[11px] text-muted-foreground">请稍候，文件正在处理中</div>
          </>
        )}

        {importState === 'success' && (
          <>
            <CheckCircle2 size={36} className="text-accent-green" />
            <div className="text-[13px] font-medium text-accent-green">导入成功</div>
          </>
        )}

        {importState === 'error' && (
          <>
            <AlertCircle size={36} className="text-accent-rose" />
            <div className="text-[13px] font-medium text-accent-rose">导入失败</div>
            <div className="text-[11px] text-muted-foreground max-w-[280px] text-center">{errorMessage}</div>
          </>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 h-8 text-[11px] gap-1.5"
          onClick={(e) => { e.stopPropagation(); handleBrowse(); }}
          disabled={importState === 'importing'}
        >
          <FolderOpen size={13} /> 浏览文件
        </Button>

        {importState === 'selected' && (
          <Button
            size="sm"
            className="flex-1 h-8 text-[11px] gap-1.5"
            onClick={(e) => { e.stopPropagation(); executeImport(); }}
          >
            <Video size={13} /> 开始导入
          </Button>
        )}

        {(importState === 'error' || importState === 'selected') && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-[11px] text-muted-foreground"
            onClick={(e) => { e.stopPropagation(); resetState(); }}
          >
            重选
          </Button>
        )}
      </div>
    </div>
  );
};
