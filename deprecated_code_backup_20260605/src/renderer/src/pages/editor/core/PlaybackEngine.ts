import { useEditorStore } from '../../../store/useStore';

type EngineEvent = 'frame' | 'play' | 'pause' | 'seek';
type EventHandler = (payload: any) => void;

class EngineCore {
  private isPlaying: boolean = false;
  private lastTime: number = 0;
  private animationFrameId: number = 0;
  private listeners: Map<EngineEvent, Set<EventHandler>> = new Map();

  public on(event: EngineEvent, handler: EventHandler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  public off(event: EngineEvent, handler: EventHandler) {
    this.listeners.get(event)?.delete(handler);
  }

  private emit(event: EngineEvent, payload: any) {
    this.listeners.get(event)?.forEach(fn => fn(payload));
  }

  public togglePlay() {
    this.isPlaying ? this.pause() : this.play();
  }

  public play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.lastTime = performance.now();
    this.emit('play', null);
    this.loop();
  }

  public pause() {
    this.isPlaying = false;
    cancelAnimationFrame(this.animationFrameId);
    this.emit('pause', null);
  }

  public seek(globalTime: number) {
    useEditorStore.getState().setCurrentTime(globalTime);
    this.emit('seek', globalTime);
    this.processFrame(globalTime);
  }

  private loop = () => {
    if (!this.isPlaying) return;

    const now = performance.now();
    const deltaSeconds = (now - this.lastTime) / 1000;
    this.lastTime = now;

    const store = useEditorStore.getState();
    let nextTime = store.currentTime + deltaSeconds;

    if (nextTime > 3600) { this.pause(); return; }

    store.setCurrentTime(nextTime);
    this.processFrame(nextTime);

    this.animationFrameId = requestAnimationFrame(this.loop);
  };

  private processFrame(globalTime: number) {
    const state = useEditorStore.getState();
    const activeShots = state.storyboardMode === 'ai' ? state.aiShots : state.shots;

    const currentShot = activeShots.find(s => globalTime >= s.start && globalTime < s.end);

    if (currentShot) {
      // 💥 防御性编程：确保 mediaItems 是数组
      const mediaArray = Array.isArray(state.mediaItems) ? state.mediaItems : [];
      const mediaItem = mediaArray.find(m => m.id === currentShot.mediaId);

      const offset = currentShot.matchedStart || 0;
      const sourceTime = offset + (globalTime - currentShot.start);

      this.emit('frame', {
        hasSignal: true,
        shotId: currentShot.id,
        mediaPath: mediaItem?.filePath,
        sourceTime: sourceTime,
        globalTime: globalTime
      });
    } else {
      this.emit('frame', { hasSignal: false, globalTime: globalTime });
    }
  }
}

export const PlaybackEngine = new EngineCore();
