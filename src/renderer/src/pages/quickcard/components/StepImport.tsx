import React, { useCallback, useState, useEffect } from 'react';
import { Upload, Film, FileVideo, CheckCircle2, AlertCircle, Settings, X } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { API } from '../../../api';
import { useI18n } from '../../../store/useI18n';

interface StepImportProps {
  onComplete: (filePath: string) => Promise<void>;
}

const SUPPORTED_FORMATS = ['.mp4', '.mkv', '.mov', '.avi'];
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB限制
void MAX_FILE_SIZE;

/** V1.2: BYOK 引导弹窗 — 首次进快捷卡检测 API 密钥缺失，弹出引导提示 */
const ByokGuidanceModal: React.FC<{ message: string; onDismiss: () => void }> = ({ message: _message, onDismiss }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
    onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}>
    <div className="bg-card border border-border rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden animate-in fade-in zoom-in duration-200">
      {/* 弹窗头部 */}
      <div className="flex items-center justify-between p-5 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-amber-500/15 flex items-center justify-center">
            <AlertCircle size={18} className="text-amber-500" />
          </div>
          <h3 className="text-base font-semibold">AI 服务未配置</h3>
        </div>
        <button onClick={onDismiss} className="p-1 rounded-lg hover:bg-accent transition-colors">
          <X size={18} className="text-muted-foreground" />
        </button>
      </div>
      {/* 弹窗内容 — BYOK 引导说明 */}
      <div className="p-5 space-y-4">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Zentect 的 AI 解说、配音、出片功能需要接入大语言模型（LLM）。我们<strong className="text-foreground">不自带 API Key</strong>，你需要自行注册一个 AI 服务商获取密钥。
        </p>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">推荐服务商（任选其一）</p>
          <div className="grid gap-2 text-xs">
            <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer"
              className="flex items-center justify-between p-2.5 rounded-lg bg-accent/50 hover:bg-accent transition-colors no-underline">
              <span className="font-medium text-foreground">DeepSeek</span>
              <span className="text-muted-foreground">便宜，推荐新手</span>
            </a>
            <a href="https://dashscope.aliyun.com" target="_blank" rel="noreferrer"
              className="flex items-center justify-between p-2.5 rounded-lg bg-accent/50 hover:bg-accent transition-colors no-underline">
              <span className="font-medium text-foreground">通义千问</span>
              <span className="text-muted-foreground">阿里云生态</span>
            </a>
            <a href="https://console.volcengine.com/ark" target="_blank" rel="noreferrer"
              className="flex items-center justify-between p-2.5 rounded-lg bg-accent/50 hover:bg-accent transition-colors no-underline">
              <span className="font-medium text-foreground">火山豆包</span>
              <span className="text-muted-foreground">字节系首选</span>
            </a>
          </div>
        </div>
        <p className="text-xs text-muted-foreground/70 leading-relaxed">
          注册后在 设置 → AI 中粘贴 API Key 即可使用。部分服务商提供免费额度，无需付费。
        </p>
      </div>
      {/* 弹窗底部操作 */}
      <div className="flex gap-2 p-5 pt-0">
        <Button variant="outline" size="sm" className="flex-1 h-9" onClick={onDismiss}>
          稍后配置
        </Button>
        <Button size="sm" className="flex-1 h-9 gap-1.5"
          onClick={() => { window.open('#/settings', '_self'); onDismiss(); }}>
          <Settings size={14} /> 立即配置
        </Button>
      </div>
    </div>
  </div>
);

