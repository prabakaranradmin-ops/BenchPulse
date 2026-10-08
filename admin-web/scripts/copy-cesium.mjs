// CesiumJS loads its web workers, textures and widget CSS at runtime from CESIUM_BASE_URL, so
// those files have to be served next to the app. Copying them into public/ lets Vite serve them
// in dev and ship them in the build — without a copy plugin (and its dependency tree).
import { cpSync, existsSync, rmSync } from 'node:fs';

const source = 'node_modules/cesium/Build/Cesium';
const target = 'public/cesium';

if (!existsSync(source)) {
  console.error(`${source} not found — run npm install first.`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
for (const folder of ['Workers', 'ThirdParty', 'Assets', 'Widgets']) {
  cpSync(`${source}/${folder}`, `${target}/${folder}`, { recursive: true });
}
console.log(`Copied Cesium runtime assets to ${target}/`);
