import React, { useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '../../../components/ui/popover'
import { Switch } from '../../../components/ui/switch'
import { Input } from '../../../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'
import { Settings, X } from 'lucide-react'
import { cn } from '../../../lib/utils'

interface NodeConfig {
  key: string
  label: string
  icon: string
  params: {
    enabled: boolean
    quality?: 'low' | 'medium' | 'high'
    threshold?: number
    customParam?: string
  }
}

interface NodePopoverProps {
  node: NodeConfig
  onConfigChange: (key: string, config: Partial<NodeConfig['params']>) => void
  className?: string
}

/**
 * 节点弹出层
 * 点击管线节点图标弹出专属配置面板
 * 包含节点参数表单（启用/禁用、质量、阈值等）
 * 修改后实时持久化，点击外部关闭
 */
const NodePopover: React.FC<NodePopoverProps> = ({ node, onConfigChange, className }) => {
  const [isOpen, setIsOpen] = useState(false)

  const handleChange = (field: string, value: any) => {
    onConfigChange(node.key, { [field]: value })
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer outline-none',
            'hover:bg-accent/10 hover:text-accent',
            isOpen && 'bg-accent/10 text-accent',
            'text-muted-foreground'
          )}
          title={`配置 ${node.label}`}
        >
          <span className="text-sm">{node.icon}</span>
          <Settings size={12} className="opacity-40" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start" sideOffset={8}>
        <div className="flex flex-col">
          {/* 头部 */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
            <div className="flex items-center gap-2">
              <span className="text-sm">{node.icon}</span>
              <span className="text-[13px] font-semibold text-foreground">{node.label}</span>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer outline-none"
            >
              <X size={12} />
            </button>
          </div>

          {/* 参数表单 */}
          <div className="px-4 py-3 flex flex-col gap-4">
            {/* 启用/禁用开关 */}
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-[12px] text-foreground font-medium">启用此节点</span>
                <span className="text-[10px] text-muted-foreground">关闭后跳过此步骤</span>
              </div>
              <Switch
                checked={node.params.enabled}
                onCheckedChange={(v) => handleChange('enabled', v)}
              />
            </div>

            {/* 质量选择（音频分离、TTS 等节点） */}
            {(node.key === 'taskAudioSeparate' || node.key === 'taskTTS') && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-foreground font-medium">处理质量</span>
                <Select
                  value={node.params.quality || 'medium'}
                  onValueChange={(v) => handleChange('quality', v)}
                >
                  <SelectTrigger className="w-full h-8 text-xs bg-bg-secondary border-border/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-bg-tertiary border-border/50">
                    <SelectItem value="low" className="text-xs">低质量（快速）</SelectItem>
                    <SelectItem value="medium" className="text-xs">中等质量</SelectItem>
                    <SelectItem value="high" className="text-xs">高质量（慢速）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* VLM / ASR 阈值 */}
            {(node.key === 'taskVisualModel' || node.key === 'taskASR' || node.key === 'taskSentiment') && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-foreground font-medium">置信度阈值</span>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={node.params.threshold ?? 0.7}
                    onChange={(e) => handleChange('threshold', parseFloat(e.target.value) || 0)}
                    className="flex-1 h-8 text-xs bg-bg-secondary border-border/50"
                  />
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    {Math.round((node.params.threshold ?? 0.7) * 100)}%
                  </span>
                </div>
              </div>
            )}

            {/* AI脚本/故事生成 自定义参数 */}
            {(node.key === 'taskScriptModel') && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-foreground font-medium">创意温度</span>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={node.params.customParam ?? 0.7}
                    onChange={(e) => handleChange('customParam', e.target.value)}
                    className="flex-1 h-8 text-xs bg-bg-secondary border-border/50"
                    placeholder="0.0 - 2.0"
                  />
                </div>
                <span className="text-[10px] text-muted-foreground">越高创意越大，越低越保守</span>
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

NodePopover.displayName = 'NodePopover'

export { NodePopover }
export type { NodeConfig }