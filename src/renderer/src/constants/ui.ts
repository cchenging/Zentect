export const UI_CONFIG = {
  TOPBAR_HEIGHT: 40,
  TOPBAR_HEIGHT_CLASS: 'h-[40px]',

  ICON_BTN_SIZE: 'w-[30px] h-[30px]',
  ICON_SIZE: 16,

  PADDING_BASE: 'p-2',
  GAP_BASE: 'gap-2',

  SIDEBAR_WIDTH_HOME: 210,
  SIDEBAR_WIDTH_EDITOR_COLLAPSED: 64,
  SIDEBAR_WIDTH_EDITOR_EXPANDED: 340,
};

export const UI_CONSTANTS = {
  COLORS: {
    BACKGROUND: {
      DARK: '#18181b', 
      DEEP: '#09090b', 
    },
    TEXT: {
      PRIMARY: '#ffffff',
      MUTED: 'rgba(255,255,255,0.7)',
    },
    STATUS: {
      SUCCESS: '#10b981', 
      ERROR: '#ef4444',   
      WARNING: '#f59e0b', 
      INFO: '#3b82f6',    
    },
    BORDER: {
      DEFAULT: 'rgba(255,255,255,0.1)',
    }
  },
  DURATION: {
    TOAST_SHORT: 2000,
    TOAST_NORMAL: 3000,
    TOAST_LONG: 4000,
    DEBOUNCE_INPUT: 300,
  },
  Z_INDEX: {
    BASE: 1,
    DROPDOWN: 100,
    STICKY: 200,
    MODAL_BACKDROP: 900,
    MODAL: 1000,
    TOAST: 9999, 
  }
} as const;