import { create } from 'zustand';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  action?: any;
  executed?: boolean;
}

interface ChatState {
  messages: Message[];
  isStreaming: boolean;
  addMessage: (msg: Message) => void;
  updateLastMessage: (content: string) => void;
  updateLastAction: (action: any) => void;
  // 💥 专门用来修改卡片策略下拉框的方法，安全无痛！
  updateMessageParam: (msgId: string, paramKey: string, newValue: any) => void;
  setMessages: (msgs: Message[]) => void;
  setStreaming: (val: boolean) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isStreaming: false,
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  updateLastMessage: (content) => set((state) => {
    const newMessages = [...state.messages];
    const lastMsg = newMessages[newMessages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      newMessages[newMessages.length - 1] = { ...lastMsg, content: lastMsg.content + content };
    }
    return { messages: newMessages };
  }),
  updateLastAction: (action) => set((state) => {
    const newMessages = [...state.messages];
    const lastMsg = newMessages[newMessages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      newMessages[newMessages.length - 1] = { ...lastMsg, action };
    }
    return { messages: newMessages };
  }),
  
  // 💥 修复白屏核心：在 Store 内部正确处理数组映射
  updateMessageParam: (msgId, paramKey, newValue) => set((state) => ({
    messages: state.messages.map(m => 
      m.id === msgId && m.action ? { ...m, action: { ...m.action, [paramKey]: newValue } } : m
    )
  })),

  setMessages: (msgs) => set({ messages: msgs }),
  setStreaming: (val) => set({ isStreaming: val }),
}));