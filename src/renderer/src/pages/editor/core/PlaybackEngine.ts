// PlaybackEngine - compatibility stub
// Provides static togglePlay() that delegates to the editor store

import { useEditorStore } from '../../../store/useStore';

export const PlaybackEngine = {
  togglePlay(): void {
    const state = useEditorStore.getState();
    state.setIsPlaying(!state.isPlaying);
  }
};
