import sharp from 'sharp';
import { writeFileSync } from 'fs';

const targets = [
  ['public/images/uploads/392DA0C0-3061-4179-9B33-6A0D7F036BA3.webp', 1400],
  ['public/images/uploads/C2E3BFF4-7701-45D1-A665-2161D7214851.webp', 1400],
  ['public/images/uploads/DD751775-DE2D-4373-B1EF-ECCA2A69D09C.webp', 1400],
  ['public/images/photo-children-sakura.webp', 1200],
  ['public/images/photo-staff-exterior.webp', 1200],
  ['public/images/photo-cars-lineup.webp', 1200],
  ['public/images/photo-car-odaka.webp', 1200],
  ['public/images/photo-haramachi-exterior.webp', 1200],
  ['public/images/photo-honsha-exterior.webp', 1200],
];

for (const [rel, maxW] of targets) {
  const out = rel.replace('.webp', '-opt.webp');
  const info = await sharp(rel)
    .resize(maxW, null, { withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(out);
  console.log(`DONE ${rel.split('/').pop()} -> ${Math.round(info.size/1024)}KB :: ${out}`);
}
