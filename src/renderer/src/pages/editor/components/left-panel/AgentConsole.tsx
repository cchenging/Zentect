// 📁 路径：src/renderer/src/pages/editor/components/left-panel/AgentConsole.tsx
import React, { useRef, useEffect } from 'react';
import { Send, Bot, User, Loader2, Play, CheckCircle2, Zap, Cpu } from 'lucide-react';
import ReactMarkdown from 'react-markdown'; 
import { AppNotifier } from '../../../../core/AppNotifier';
import { ContextCompressor } from '../../../../core/ContextCompressor';
import { Textarea } from '../../../../components/ui/textarea'; 
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { useEditorStore } from '../../../../store/useStore';
import { useChatStore } from '../../../../store/useChatStore';
import { IPC_CHANNELS } from '../../../../../../shared/utils/IpcConstants';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../components/ui/select';

// 💥 统一管理：Agent 动作中文字典 (绝对不允许把英文 Key 暴露给用户)
const ACTION_DICT: Record<string, string> = {
  'UPDATE_SHOT_TEXT': '修改台词',
  'DELETE_SHOT': '删除镜头',
  'SEARCH_BROLL': '素材检索',
  'ISOLATE_VOCALS': '人声分离',
  'EXTRACT_VIDEO_FRAMES': '智能抽帧',
  'newText': '覆写内容',
  'query': '检索关键词',
  'fps': '抽帧频率 (帧/秒)',
  'strategy': '执行策略'
};

// 💥 统一管理：策略枚举中文字典
const STRATEGY_DICT: Record<string, string> = {
  'keyframe': '极速关键帧 (推荐)',
  'uniform': '按场景变化均匀采样',
  'fps': '按固定帧率强制切片'
};

interface ActionPayload {
  type: string;
  [key: string]: any;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  action?: ActionPayload; // 不再是数组，一次流对应一个原生动作
  executed?: boolean;
}

