const { mkdirSync, existsSync, copyFileSync } = require('node:fs');
const { cp, rm } = require('node:fs/promises');
const path = require('node:path');
const { Jimp, rgbaToInt } = require('jimp');

const PROJECT_ROOT = process.cwd();
const SOURCE_ASSET_DIR = path.join(PROJECT_ROOT, 'src', 'ui', 'assets');
const DIST_ASSET_DIR = path.join(PROJECT_ROOT, 'dist', 'ui', 'assets');

async function main() {
  await generateTrayIcons();
  await copyAssetsToDist();
}

async function generateTrayIcons() {
  mkdirSync(SOURCE_ASSET_DIR, { recursive: true });

  const rasterSizes = [16, 32];

  for (const size of rasterSizes) {
    const standardIcon = await createTrayIcon(size, false);
    const templateIcon = await createTrayIcon(size, true);

    await standardIcon.write(path.join(SOURCE_ASSET_DIR, `tray-icon-${size}.png`));
    await templateIcon.write(path.join(SOURCE_ASSET_DIR, `tray-iconTemplate-${size}.png`));
  }

  copyFileSync(
    path.join(SOURCE_ASSET_DIR, 'tray-icon-32.png'),
    path.join(SOURCE_ASSET_DIR, 'tray-icon.png'),
  );
  copyFileSync(
    path.join(SOURCE_ASSET_DIR, 'tray-iconTemplate-32.png'),
    path.join(SOURCE_ASSET_DIR, 'tray-iconTemplate.png'),
  );
}

async function createTrayIcon(size, template) {
  const image = new Jimp({
    width: size,
    height: size,
    color: rgbaToInt(0, 0, 0, 0),
  });
  const scale = size / 32;
  const bodyColor = template
    ? rgbaToInt(255, 255, 255, 235)
    : rgbaToInt(35, 46, 62, 255);
  const accentColor = template
    ? rgbaToInt(255, 255, 255, 255)
    : rgbaToInt(244, 247, 251, 255);
  const shadowColor = template
    ? rgbaToInt(255, 255, 255, 130)
    : rgbaToInt(14, 20, 29, 150);

  fillRoundedRect(
    image,
    Math.round(3 * scale),
    Math.round(7 * scale),
    Math.round(26 * scale),
    Math.round(17 * scale),
    Math.max(3, Math.round(8 * scale)),
    bodyColor,
  );
  fillCircle(
    image,
    Math.round(11 * scale),
    Math.round(16 * scale),
    Math.max(2, Math.round(3 * scale)),
    accentColor,
  );
  fillRoundedRect(
    image,
    Math.round(15 * scale),
    Math.round(13 * scale),
    Math.round(7 * scale),
    Math.round(5 * scale),
    Math.max(2, Math.round(2 * scale)),
    accentColor,
  );
  if (!template) {
    fillRoundedRect(
      image,
      Math.round(5 * scale),
      Math.round(22 * scale),
      Math.round(22 * scale),
      Math.max(1, Math.round(2 * scale)),
      1,
      shadowColor,
    );
  }

  return image;
}

function fillRoundedRect(image, x, y, width, height, radius, color) {
  const xEnd = x + width;
  const yEnd = y + height;

  for (let px = x; px < xEnd; px += 1) {
    for (let py = y; py < yEnd; py += 1) {
      const dx = px < x + radius
        ? x + radius - px
        : px >= xEnd - radius
          ? px - (xEnd - radius - 1)
          : 0;
      const dy = py < y + radius
        ? y + radius - py
        : py >= yEnd - radius
          ? py - (yEnd - radius - 1)
          : 0;

      if (dx * dx + dy * dy <= radius * radius) {
        image.setPixelColor(color, px, py);
      }
    }
  }
}

function fillCircle(image, centerX, centerY, radius, color) {
  for (let x = centerX - radius; x <= centerX + radius; x += 1) {
    for (let y = centerY - radius; y <= centerY + radius; y += 1) {
      const dx = x - centerX;
      const dy = y - centerY;

      if (dx * dx + dy * dy <= radius * radius) {
        image.setPixelColor(color, x, y);
      }
    }
  }
}

async function copyAssetsToDist() {
  if (existsSync(DIST_ASSET_DIR)) {
    await rm(DIST_ASSET_DIR, { recursive: true, force: true });
  }

  await cp(SOURCE_ASSET_DIR, DIST_ASSET_DIR, { recursive: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Asset build failed');
  process.exit(1);
});
