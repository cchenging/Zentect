import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JianyingExportService } from '../backend/Service';

const FIXTURE_DIR = path.resolve(process.cwd(), 'test/fixtures/aug6_test_data');

describe('Generate real draft for JianYing', () => {
  it('应生成含真实轨道数据的草稿文件', async () => {
    const meta = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'project_meta.json'), 'utf-8'));
    const matchResults = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'matchResults.json'), 'utf-8'));
    const ttsResults = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'ttsResults.json'), 'utf-8'));
    const scriptParagraphs = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'scriptParagraphs.json'), 'utf-8'));

    // ✅ 身份键统一：fixture 为 legacy 快照（产物只有 shotId），复刻装配器 hydrate 点归一 id
    const matchByIdData = matchResults.map((m: any) => m && m.id ? m : { ...m, id: m?.shotId });
    const ttsByIdData = ttsResults.map((t: any) => t && t.id ? t : { ...t, id: t?.shotId });

    const bgmRelative = meta.mediaItems.find((m: any) => m.extractedBgm).extractedBgm;
    const projectBase = 'F:/Tools/Zentect/data/projects/proj_1786021445479_kfwtnf';
    const bgmPath = path.join(projectBase, bgmRelative).replace(/\\/g, '/');
    const mediaPath = meta.mediaItems[0].filePath;

    // 用 scriptParagraphs 作为主遍历源（与实际管线产出一致）
    // ✅ 身份键统一：matchResults/ttsResults 主键为 id（=段落主键），索引一律按 id 关联
    const matchById = new Map<string, any>(matchByIdData.map((m: any) => [m.id, m]));
    const ttsById = new Map<string, any>(ttsByIdData.map((t: any) => [t.id, t]));

    const compileShots = scriptParagraphs.map((p: any) => {
      const m = matchById.get(p.id);
      const t = ttsById.get(p.id);
      const durationSec = (t?.duration && !t._failed ? t.duration : 0) || p.duration || 3;
      return {
        id: p.id,
        mediaId: m?.mediaId || '',
        imagePath: m?.thumbnail || '',
        text: p.text || '',
        originalText: p.text || '',
        aiText: p.text || '',
        start: 0,
        end: durationSec,
        duration: durationSec,
        audioDuration: durationSec,
        audioPath: t?.audioUrl && !t._failed ? t.audioUrl : undefined,
        chunkData: m?.chunkData || null,
        appliedSpeedFactor: m?.appliedSpeedFactor,
        videoTimelineStartMs: m?.videoTimelineStartMs,
        videoTimelineEndMs: m?.videoTimelineEndMs,
      };
    });

    console.log('\n=== 编译数据 ===');
    console.log('compileShots:', compileShots.length);
    console.log('有视频切片:', compileShots.filter(s => s.chunkData).length);
    console.log('有TTS音频:', compileShots.filter(s => s.audioPath).length);

    const draft = JianyingExportService.compileDraft(compileShots as any, mediaPath, bgmPath) as any;

    console.log('\n=== 草稿结构 ===');
    console.log('tracks:', draft.tracks.length);
    console.log('video segments:', draft.tracks[0].segments.length);
    console.log('bgm segments:', draft.tracks[1].segments.length);
    console.log('tts segments:', draft.tracks[2].segments.length);
    console.log('text segments:', draft.tracks[3].segments.length);
    console.log('duration (us):', draft.duration);
    console.log('materials.videos:', draft.materials.videos.length);
    console.log('materials.audios:', draft.materials.audios.length);
    console.log('materials.texts:', draft.materials.texts.length);

    // 写入真实文件到磁盘
    const outDir = 'F:/Tools/Zentect/data/exports/jianying_test_aug6/Zentect_RealTest_' + Date.now();
    fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(path.join(outDir, 'draft_content.json'), JSON.stringify(draft, null, 2));

    // 生成 draft_meta_info.json
    const draftId = draft.id;
    const metaInfo = {
      draft_cover: '',
      draft_fold_path: outDir.replace(/\\/g, '/'),
      draft_id: draftId,
      draft_name: path.basename(outDir),
      draft_new_version: '',
      draft_root_path: 'F:/Tools/Zentect/data/exports/jianying_test_aug6',
      draft_type: '',
      tm_draft_create: Date.now() * 1000,
      tm_draft_modified: Date.now() * 1000,
      tm_draft_removed: 0,
      tm_duration: 0,
      draft_materials: [],
      draft_materials_copied_info: [],
      draft_segment_extra_info: [],
      draft_timeline_materials_size_: 0,
      draft_enterprise_info: {
        draft_enterprise_extra: '',
        draft_enterprise_id: '',
        draft_enterprise_name: '',
        enterprise_material: [],
      },
      draft_cloud_capcut_purchase_info: '',
      draft_cloud_last_action_download: false,
      draft_cloud_materials: [],
      draft_cloud_purchase_info: '',
      draft_cloud_template_id: '',
      draft_cloud_tutorial_info: '',
      draft_cloud_videocut_purchase_info: '',
      draft_deeplink_url: '',
      draft_is_ai_packaging_used: false,
      draft_is_ai_shorts: false,
      draft_is_ai_translate: false,
      draft_is_article_video_draft: false,
      draft_is_from_deeplink: 'false',
      draft_is_invisible: false,
      draft_removable_storage_device: '',
      cloud_package_completed_time: '',
      tm_draft_cloud_completed: '',
      tm_draft_cloud_modified: 0,
    };
    fs.writeFileSync(path.join(outDir, 'draft_meta_info.json'), JSON.stringify(metaInfo, null, 2));

    // 生成 draft_meta.json
    fs.writeFileSync(path.join(outDir, 'draft_meta.json'), JSON.stringify({
      draft_name: path.basename(outDir),
      draft_id: draftId,
      draft_type: 'short_video',
    }, null, 2));

    console.log('\n=== 文件已生成 ===');
    console.log('草稿文件夹:', outDir);
    const files = fs.readdirSync(outDir);
    for (const f of files) {
      const stat = fs.statSync(path.join(outDir, f));
      console.log(`  ${f}  (${(stat.size / 1024).toFixed(1)} KB)`);
    }

    console.log('\n=== 测试步骤 ===');
    console.log('1. 将此文件夹复制到剪映草稿目录:');
    console.log('   C:\\Users\\chengcheng\\AppData\\Local\\JianyingPro\\User Data\\Projects\\com.lveditor.draft\\');
    console.log('2. 打开剪映，查看草稿列表');
    console.log('3. 打开草稿，检查视频/BGM/TTS/字幕 4 条轨道是否正常显示');

    expect(draft.tracks[0].segments.length).toBe(26);
    expect(draft.tracks[2].segments.length).toBe(26);
    expect(draft.tracks[3].segments.length).toBe(26);
  }, 30000);
});
