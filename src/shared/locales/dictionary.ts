// 📁 路径: src/shared/locales/dictionary.ts
// 💥 工业级规范：全站共享业务字典 (SSOT)

export const DICT = {
  // 任务流转状态
  TASK_STATUS: {
    PENDING: 'pending',
    RUNNING: 'running',
    SUCCESS: 'success',
    FAILED: 'failed',
    COMPLETED: 'completed'
  },
  
  // 媒体资产类型
  MEDIA_TYPE: {
    VIDEO: 'video',
    AUDIO: 'audio',
    IMAGE: 'image'
  },

  // AI 算力节点状态
  AI_NODE_STATUS: {
    OFFLINE: 'offline',
    IDLE: 'idle',
    BUSY: 'busy'
  }
} as const;

export const ErrorConfig = {
  'BIZ_SAVE_SUCCESS': { level: 'success', notifyType: 'toast' },
  'BIZ_SAVE_FAILED': { level: 'error', notifyType: 'toast' },
  'BIZ_DELETE_SUCCESS': { level: 'success', notifyType: 'toast' },
  'BIZ_TRACK_EMPTY': { level: 'warn', notifyType: 'toast' },
  'BIZ_ROLE_UNSELECTED': { level: 'warn', notifyType: 'toast' },
  'BIZ_ROLE_MERGED': { level: 'success', notifyType: 'toast' },
  'BIZ_ROLE_UNMERGED': { level: 'success', notifyType: 'toast' },

  // 💥 项目业务错误
  'PROJECT_NAME_DUPLICATE': { level: 'error', notifyType: 'toast' },

  'TASK_EXPORT_START': { level: 'info', notifyType: 'toast' },
  'TASK_EXPORT_COMPILING': { level: 'info', notifyType: 'toast' },
  'TASK_EXPORT_SUCCESS': { level: 'success', notifyType: 'system' },
  'TASK_EXPORT_FAILED': { level: 'error', notifyType: 'toast' },
  'TASK_GENERATE_START': { level: 'info', notifyType: 'toast' },
  'TASK_GENERATE_SUCCESS': { level: 'success', notifyType: 'system' },
  'TASK_EXTRACT_START': { level: 'info', notifyType: 'toast' },
  'TASK_EXTRACT_COMPLETED': { level: 'success', notifyType: 'system' },
  'TASK_CANCELED': { level: 'warn', notifyType: 'toast' },
  'MEDIA_TYPE_UNSUPPORTED': { level: 'warn', notifyType: 'toast' },

  'AI_TTS_SUCCESS': { level: 'success', notifyType: 'toast' },
  'AI_TOKEN_EXHAUSTED': { level: 'error', notifyType: 'toast' },
  'AI_NETWORK_TIMEOUT': { level: 'error', notifyType: 'toast' },

  'MEDIA_FFMPEG_MISSING': { level: 'fatal', notifyType: 'modal' },

  'SYS_IPC_FAILED': { level: 'error', notifyType: 'toast' },
  'SYS_JIANYING_DIR_MISSING': { level: 'fatal', notifyType: 'modal' },
  'SYS_DISK_FULL': { level: 'error', notifyType: 'toast' },
  'SYS_MIGRATE_FAILED': { level: 'error', notifyType: 'toast' },

  'UNKNOWN_ERROR': { level: 'error', notifyType: 'toast' }
} as const;

export type ErrorCode = keyof typeof ErrorConfig;

export const Dictionary = {
  TASK_INIT: 'TASK_INIT',
  TASK_START: 'TASK_START',
  TASK_QUEUED: 'TASK_QUEUED',
  TASK_EXTRACT_FRAMES: 'TASK_EXTRACT_FRAMES',
  TASK_EXTRACT_AUDIO: 'TASK_EXTRACT_AUDIO',
  TASK_SEPARATE_AUDIO_MATRIX: 'TASK_SEPARATE_AUDIO_MATRIX',
  TASK_SCAN_FACES: 'TASK_SCAN_FACES',
  TASK_WHISPER: 'TASK_WHISPER',
  TASK_ALIGN: 'TASK_ALIGN',
  TASK_ASSEMBLE: 'TASK_ASSEMBLE',
  TASK_SUCCESS: 'TASK_SUCCESS',
  TASK_RETRY: 'TASK_RETRY',
  TASK_FAILED: 'TASK_FAILED',
} as const;

export type TaskCode = keyof typeof Dictionary;

// 💥 新增：引擎层状态码字典 (彻底干掉后端中文硬编码)
export const ENGINE_STATUS = {
  AI_MODEL_UNDEPLOYED: 'AI_MODEL_UNDEPLOYED',
  NO_LINES_DETECTED: 'NO_LINES_DETECTED',
  PURE_ENVIRONMENT_SOUND: 'PURE_ENVIRONMENT_SOUND',
  VISION_FAILED: 'VISION_FAILED',
  EMOTION_FAILED: 'EMOTION_FAILED',
  SILENCE: 'SILENCE'
} as const;

