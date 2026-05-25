import { useStore } from '../store/useStore';
import { DraftService } from './DraftService';

interface CanvasState {
  nodes: unknown[];
  edges: unknown[];
  projectId: string | null;
}

export class DraftSyncService {
  private static instance: DraftSyncService;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs = 500;
  private unsubscribe: (() => void) | null = null;

  private constructor() {}

  static getInstance(): DraftSyncService {
    if (!DraftSyncService.instance) {
      DraftSyncService.instance = new DraftSyncService();
    }
    return DraftSyncService.instance;
  }

  start(): void {
    if (this.unsubscribe) return;

    this.unsubscribe = useStore.subscribe(
      (state): CanvasState => ({
        nodes: state.nodes,
        edges: state.edges,
        projectId: state.projectId,
      }),
      (current, previous) => {
        const pid = current.projectId;
        if (!pid) return;

        if (current.nodes !== previous.nodes || current.edges !== previous.edges) {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            DraftService.saveCanvasDraft(pid, {
              nodes: current.nodes as any[],
              edges: current.edges as any[],
            }).catch((err) => {
              console.error('[DraftSyncService] L2 缓存写入失败:', err);
            });
          }, this.debounceMs);
        }
      }
    );
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  get isRunning(): boolean {
    return this.unsubscribe !== null;
  }
}
