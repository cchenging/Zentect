import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Wand2, Trash2 } from 'lucide-react'
import { useStore } from '../../../store/useStore'
import { cn } from '../../../lib/utils'

interface PromptHistoryItem {
  id: string
  text: string
  timestamp: number
}

interface PromptBarProps {
  className?: string
}

/**
 * 提示词输入栏
 * 编辑器底部固定输入栏，支持输入自然语言指令
 * Enter 发送、显示发送历史、支持清空
 */
const PromptBar: React.FC<PromptBarProps> = ({ className }) => {
  const [inputValue, setInputValue] = useState('')
  const [history, setHistory] = useState<PromptHistoryItem[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const pipelineRunning = useStore((s) => s.pipelineRunning)

  /** 发送提示词 */
  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim()
    if (!trimmed || pipelineRunning) return

    const newItem: PromptHistoryItem = {
      id: `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      text: trimmed,
      timestamp: Date.now(),
    }

    setHistory(prev => [newItem, ...prev].slice(0, 20))
    setInputValue('')
    setShowHistory(false)

    // TODO: 实际集成 Agent 通信
  }, [inputValue, pipelineRunning])

  /** 清空历史 */
  const handleClearHistory = useCallback(() => {
    setHistory([])
    setShowHistory(false)
  }, [])

  /** 选中历史项填入输入框 */
  const handleSelectHistory = useCallback((item: PromptHistoryItem) => {
    setInputValue(item.text)
    setShowHistory(false)
    inputRef.current?.focus()
  }, [])

  /** 键盘事件处理 */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  return (
    <div className={cn('flex flex-col', className)}>
      {/* 发送历史下拉 */}
      {showHistory && history.length > 0 && (
        <div className="glass-card mx-3 border-t-0 rounded-t-none max-h-[160px] overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/20">
            <span className="text-[10px] text-muted-foreground">发送历史</span>
            <button
              onClick={handleClearHistory}
              className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-accent-rose transition-colors cursor-pointer outline-none"
            >
              <Trash2 size={10} /> 清空
            </button>
          </div>
          {history.map((item) => (
            <button
              key={item.id}
              onClick={() => handleSelectHistory(item)}
              className="w-full text-left px-3 py-1.5 text-[11px] text-foreground/80 hover:bg-white/[0.03] transition-colors cursor-pointer outline-none truncate"
            >
              {item.text}
            </button>
          ))}
        </div>
      )}

      {/* 输入栏主体 */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-bg-deep border-t border-border/30">
        {/* 历史按钮 */}
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer outline-none shrink-0"
          title="发送历史"
        >
          <Wand2 size={15} className={cn(showHistory && 'text-accent')} />
        </button>

        {/* 输入框 */}
        <div className="flex-1 relative">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入提示词指令，Enter 发送..."
            disabled={pipelineRunning}
            className="w-full h-8 px-3 text-[12px] bg-bg-secondary border border-border/50 rounded-lg text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-accent/40 transition-colors disabled:opacity-40"
          />
        </div>

        {/* 发送按钮 */}
        <button
          onClick={handleSend}
          disabled={!inputValue.trim() || pipelineRunning}
          className="w-8 h-8 flex items-center justify-center rounded-lg bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer outline-none shrink-0"
          title="发送"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}

PromptBar.displayName = 'PromptBar'

export { PromptBar }
export type { PromptHistoryItem }