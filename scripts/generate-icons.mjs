/**
 * 从 assets/icon.svg 生成各平台的图标文件。
 * - icon.png  512x512   (electron-builder 用，自动派生各平台格式)
 * - icon.ico             (Windows，含多尺寸)
 *
 * 用法：node scripts/generate-icons.mjs
 */
import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const svgPath = resolve(root, 'assets/icon.svg');
const pngPath = resolve(root, 'assets/icon.png');

async function main() {
  console.log('Generating icons from', svgPath);

  // 生成 512x512 PNG（electron-builder 会据此自动生成 .icns / .ico）
  await sharp(svgPath)
    .resize(512, 512)
    .png()
    .toFile(pngPath);

  console.log('  ✓', pngPath);

  // 生成 256x256 PNG 作为备用
  await sharp(svgPath)
    .resize(256, 256)
    .png()
    .toFile(resolve(root, 'assets/icon-256.png'));

  console.log('  ✓', 'assets/icon-256.png');
  console.log('Done.');
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
