import { SQLiteConnection } from '../core/SQLiteConnection';
import crypto from 'crypto';
import { CHAT_SQL } from '../queries/SystemQueries';

export class ChatHistoryRepository {
  private get db() { return SQLiteConnection.getInstance().getDB(); }

  public saveMessage(projectId: string, role: 'user' | 'assistant', content: string, actionPayload?: any) {
    this.db.prepare(CHAT_SQL.INSERT).run({
      id: crypto.randomUUID(),
      projectId: projectId,
      role: role,
      content: content,
      actionPayload: actionPayload ? JSON.stringify(actionPayload) : null
    });
  }

  public getHistory(projectId: string) {
    try {
      const rows = this.db.prepare(CHAT_SQL.GET_BY_PROJECT).all({ projectId }) as any[];
      
      // 💥 修复核心：绝对不能让一行脏数据毁了整个历史记录！
      return rows.map(row => {
        let parsedAction = undefined;
        
        // 1. 安全解析 Action JSON
        if (row.actionPayload) {
          try {
            parsedAction = typeof row.actionPayload === 'string'
              ? JSON.parse(row.actionPayload)
              : row.actionPayload;
          } catch (e) {
            // 遇到历史遗留的脏 JSON，直接吞掉，当做没有动作，保护程序不死
            parsedAction = undefined;
          }
        }

        return {
          ...row,
          // 2. 致命防御：如果 content 是 null，强制给个空字符串，保护前端 Markdown 组件！
          content: row.content || '',
          actionPayload: parsedAction
        };
      });
    } catch (error) {
      return [];
    }
  }

  public markExecuted(messageId: string) {
    this.db.prepare(CHAT_SQL.MARK_EXECUTED).run({ id: messageId });
  }
}
