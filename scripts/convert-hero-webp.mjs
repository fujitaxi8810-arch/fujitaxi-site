import sharp from 'sharp';
import { readdir } from 'fs/promises';
import path from 'path';

const uploadsDir = 'public/images/uploads';

const heroImages = [
  { src: '65333_0.jpg',       dest: 'hero-spring-river.webp' },
  { src: '65335_0.jpg',       dest: 'hero-taxi-minamisoma.webp' },
  { src: '65330_0.jpg',       dest: 'hero-taxi-sunset.webp' },
  { src: 'S__2122825730.jpg', dest: 'hero-next-generation.webp' },
];

for (const { src, dest } of heroImages) {
  const srcPath = `${uploadsDir}/${src}`;
  const destPath = `${uploadsDir}/${dest}`;
  const info = await sharp(srcPath)
    .webp({ quality: 82 })
    .toFile(destPath);
  const meta = await sharp(srcPath).metadata();
  console.log(`✅ ${dest}  ${meta.width}x${meta.height}  ${(info.size/1024).toFixed(0)}KB`);
}
