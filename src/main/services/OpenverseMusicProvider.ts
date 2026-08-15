// 新建文件: src/main/services/OpenverseMusicProvider.ts
// Openverse 曲库 provider：调用 Openverse Audio API 检索免费商用音乐
// 许可过滤固定为 CC0 / PDM / CC-BY，category=music；无需 API key。
// 实测 API 结构：{ result_count, results: [{ id, title, creator, url, license, duration, tags, genres, ... }] }

import type { MusicLibraryProvider, MusicLibraryQuery, MusicTrack } from './MusicLibraryService';

const OPENVERSE_AUDIO_API = 'https://api.openverse.org/v1/audio/';
const LICENSE_FILTER = 'cc0,pdm,by';
const REQUEST_TIMEOUT_MS = 15000;
const RATE_LIMIT_RETRY_DELAY_MS = 3000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class OpenverseMusicProvider implements MusicLibraryProvider {
  readonly name = 'openverse';

  /** search 命中的 id → 音频直链缓存，供 getDownloadUrl 回读 */
  private urlCache = new Map<string, string>();

  async search(query: MusicLibraryQuery): Promise<MusicTrack[]> {
    let res = await this.request(query);
    if (res.status === 429) {
      // 限流：等待 3 秒后重试一次
      await sleep(RATE_LIMIT_RETRY_DELAY_MS);
      res = await this.request(query);
    }
    if (!res.ok) {
      throw new Error(`Openverse 检索失败：HTTP ${res.status}`);
    }
    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new Error('Openverse 响应不是有效 JSON');
    }
    const results = Array.isArray(json?.results) ? json.results : [];
    const tracks: MusicTrack[] = [];
    for (const r of results) {
      const track = this.mapTrack(r);
      if (track) {
        tracks.push(track);
        this.urlCache.set(track.id, track.downloadUrl);
      }
    }
    return tracks;
  }

  async getDownloadUrl(id: string): Promise<string> {
    return this.urlCache.get(id) || '';
  }

  private async request(query: MusicLibraryQuery): Promise<Response> {
    const endpoint = new URL(OPENVERSE_AUDIO_API);
    const mood = (query.mood || '').trim();
    if (mood) endpoint.searchParams.set('q', mood);
    endpoint.searchParams.set('license', LICENSE_FILTER);
    endpoint.searchParams.set('category', 'music');
    const pageSize = Math.min(Math.max(query.limit || 10, 1), 50);
    endpoint.searchParams.set('page_size', String(pageSize));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(endpoint.toString(), { method: 'GET', signal: controller.signal });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('Openverse 请求超时（15s）');
      throw new Error(`Openverse 网络请求失败：${e?.message || e}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private mapTrack(r: any): MusicTrack | null {
    const id = String(r?.id || '').trim();
    const name = String(r?.title || '').trim();
    const audioUrl = String(r?.url || '').trim();
    if (!id || !name || !audioUrl) return null;

    const tags: string[] = [];
    if (Array.isArray(r?.tags)) {
      for (const t of r.tags) {
        const tagName = String(t?.name || '').trim();
        if (tagName) tags.push(tagName);
      }
    }
    if (tags.length === 0 && Array.isArray(r?.genres)) {
      for (const g of r.genres) {
        const genreName = String(g || '').trim();
        if (genreName) tags.push(genreName);
      }
    }

    return {
      id,
      name,
      artist: String(r?.creator || '').trim() || '未知艺术家',
      bpm: 0, // Openverse 无 BPM 字段，占位 0
      durationMs: typeof r?.duration === 'number' ? r.duration : 0,
      previewUrl: audioUrl,
      downloadUrl: audioUrl,
      tags,
      license: String(r?.license || '').trim(),
    };
  }
}
