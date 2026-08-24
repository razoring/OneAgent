// Bridge between ChatArea state and the app TitleBar. ChatArea publishes the
// active chat's title + available actions; TitleBar subscribes and renders them
// centered in the drag region.
export interface TitleBarState {
  title: string | null;
  canReturn: boolean;
  onReturn?: () => void;
  showTranscript: boolean;
  onDownloadTranscript?: () => void;
  showSettings: boolean;
  onToggleSettings?: () => void;
}

let state: TitleBarState = {
  title: null,
  canReturn: false,
  showTranscript: false,
  showSettings: false,
};

const listeners = new Set<(s: TitleBarState) => void>();

export const titleBarBridge = {
  get: (): TitleBarState => state,
  set: (patch: Partial<TitleBarState>) => {
    state = { ...state, ...patch };
    listeners.forEach(l => l(state));
  },
  subscribe: (l: (s: TitleBarState) => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};