export const AgentConsole: React.FC = () => {
  const [input, setInput] = React.useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // ✅ 修复后：完美引入所有需要的方法
  const {
    messages,
    setMessages,
    addMessage,
    updateLastMessage,
    updateLastAction,  // ⬅️ 就是漏了这个救命的词！
    updateMessageParam,
    isStreaming,
    setStreaming
  } = useChatStore();
  
  // 💥 完美实现 1：从本地缓存读取上次选择的通道，没有则默认使用国内代理
  const [provider, setProvider] = React.useState<string>(() => {
    return localStorage.getItem('agent_default_channel') || 'proxy';
  });

  // 💥 完美实现 2：当用户切换下拉框时，立刻存入本地缓存
  const handleProviderChange = (val: string) => {
    setProvider(val);
    localStorage.setItem('agent_default_channel', val);
  };
  
  // 💥 BUG 修复：精准匹配 Zustand 数据结构，拒绝未定义
  const projectId = useEditorStore(state => state.projectId);

  // 💥 绝对防御阵地：确保用于渲染的永远是一个安全的数组，隔离底层状态库污染
  const safeMessages = Array.isArray(messages) ? messages : [];

  useEffect(() => {
    if (!projectId) return;
    if (messages.length > 0) return;

    const loadHistory = async () => {
      try {
        const channel = (window.api as any).IPC_CHANNELS?.AGENT_GET_HISTORY || 'agent:getHistory';
        const res = await (window.api as any).invoke(channel, projectId);
        
        // 💥 致命防御 1：确保拿到的一定是安全的 Array，哪怕后端传了奇怪的格式
        const rawData = Array.isArray(res) ? res : (res?.data || []);
        const validData = Array.isArray(rawData) ? rawData : [];
        
        if (validData.length > 0) {
          const historyMessages: Message[] = validData.map((msg: any) => ({
            id: `hist_${msg.createTime || Date.now()}_${Math.random()}`,
            role: msg.role || 'assistant',
            content: msg.content || '', // 💥 致命防御 2：双重拦截 null 进渲染树
            action: msg.actionPayload,
            executed: !!msg.actionPayload
          }));
          setMessages(historyMessages);
        }
      } catch (err) {
        console.error("Agent 历史记录加载拦截异常:", err);
      }
    };

    loadHistory();
  }, [projectId]);

  // 💥 核心修复：严格调用 preload.ts 中暴露的专属 Agent 监听方法
  useEffect(() => {
    if (!window.api) return;

    // 1. 注册开始信号：垫入空壳气泡
    (window.api as any).onAgentStreamStart(() => {
      setStreaming(true);
      addMessage({
        id: `asst_${Date.now()}`,
        role: 'assistant',
        content: '',
      });
    });

    // 2. 注册文字流：拼接到气泡
    (window.api as any).onAgentStreamChunk((chunk: string) => {
      updateLastMessage(chunk);
    });

    // 3. 注册动作卡片：挂载到气泡
    (window.api as any).onAgentToolCall((action: any) => {
      updateLastAction(action);
    });

    // 4. 注册完成信号
    (window.api as any).onAgentStreamDone(() => {
      setStreaming(false);
    });

    // 5. 注册异常信号
    (window.api as any).onAgentStreamError((errMsg: string) => {
      setStreaming(false);
      console.error("[Agent 抛出异常]:", errMsg);
    });

    // 💥 严谨的生命周期清理：调用您 preload.ts 中专门写的清理所有监听器的方法
    return () => {
      (window.api as any).removeAllAgentListeners();
    };
  }, [addMessage, updateLastMessage, updateLastAction, setStreaming]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [safeMessages]);

  const handleSend = async () => {
    if (!input.trim() || isStreaming || !projectId) {
      if (!projectId) AppNotifier.error('未检测到活跃工程 (Project ID 为空)');
      return;
    }
    const userText = input.trim();
    // 乐观更新 UI
    addMessage({ id: `u_${Date.now()}`, role: 'user', content: userText });
    setInput('');
    
    const context = ContextCompressor.getCompressedSnapshot();
    // 💥 修复：提取历史记录时，不要把刚刚发送的那句话算成 history，否则逻辑混乱
    const history = safeMessages.map(m => ({ role: m.role, content: m.content }));
    
    try {
      // 💥 修复：必须包裹成一个完整的 payload 对象发送！！！
      await (window.api as any).invokeAgentChat({
        projectId: projectId, 
        prompt: userText, 
        context: context, 
        history: history, 
        provider: provider
      });
    } catch (err: any) {
      AppNotifier.error(`消息发送崩溃：${err.message}`);
      setStreaming(false);
    }
  };

  const executeNativeAction = async (msgId: string, action: ActionPayload) => {
    const state = useEditorStore.getState();
    const isAiMode = state.storyboardMode === 'ai';
    
    try {
      switch (action.type) {
        case 'UPDATE_SHOT_TEXT':
          if (isAiMode) state.updateAiShot(action.shotId, { aiText: action.newText });
          else state.updateShot(action.shotId, { originalText: action.newText });
          AppNotifier.success(`台词已修改`);
          break;
          
        case 'DELETE_SHOT':
          const activeShots = isAiMode ? [...state.aiShots] : [...state.shots];
          const filtered = activeShots.filter(s => s.id !== action.shotId);
          if (isAiMode) useEditorStore.setState({ aiShots: filtered });
          else useEditorStore.setState({ shots: filtered });
          AppNotifier.success(`镜头已删除`);
          break;

        case 'SEARCH_BROLL':
            // 💥 修复：彻底消灭魔法字符串，严格使用 SSOT 字典
            AppNotifier.info(`正在呼叫视觉检索引擎：[${action.query}]...`);
            
            const searchRes = await window.api.invoke(IPC_CHANNELS.AI_SEARCH_BROLL, { 
              query: action.query, 
              projectId: projectId 
            });

            if (searchRes && searchRes.success && searchRes.mediaId) {
              // 构造新的镜头对象 (强行塞入时间轴)
              const newShot = {
                id: `shot_ai_search_${Date.now()}`,
                mediaId: searchRes.mediaId,
                start: 0,
                end: 3.0, // 默认高光截取 3 秒
                originalText: '',
                visionText: action.query,
                trackIndex: 0
              };
              
              const currentShots = isAiMode ? [...state.aiShots] : [...state.shots];
              currentShots.push(newShot as any);
              
              if (isAiMode) useEditorStore.setState({ aiShots: currentShots });
              else useEditorStore.setState({ shots: currentShots });
              
              AppNotifier.success(`检索命中！精准素材已自动加入轨道`);
            } else {
              AppNotifier.error(`素材库中未检索到高匹配度画面`);
              throw new Error('未命中素材'); // 抛异常阻断下面的 executed 状态
            }
            break;

          case 'ISOLATE_VOCALS':
            AppNotifier.info(`正在启动声纹解剖引擎，分离背景杂音...`);
            
            const vocalRes = await window.api.invoke(IPC_CHANNELS.AI_ISOLATE_VOCALS, projectId, action.shotId);
            
            if (vocalRes && vocalRes.success && vocalRes.audioPath) {
              // 将纯净版音频强行覆盖回前端 Zustand 的时间轴中
              if (isAiMode) state.updateAiShot(action.shotId, { audioPath: vocalRes.audioPath });
              else state.updateShot(action.shotId, { audioPath: vocalRes.audioPath });
              
              AppNotifier.success(`人声分离完成！已无缝替换原音轨`);
            } else {
              AppNotifier.error(vocalRes?.error || `音频提取失败`);
              throw new Error('音频提取失败');
            }
            break;

          case 'EXTRACT_VIDEO_FRAMES':
            // 💥 宪法合规：拦截缺少必填上下文的非法动作
            if (!action.mediaId || String(action.mediaId) === 'undefined') {
               AppNotifier.error("指令缺少对应的素材ID，无法定位物理文件");
               return; // 严禁使用 throw 炸毁 executeNativeAction 的 Promise
            }
            
            // 💥 宪法合规：使用 SSOT 字典映射策略名称
            const strategyName = STRATEGY_DICT[action.strategy as string] || action.strategy || '极速关键帧';
            AppNotifier.info(`正在调用 FFmpeg 引擎执行 [${strategyName}] 抽帧...`);
            
            const frameRes = await window.api.invoke(
              IPC_CHANNELS.AI_EXTRACT_FRAMES, 
              action.mediaId, 
              action.strategy || 'keyframe', 
              action.fps || 1
            );
            
            // 💥 绝对防御阵地：阻击一切 is not iterable
            if (frameRes && frameRes.success === true && Array.isArray(frameRes.data?.frames)) {
              const frames = frameRes.data.frames;
              if (frames.length === 0) {
                 AppNotifier.warning(`抽帧引擎已运行，但当前策略 [${strategyName}] 未能切出符合阈值的画面`);
                 return;
              }
              // 安全注入 Zustand 状态树
              useEditorStore.setState(state => ({ 
                 extractedFrames: [...((state as any).extractedFrames || []), ...frames] 
              } as any));
              AppNotifier.success(`抽帧完成！成功提取 ${frames.length} 张核心切片`);
            } else {
              // 统一拦截后端的报错，如果没有则给默认提示
              AppNotifier.error(frameRes?.error || `抽帧底层引擎返回异常结构，已阻断白屏风险`);
            }
            break;
      }
      
      // 🌟 核心突破 3：执行成功后，反写回 SQLite，永久标记该动作已完成
      await (window.api as any).markAgentActionExecuted(msgId);
      
      // 💥 修复后：严格遵守 Zustand 的取值方式，杜绝状态被覆写为 Function！
      const currentMessages = useChatStore.getState().messages;
      if (Array.isArray(currentMessages)) {
        setMessages(currentMessages.map(m => m.id === msgId ? { ...m, executed: true } : m));
      }
      
    } catch (e: any) {
      AppNotifier.error(e.message || '执行原生指令失败');
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0E0E0E] relative">
      
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-6 scroll-smooth pb-32">
        {safeMessages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground/50 select-none">
            <Zap size={32} strokeWidth={1} className="mb-4 opacity-50" />
            <p className="text-xs tracking-wider">有什么剪辑想法？直接告诉我。</p>
          </div>
        )}
        {safeMessages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border ${
              msg.role === 'user' ? 'bg-primary text-primary-foreground border-primary/50' : 'bg-primary/10 text-primary border-primary/20'
            }`}>
              {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
            </div>
            
            <div className="flex flex-col gap-2 max-w-[85%]">
              {msg.content && (
                <div className={`p-3 text-sm shadow-sm prose prose-sm dark:prose-invert max-w-none ${
                  msg.role === 'user' ? 'bg-primary text-primary-foreground rounded-tl-xl rounded-b-xl text-white' : 'bg-card border border-border rounded-tr-xl rounded-b-xl'
                }`}>
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              )}

              {/* 💥 致命防御 3：确保 msg.action 绝对是一个 Object 才去调用 Object.entries */}
              {msg.action && typeof msg.action === 'object' && !Array.isArray(msg.action) && (
                <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 mt-1 shadow-sm w-full">
                  <div className="flex items-center justify-between pb-2 border-b border-primary/10 mb-3">
                     <span className="text-xs font-bold text-primary flex items-center gap-1.5">
                        <Zap size={14} className="fill-primary text-primary"/>
                        {/* 字典翻译 Action 类型 */}
                        {ACTION_DICT[msg.action.type] || msg.action.type}
                     </span>
                     {msg.executed && <CheckCircle2 size={14} className="text-green-500" />}
                  </div>
                  
                  <div className="space-y-3 mb-4">
                    {Object.entries(msg.action).map(([key, value]) => {
                      // 💥 核心：彻底隐藏机器字段！反人类的 ID 绝对不显示！
                      if (key === 'type' || key === 'mediaId' || key === 'shotId') return null;

                      // 💥 UX 升级：如果动作尚未执行，渲染交互式表单供用户微调！
                      if (!msg.executed) {
                        if (key === 'strategy') {
                          return (
                            <div key={key} className="flex items-center justify-between text-xs bg-background/50 p-2 rounded">
                              <span className="text-muted-foreground font-medium">{ACTION_DICT[key] || key}:</span>
                              <Select value={value as string} onValueChange={(val) => updateMessageParam(msg.id, 'strategy', val)}>
                                <SelectTrigger className="h-6 w-[140px] text-[10px] bg-background border-border shadow-none">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="keyframe">{STRATEGY_DICT['keyframe']}</SelectItem>
                                  <SelectItem value="uniform">{STRATEGY_DICT['uniform']}</SelectItem>
                                  <SelectItem value="fps">{STRATEGY_DICT['fps']}</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          );
                        }
                        if (key === 'fps' && msg.action.strategy === 'fps') {
                           return (
                             <div key={key} className="flex items-center justify-between text-xs bg-background/50 p-2 rounded">
                               <span className="text-muted-foreground font-medium">{ACTION_DICT[key] || key}:</span>
                               <Input
                                 type="number"
                                 className="h-6 w-[60px] text-[10px] px-2"
                                 value={value as number}
                                 onChange={(e) => updateMessageParam(msg.id, 'fps', Number(e.target.value))}
                               />
                             </div>
                           )
                        }
                      }

                      // 常规参数只读展示 (执行后，或不可修改的文本类型)，同样经过字典翻译
                      // 如果是策略字段，翻译其 Value
                      const displayValue = key === 'strategy' ? (STRATEGY_DICT[value as string] || value) : value;

                      return (
                        <div key={key} className="flex flex-col gap-1 text-xs bg-background/50 p-2 rounded">
                          <span className="text-muted-foreground font-medium">{ACTION_DICT[key] || key}:</span>
                          <span className="text-foreground break-words">{String(displayValue)}</span>
                        </div>
                      );
                    })}
                  </div>

                  {!msg.executed ? (
                    // 💥 文案优化：明确告诉用户这是他们确认过后的操作
                    <Button size="sm" className="w-full h-8 text-xs font-medium hover:scale-[1.02] transition-transform" onClick={() => executeNativeAction(msg.id, msg.action!)}>
                      <Play size={12} className="mr-1.5"/>
                      确认并执行 {ACTION_DICT[msg.action.type]?.replace('智能', '') || ''}
                    </Button>
                  ) : (
                    <div className="text-[10px] flex items-center justify-center gap-1 text-green-600 font-medium py-1.5 bg-green-500/10 rounded border border-green-500/20">
                      <CheckCircle2 size={12}/> 指令已闭环落地
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="absolute bottom-4 left-4 right-4">
        <div className="relative rounded-2xl bg-card/80 backdrop-blur-xl border border-border/60 shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-1.5 focus-within:border-primary/50 focus-within:shadow-[0_0_20px_rgba(var(--primary),0.15)] transition-all duration-300">
          
          <div className="flex items-center justify-between px-2 pt-1 pb-1">
             <Select value={provider} onValueChange={handleProviderChange} disabled={isStreaming}>
              <SelectTrigger className="h-5 w-auto border-none bg-transparent hover:bg-white/5 focus:ring-0 px-1 py-0 text-[10px] font-medium text-muted-foreground shadow-none rounded-sm">
                <Cpu size={10} className="mr-1.5 text-primary/80" />
                <SelectValue placeholder="选择大脑引擎" />
              </SelectTrigger>
              <SelectContent side="top" align="start" className="min-w-[120px]">
                <SelectItem value="proxy">国内代理/中转站</SelectItem>
                <SelectItem value="deepseek">DeepSeek 官方直连</SelectItem>
                <SelectItem value="qwen">阿里通义千问</SelectItem>
                <SelectItem value="doubao">火山豆包</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Textarea 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="例如：把男主开枪的画面截取 3 秒放到轨道上..."
            className="min-h-[50px] max-h-[120px] resize-none border-none shadow-none focus-visible:ring-0 bg-transparent px-3 pb-2 text-sm leading-relaxed"
            onKeyDown={(e) => { 
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } 
            }}
          />

          <button 
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className={`absolute bottom-2.5 right-2.5 w-7 h-7 flex items-center justify-center rounded-lg transition-all
              ${isStreaming || !input.trim() ? 'bg-muted/50 text-muted-foreground/50' : 'bg-primary text-primary-foreground hover:scale-105 shadow-md'}`}
          >
            {isStreaming ? <Loader2 className="animate-spin" size={14}/> : <Send size={13} className="ml-0.5"/>}
          </button>
        </div>
      </div>

    </div>
  );
};
