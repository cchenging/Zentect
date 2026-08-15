// 本地预置曲库 provider：曲目文件与索引随项目分发（resources/bgm-library/）
// 零网络、零 API key、零代理，命中稳定。
// 许可：CC-BY 4.0（Kevin MacLeod / incompetech.com），免费商用需署名。

import * as fs from 'fs';
import * as path from 'path';
import { PathManager } from '../utils/pathManager';
import type { MusicLibraryProvider, MusicLibraryQuery, MusicTrack } from './MusicLibraryService';

/** 索引条目（index.json 结构） */
interface LocalTrackEntry {
  id: string;
  name: string;
  artist: string;
  bpm: number;
  durationMs: number;
  feel: string[];
  tone: string;
  relativePath: string;
  license: string;
  attribution: string;
  source: string;
}

/** 中文情绪词 → 本地曲库 tone 枚举（LLM 输出的中文标签映射） */
const MOOD_TO_TONE: Record<string, string> = {
  // suspense
  '悬疑': 'suspense', '紧张': 'suspense', '诡异': 'suspense', '恐怖': 'suspense',
  '惊悚': 'suspense', '神秘': 'suspense', '阴森': 'suspense', '压抑': 'suspense',
  // epic
  '史诗': 'epic', '激昂': 'epic', '宏大': 'epic', '热血': 'epic', '震撼': 'epic',
  '战斗': 'epic', '壮阔': 'epic', '激烈': 'epic', '磅礴': 'epic',
  // comedy
  '欢快': 'comedy', '轻松': 'comedy', '幽默': 'comedy', '活泼': 'comedy',
  '俏皮': 'comedy', '明快': 'comedy', '诙谐': 'comedy', '滑稽': 'comedy',
  // emotional
  '温馨': 'emotional', '感人': 'emotional', '温情': 'emotional', '悲伤': 'emotional',
  '深情': 'emotional', '治愈': 'emotional', '抒情': 'emotional', '动人': 'emotional',
  // neutral
  '舒缓': 'neutral', '平静': 'neutral', '中性': 'neutral', '日常': 'neutral',
  '宁静': 'neutral', '柔和': 'neutral', '平和': 'neutral', '安稳': 'neutral',
};

const TONE_ENUMS = new Set(['neutral', 'emotional', 'suspense', 'epic', 'comedy']);

export class LocalMusicLibraryProvider implements MusicLibraryProvider {
  readonly name = 'local';

  /** 内部条目（含 tone，用于匹配）；对外转 MusicTrack（tags = feel + tone） */
  private entries: LocalTrackEntry[] = [];
  private byId = new Map<string, MusicTrack>();
  private loaded = false;

  /** 惰性加载索引：首次 search/getDownloadUrl 时读取并缓存 */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const libraryRoot = path.join(PathManager.getResourcesPath(), 'bgm-library');
      const indexPath = path.join(libraryRoot, 'index.json');
      if (!fs.existsSync(indexPath)) return;

      const raw = fs.readFileSync(indexPath, 'utf-8');
      const index = JSON.parse(raw);
      const rawTracks: LocalTrackEntry[] = Array.isArray(index?.tracks) ? index.tracks : [];

      const tracks: LocalTrackEntry[] = [];
      for (const e of rawTracks) {
        const abs = path.join(libraryRoot, e.relativePath || '');
        if (!fs.existsSync(abs)) continue; // 索引指向的文件缺失则跳过
        tracks.push(e);
        this.byId.set(e.id, this.toTrack(e, abs));
      }
      this.entries = tracks;
    } catch {
      // 索引缺失/损坏时降级为空曲库，交由上层处理
      this.entries = [];
      this.byId.clear();
    }
  }

  private toTrack(e: LocalTrackEntry, absPath: string): MusicTrack {
    return {
      id: e.id,
      name: e.name,
      artist: e.artist,
      bpm: e.bpm,
      durationMs: e.durationMs,
      previewUrl: absPath,
      downloadUrl: absPath,
      tags: Array.from(new Set([...(e.feel || []), e.tone])),
      license: e.license,
    };
  }

  async search(query: MusicLibraryQuery): Promise<MusicTrack[]> {
    this.ensureLoaded();
    if (this.entries.length === 0) return [];

    const mood = (query.mood || '').trim();
    const bpmMin = Number(query.bpmMin) || 0;
    const bpmMax = Number(query.bpmMax) || 0;
    const limit = Math.max(Number(query.limit) || 5, 1);

    // 1. 解析目标 tone 集合：emotionTone 枚举 + 中文情绪词映射
    const targetTones = new Set<string>();
    for (const token of mood.split(/[,，、\s]+/)) {
      const t = token.trim();
      if (!t) continue;
      const lower = t.toLowerCase();
      if (TONE_ENUMS.has(lower)) targetTones.add(lower);
      else if (MOOD_TO_TONE[t]) targetTones.add(MOOD_TO_TONE[t]);
    }

    // 2. 评分：tone 命中权重最高，feel 子串命中次之
    const moodLower = mood.toLowerCase();
    const scored = this.entries.map((e) => {
      let score = 0;
      if (targetTones.size > 0 && targetTones.has(e.tone)) score += 100;
      for (const f of e.feel) {
        if (moodLower.includes(f.toLowerCase())) score += 5;
      }
      return { e, score };
    });

    // 3. BPM 区间过滤：区间内优先；若区间内为空则忽略过滤（保证有结果）
    let inRange = scored;
    if (bpmMin > 0 && bpmMax > 0) {
      const filtered = scored.filter((s) => s.e.bpm >= bpmMin && s.e.bpm <= bpmMax);
      if (filtered.length > 0) inRange = filtered;
    }

    // 4. 排序：tone 命中 > feel 命中 > bpm 与目标区间中点距离
    const mid = bpmMin > 0 && bpmMax > 0 ? (bpmMin + bpmMax) / 2 : 100;
    inRange.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Math.abs(a.e.bpm - mid) - Math.abs(b.e.bpm - mid);
    });

    const libraryRoot = path.join(PathManager.getResourcesPath(), 'bgm-library');
    return inRange.slice(0, limit).map((s) =>
      this.toTrack(s.e, path.join(libraryRoot, s.e.relativePath)),
    );
  }

  async getDownloadUrl(id: string): Promise<string> {
    this.ensureLoaded();
    return this.byId.get(id)?.downloadUrl || '';
  }
}
