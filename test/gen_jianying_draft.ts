import fs from 'fs';
import path from 'path';
import { JianyingExportService } from '../src/modules/export/jianying/backend/Service';

const dir = path.resolve(__dirname, 'fixtures/aug6_test_data');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'project_meta.json'), 'utf-8'));
const mr = JSON.parse(fs.readFileSync(path.join(dir, 'matchResults.json'), 'utf-8'));
const tt = JSON.parse(fs.readFileSync(path.join(dir, 'ttsResults.json'), 'utf-8'));
const sp = JSON.parse(fs.readFileSync(path.join(dir, 'scriptParagraphs.json'), 'utf-8'));

const bgmRelative = meta.mediaItems.find((m: any) => m.extractedBgm).extractedBgm;
const projectBase = 'F:/Tools/Zentect/data/projects/proj_1786021445479_kfwtnf';
const bgmPath = path.join(projectBase, bgmRelative).replace(/\\/g, '/');

const input = {
  projectId: meta.id,
  matchResults: mr,
  ttsResults: tt,
  scriptParagraphs: sp,
  bgmPath,
  mediaPath: meta.mediaItems[0].filePath,
  outputDir: meta.mediaItems[0].filePath,
};

// 输出到项目内的 exports 目录，方便用户手动复制到剪映草稿目录测试
const outDir = 'F:/Tools/Zentect/data/exports/jianying_test_aug6';
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

console.log('=== 剪映草稿导出测试 ===');
console.log('项目:', input.projectId);
console.log('视频源:', input.mediaPath);
console.log('BGM:', bgmPath);
console.log('文案段数:', sp.length);
console.log('镜头匹配数:', mr.length);
console.log('TTS结果数:', tt.length);
console.log('输出目录:', outDir);
console.log('');

JianyingExportService.export(input, outDir).then((result: any) => {
  console.log('=== 导出成功 ===');
  console.log('草稿文件夹:', result.filePath);
  console.log('草稿名称:', result.fileName);
  console.log('');
  console.log('文件列表:');
  const files = fs.readdirSync(result.filePath);
  for (const f of files) {
    const stat = fs.statSync(path.join(result.filePath, f));
    console.log(`  ${f}  (${(stat.size / 1024).toFixed(1)} KB)`);
  }
  console.log('');
  console.log('请将此文件夹复制到剪映草稿目录，然后打开剪映查看轨道是否正常显示。');
}).catch((err: any) => {
  console.error('=== 导出失败 ===');
  console.error(err.message);
  process.exit(1);
});
