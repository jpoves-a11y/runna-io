// Copies out/<id>.png into the app's asset catalog as power_<id>.imageset (384 px).
// Needs Playwright's Chromium for render.js; uses `sips` (macOS) or ImageMagick to resize if present,
// otherwise copies the 512 px render as is.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const assets = path.join(__dirname, '../../ios/Kaemedos/Assets.xcassets');
for (const file of fs.readdirSync(path.join(__dirname, 'out')).filter(f => f.endsWith('.png'))) {
  const id = path.basename(file, '.png');
  const dir = path.join(assets, `power_${id}.imageset`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `power_${id}.png`);
  const source = path.join(__dirname, 'out', file);
  try {
    execSync(`sips -Z 384 "${source}" --out "${target}"`, { stdio: 'ignore' });
  } catch {
    try { execSync(`convert "${source}" -resize 384x384 "${target}"`, { stdio: 'ignore' }); } catch { fs.copyFileSync(source, target); }
  }
  fs.writeFileSync(path.join(dir, 'Contents.json'), JSON.stringify({ images: [{ filename: `power_${id}.png`, idiom: 'universal' }], info: { author: 'xcode', version: 1 } }, null, 2) + '\n');
  console.log('installed', id);
}
