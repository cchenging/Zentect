/** V1.3 B4: 发布素材编辑面板（RightPanel 嵌入组件）
 *  编辑封面、标题、描述、标签，通过 Zustand store 与中栏 StepPublish 双向同步
 */

import React from 'react';
import { Image, Type, FileText, Tag, Upload } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';

interface PublishEditorProps {
  coverUrl: string;
  title: string;
  description: string;
  tags: string[];
  coverSource: 'first_frame' | 'custom';
  onCoverChange: (url: string, source: 'custom') => void;
  onTitleChange: (title: string) => void;
  onDescriptionChange: (desc: string) => void;
  onTagsChange: (tags: string[]) => void;
}

export const PublishEditor: React.FC<PublishEditorProps> = ({
  coverUrl,
  title,
  description,
  tags,
  coverSource,
  onCoverChange,
  onTitleChange,
  onDescriptionChange,
  onTagsChange,
}) => {
  const [tagInput, setTagInput] = React.useState('');

  /** 添加标签 */
  const addTag = () => {
    const trimmed = tagInput.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onTagsChange([...tags, trimmed]);
    }
    setTagInput('');
  };

  /** 删除标签 */
  const removeTag = (tag: string) => {
    onTagsChange(tags.filter(t => t !== tag));
  };

  /** 上传自定义封面 */
  const handleCoverUpload = async () => {
    try {
      const filePaths: string[] = await (window as any).api?.system?.openImageDialog?.() ?? [];
      if (filePaths?.length > 0) {
        onCoverChange(filePaths[0], 'custom');
      }
    } catch {
      // 静默失败
    }
  };

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
      <h3 className="text-sm font-medium shrink-0">编辑发布素材</h3>

      {/* 封面 */}
      <div className="space-y-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
          <Image size={12} /> 封面
        </label>
        <div className="relative aspect-video rounded-lg bg-card border border-border overflow-hidden group">
          {coverUrl ? (
            <img src={coverUrl} alt="封面预览" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
              <Image size={36} className="opacity-30" />
            </div>
          )}
          <button
            onClick={handleCoverUpload}
            className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <Upload size={20} className="text-white" />
          </button>
        </div>
        <div className="flex gap-2 text-xs text-muted-foreground">
          <span className={coverSource === 'first_frame' ? 'text-primary' : ''}>
            视频首帧
          </span>
          <span className={coverSource === 'custom' ? 'text-primary' : ''}>
            自定义
          </span>
        </div>
      </div>

      {/* 标题 */}
      <div className="space-y-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
          <Type size={12} /> 标题
        </label>
        <Input
          value={title}
          onChange={e => onTitleChange(e.target.value)}
          placeholder="输入吸引眼球的标题..."
          className="h-9 text-sm"
        />
      </div>

      {/* 描述 */}
      <div className="space-y-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
          <FileText size={12} /> 描述
        </label>
        <Textarea
          value={description}
          onChange={e => onDescriptionChange(e.target.value)}
          placeholder="视频内容简介..."
          rows={3}
          className="text-sm resize-none"
        />
      </div>

      {/* 标签 */}
      <div className="space-y-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
          <Tag size={12} /> 标签
        </label>
        <div className="flex gap-2">
          <Input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            placeholder="输入标签后回车..."
            className="h-9 text-sm flex-1"
          />
          <Button variant="outline" size="sm" className="h-9" onClick={addTag}>
            添加
          </Button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map(tag => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-primary/10 text-primary border border-primary/20 cursor-pointer hover:bg-primary/20 transition-colors"
                onClick={() => removeTag(tag)}
              >
                #{tag} ×
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};