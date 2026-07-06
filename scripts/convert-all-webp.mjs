import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { readdirSync, statSync } from 'fs';

function globSync(dir, ext) {
  const results = [];
  for (const f of readdirSync(dir, { recursive: true })) {
    if (ext.some(e => f.endsWith(e))) results.push(`${dir}/${f}`);
  }
  return results;
}
import path from 'path';

const base = 'C:/Users/hayat/fujitaxi-site';

// 変換対象JPG（実際に使用中のもの）
const targets = [
  'public/images/LINE_ALBUM_SNS素材_260626_4.jpg',
  'public/images/LINE_ALBUM_SNS素材_260626_57.jpg',
  'public/images/LINE_ALBUM_SNS素材_260626_7.jpg',
  'public/images/LINE_ALBUM_SNS素材_260626_9.jpg',
  'public/images/logo-fuji-taxi.jpg',
  'public/images/photo-car-odaka.jpg',
  'public/images/photo-cars-lineup.jpg',
  'public/images/photo-children-sakura.jpg',
  'public/images/photo-haramachi-exterior.jpg',
  'public/images/photo-honsha-exterior.jpg',
  'public/images/photo-staff-exterior.jpg',
  'public/images/uploads/392DA0C0-3061-4179-9B33-6A0D7F036BA3.jpg',
  'public/images/uploads/C2E3BFF4-7701-45D1-A665-2161D7214851.jpg',
  'public/images/uploads/DD751775-DE2D-4373-B1EF-ECCA2A69D09C.jpg',
  'public/images/uploads/S__2114043911_0.jpg',
  'public/images/uploads/LINE_ALBUM_SNS素材_260626_57.jpg',
];

const replacements = [];

for (const rel of targets) {
  const src = `${base}/${rel}`;
  if (!existsSync(src)) { console.log(`⚠️  skip (not found): ${rel}`); continue; }
  const dest = src.replace(/\.(jpg|jpeg|png)$/i, '.webp');
  const relDest = rel.replace(/\.(jpg|jpeg|png)$/i, '.webp');
  const info = await sharp(src).webp({ quality: 82 }).toFile(dest);
  const meta = await sharp(src).metadata();
  const origSize = readFileSync(src).length;
  const saved = Math.round((1 - info.size / origSize) * 100);
  console.log(`✅ ${path.basename(relDest)}  ${meta.width}x${meta.height}  ${Math.round(info.size/1024)}KB (-${saved}%)`);
  replacements.push({ from: rel.replace('public',''), to: relDest.replace('public','') });
}

// ソースコードの参照を一括更新
const srcFiles = globSync(`${base}/src`, ['.astro', '.ts', '.tsx', '.css', '.js']);
let totalReplaced = 0;

for (const file of srcFiles) {
  let content = readFileSync(file, 'utf8');
  let changed = false;
  for (const { from, to } of replacements) {
    if (content.includes(from)) {
      content = content.replaceAll(from, to);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(file, content, 'utf8');
    console.log(`📝 updated: ${file.replace(base+'/', '')}`);
    totalReplaced++;
  }
}

console.log(`\n🎉 完了: ${replacements.length}枚変換, ${totalReplaced}ファイル更新`);