export interface AppDictionary {
  success?: {
    action_success?: string;
  };
  errors?: {
    action_failed?: string;
    validation_failed?: string;
  };
  nav?: {
    templates?: string;
    activities?: string;
  };
  common?: {
    coming_soon?: string;
    // 💥 补上缺失的 common 字段
    search?: string;
    import?: string;
    cancel?: string;
    confirm?: string;
    delete?: string;
    edit?: string;
    rename?: string;
  };
  editor?: {
    tab_media?: string;
    tab_storyboard?: string;
    tab_casting?: string;
    tab_audio?: string;
    tab_text?: string;
    tab_assets?: string;
    tab_narration?: string;
    prop_media?: string;
    prop_role?: string;
    prop_shot?: string;
    prop_global?: string;
    wait_state?: string;
    wait_desc?: string;
    
    unnamed_project?: string;
    engine_ai?: string;
    engine_phy?: string;
    signal_lost?: string;
    ratio_16_9?: string;
    ratio_9_16?: string;
    ratio_4_3?: string;
    ratio_1_1?: string;
    zoom_title?: string;
    zoom_fit?: string;
    zoom_fit_short?: string;
    zoom_100?: string;
    tooltip_ratio?: string;
    tooltip_zoom?: string;
    tooltip_fullscreen?: string;

    settings_title?: string;
    settings_ratio?: string;
    settings_ratio_desc1?: string;
    settings_ratio_desc2?: string;
    settings_ratio_desc3?: string;
    settings_ratio_desc4?: string;
    settings_magnet?: string;
    settings_magnet_desc?: string;
    settings_magnet_force?: string;
    settings_close?: string;
    settings_save?: string;

    seq_ai?: string;
    seq_phy?: string;
    tip_undo?: string;
    tip_redo?: string;
    tip_free_mode?: string;
    tip_razor?: string;
    tip_domino?: string;
    tip_magnet?: string;
    btn_dub_start?: string;
    btn_dub_doing?: string;
    btn_mode_revert?: string;
    btn_mode_overwrite?: string;
    msg_free_mode?: string;
    msg_domino_done?: string;
    msg_magnet_off?: string;
    msg_magnet_on?: string;
    msg_dub_no_need?: string;
    msg_dub_start?: string;
    msg_dub_done?: string;
    msg_ai_not_found?: string;
    msg_ai_enter?: string;
    msg_phy_enter?: string;
    [key: string]: any;
  };
  home?: {
    // 💥 补齐首页专属的业务黑话，保证 TS 绝对安全
    create_ai?: string;
    create_ai_slogan?: string;
    mode_video?: string;
    mode_video_sub?: string;
    mode_text?: string;
    mode_text_sub?: string;
    mode_batch?: string;
    mode_batch_sub?: string;
    drafts_title?: string;
    btn_import?: string;
    empty_search?: string;
    empty_data?: string;

    // [保留原有的弹窗报错字段]
    fetch_failed?: string;
    create_failed?: string;
    delete_title?: string;
    delete_confirm?: string;
    delete_warning?: string;
    delete_success?: string;
    delete_error?: string;
    duplicate_success?: string;
    duplicate_error?: string;
    rename_success?: string;
    rename_error?: string;
    default_project?: string;
    menu_rename?: string;
    menu_duplicate?: string;
    menu_delete?: string;
    no_cover?: string;
  };
  ai_tools: {
    // AIAssets 面板
    engine_running: string;
    vision_task: string;
    audio_task: string;
    stop: string;
    toolbox_title: string;
    standalone_write: string;
    standalone_dub: string;
    draft_placeholder: string;

    // AINarration 面板
    select_target_video: string;
    narration_notice: string;
    select_video_asset: string;
    core_config: string;
    api_key_placeholder: string;
    base_url_placeholder: string;
    model_placeholder: string;
    style_placeholder: string;
    style_suspense: string;
    style_humor: string;
    style_professional: string;
    style_healing: string;
    reasoning: string;
    generate_script: string;
    cached_script: (count: number) => string;
    hard_rendering: string;
    render_sync_video: string;

    // TextPool 面板
    input_cabin: string;
    clear: string;
    paste: string;
    input_placeholder: string;
    process_engine: string;
    select_task_type: string;
    task_rewrite: string;
    task_translate: string;
    task_polish: string;
    force_melt: string;
    ignition_run: string;
    output_array: string;
    copy_all: string;
    waiting_response: string;
  };
}

// 媒体类型支持列表
export const SUPPORTED_EXTENSIONS = {
  VIDEO: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
  AUDIO: ['mp3', 'wav', 'aac', 'm4a', 'flac'],
  IMAGE: ['jpg', 'jpeg', 'png', 'webp']
} as const;

// 提供一个聚合的快捷获取方法
export const ALL_MEDIA_EXTENSIONS = [
  ...SUPPORTED_EXTENSIONS.VIDEO,
  ...SUPPORTED_EXTENSIONS.AUDIO,
  ...SUPPORTED_EXTENSIONS.IMAGE
];