export const StepImport: React.FC<StepImportProps> = ({ onComplete }) => {
  const { t } = useI18n();
  const qc = t.quickcard?.import || {};
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [configOk, setConfigOk] = useState<boolean | null>(null);
  const [configMessage, setConfigMessage] = useState('');
  const [showByokModal, setShowByokModal] = useState(false); // V1.2: BYOK 弹窗状态

  /** P0: 首次渲染时检查 API Key 配置状态 */
  useEffect(() => {
    (async () => {
      try {
        const result = await API.engine.preflight();
        setConfigOk(result.ok);
        setConfigMessage(result.message);
        // V1.2: API Key 缺失 → 弹出 BYOK 引导弹窗
        if (!result.ok) setShowByokModal(true);
      } catch {
        // 静默失败，不阻塞导入流程
      }
    })();
  }, []);

  const validateFile = useCallback((filePath: string): string | null => {
    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
    if (!SUPPORTED_FORMATS.includes(ext)) {
      return (qc.format_error || '不支持 "{ext}" 格式').replace('{ext}', ext);
    }
    return null;
  }, [qc.format_error]);

  const handleFile = useCallback(async (filePath: string) => {
    const validationError = validateFile(filePath);
    if (validationError) { setError(validationError); return; }
    setError(null);
    setSelectedFile(filePath);
  }, [validateFile]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) await handleFile((file as any).path);
  }, [handleFile]);

  const handleBrowse = useCallback(async () => {
    const filePaths: string[] = await API.system.openMediaDialog();
    if (filePaths && filePaths.length > 0) {
      await handleFile(filePaths[0]);
    }
  }, [handleFile]);

  const handleStart = useCallback(async () => {
    if (!selectedFile) return;
    setLoading(true);
    try {
      await onComplete(selectedFile);
    } catch (err: any) {
      setError(err.message || '');
      setLoading(false);
    }
  }, [selectedFile, onComplete]);

  return (
    <div className="max-w-2xl mx-auto pt-12 flex flex-col items-center gap-8">
      {/* V1.2: BYOK 引导弹窗 — API 密钥缺失时主动弹出 */}
      {showByokModal && configMessage && (
        <ByokGuidanceModal
          message={configMessage}
          onDismiss={() => setShowByokModal(false)}
        />
      )}

      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
        <Upload size={32} className="text-primary" />
      </div>
      <h2 className="text-xl font-semibold">{qc.title || '导入电影文件'}</h2>
      <p className="text-sm text-muted-foreground text-center max-w-md">{qc.desc || '支持 mp4、mkv、mov、avi 格式，单文件最大 10GB'}</p>

      {/* P0: 配置状态提示条 — 首次加载时检测 API Key 是否配齐 */}
      {configOk === false && (
        <div className="w-full p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
          <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-amber-600 dark:text-amber-400 font-medium mb-1">AI 服务未完全配置</p>
            <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed">{configMessage}</p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0 h-7 text-xs gap-1"
            onClick={() => window.open('#/settings', '_self')}>
            <Settings size={12} /> 去配置
          </Button>
        </div>
      )}
      {configOk === true && (
        <div className="w-full p-2 rounded-lg bg-success/10 border border-success/30 flex items-center gap-2">
          <CheckCircle2 size={14} className="text-success shrink-0" />
          <span className="text-xs text-success">AI 服务已就绪</span>
        </div>
      )}

      <div
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        className={`w-full border-2 border-dashed rounded-xl p-16 flex flex-col items-center gap-4 transition-all cursor-pointer
          ${selectedFile ? 'border-success/50 bg-success/5'
            : dragging ? 'border-primary/50 bg-primary/5'
            : 'border-border hover:border-primary/50 hover:bg-primary/5'}`}
      >
        {selectedFile ? (
          <>
            <CheckCircle2 size={48} className="text-success" />
            <span className="text-sm text-foreground font-medium">{selectedFile.split(/[\\/]/).pop()}</span>
            <span className="text-xs text-success">{qc.pass || '格式校验通过'}</span>
          </>
        ) : (
          <>
            <FileVideo size={48} className="text-muted-foreground/40" />
            <span className="text-sm text-muted-foreground">{qc.drop_hint || '拖入电影文件到此处'}</span>
            <span className="text-xs text-muted-foreground/60">{qc.or || '或'}</span>
            <Button variant="outline" className="gap-2" onClick={handleBrowse}>
              <Film size={16} /> {qc.browse || '选择文件'}
            </Button>
          </>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-error bg-error/10 px-4 py-2 rounded-lg border border-error/30">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      <Button onClick={handleStart} disabled={!selectedFile || loading} size="lg" className="w-48">
        {loading ? (qc.creating || '创建项目中...') : (qc.start || '开始分析')}
      </Button>
    </div>
  );
};
