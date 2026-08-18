// 新建文件: src/main/services/MusicLibraryService.ts
// 曲库抽象层：provider 接口 + 注册/注入机制 + 默认空实现（未接入外部曲库 API 时返回空结果）
// P1 阶段仅落地可插拔骨架，具体 provider（如 Openverse）按需接入。

import { OpenverseMusicProvider } from './OpenverseMusicProvider';
import { LocalMusicLibraryProvider } from './LocalMusicLibraryProvider';

/** 曲库曲目（真实曲库返回的元数据，字段以实际 provider 为准，接入时对齐） */
export interface MusicTrack {
  id: string;
  name: string;
  artist: string;
  bpm: number;
  durationMs: number;
  previewUrl: string;
  downloadUrl: string;
  tags: string[];
  license: string;
}

/** 曲库检索条件 */
export interface MusicLibraryQuery {
  /** 情绪/风格标签（逗号分隔或自由文本，由 provider 自行解释） */
  mood: string;
  /** 目标 BPM 区间下界 */
  bpmMin: number;
  /** 目标 BPM 区间上界 */
  bpmMax: number;
  /** 返回数量上限 */
  limit: number;
}

/** 曲库 provider 抽象接口：所有真实曲库接入必须实现 */
export interface MusicLibraryProvider {
  /** provider 唯一标识（注册键），如 'pixabay' */
  readonly name: string;
  /** 按情绪/BPM 检索真实曲目 */
  search(query: MusicLibraryQuery): Promise<MusicTrack[]>;
  /** 获取曲目下载地址（供前端「一键应用」下载到本地） */
  getDownloadUrl(id: string): Promise<string>;
  /** 返回 provider 全量曲目（供前端分类分页自选）；不支持时返回空数组 */
  listAll?(): MusicTrack[];
}

/** 默认空 provider：未接入任何曲库时返回空结果，触发上层降级纯生成 */
class EmptyMusicLibraryProvider implements MusicLibraryProvider {
  readonly name = 'empty';
  async search(_query: MusicLibraryQuery): Promise<MusicTrack[]> {
    return [];
  }
  async getDownloadUrl(_id: string): Promise<string> {
    return '';
  }
}

/** 曲库服务：provider 注册与注入 */
class MusicLibraryService {
  private providers = new Map<string, MusicLibraryProvider>();
  private activeProviderName = 'empty';

  constructor() {
    this.register(new EmptyMusicLibraryProvider());
    // 本地预置曲库：默认激活（零网络零 key，曲目随项目分发）
    this.register(new LocalMusicLibraryProvider());
    // Openverse 免费商用曲库：注册为可选远端增强（默认不激活）
    this.register(new OpenverseMusicProvider());
    this.setActive('local');
  }

  /** 注册 provider（后注册同名会覆盖，用于接入真实曲库或测试桩） */
  register(provider: MusicLibraryProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** 切换当前生效 provider；不存在返回 false */
  setActive(name: string): boolean {
    if (!this.providers.has(name)) return false;
    this.activeProviderName = name;
    return true;
  }

  /** 当前生效 provider */
  getActive(): MusicLibraryProvider {
    return this.providers.get(this.activeProviderName) ?? this.providers.get('empty')!;
  }

  /** 委托检索 */
  async search(query: MusicLibraryQuery): Promise<MusicTrack[]> {
    return this.getActive().search(query);
  }

  /** 委托获取下载地址 */
  async getDownloadUrl(id: string): Promise<string> {
    return this.getActive().getDownloadUrl(id);
  }

  /** 委托获取全量曲目（当前 provider 不支持时返回空数组） */
  listAll(): MusicTrack[] {
    const provider = this.getActive();
    return provider.listAll ? provider.listAll() : [];
  }
}

export const musicLibraryService = new MusicLibraryService();
