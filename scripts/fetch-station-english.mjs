// 駅の英語名（OpenStreetMap の name:en）を取得し、data/osm/station-en.json に { 駅名: 英語名 } で書き出す。
// 高速道路の方面看板（build-expressway-signs.mjs）の地名の英語に使う。
// 使い方: node scripts/fetch-station-english.mjs（REGION= で地域）
// データ: © OpenStreetMap contributors (ODbL)
import { writeFile } from 'node:fs/promises';
import { BBOX, regionPath } from './lib/region.mjs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const query = `[out:json][timeout:180];
  (node["railway"~"^(station|halt)$"]["name:en"](${BBOX});
   node["public_transport"="station"]["name:en"](${BBOX}););
  out tags;`;

let elements = null;
for (let attempt = 0; attempt < 10 && !elements; attempt++) {
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': 'sky-drive-dev/0.1 (station english script)' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(200000),
      });
      if (res.ok) {
        elements = (await res.json()).elements;
        break;
      }
      console.warn(`${endpoint} → ${res.status}`);
    } catch (e) {
      console.warn(`${endpoint} → ${e.message}`);
    }
  }
  if (!elements) await new Promise((r) => setTimeout(r, 20000));
}
if (!elements) throw new Error('Overpass API から取得できませんでした');

const out = {};
for (const e of elements) {
  const t = e.tags ?? {};
  const name = (t['name:ja'] ?? t.name ?? '').replace(/駅$/, '');
  const en = (t['name:en'] ?? '').replace(/\s*Station$/i, '').trim();
  if (name && en && !out[name]) out[name] = en;
}
await writeFile(regionPath('data/osm/station-en.json'), JSON.stringify(out, null, 0) + '\n');
console.log(`駅の英語名 ${Object.keys(out).length}`);
