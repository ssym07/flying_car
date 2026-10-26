// 東京23区まわりの高速道路（首都高・湾岸線・外環道など。本線と連絡路）を OpenStreetMap (Overpass API) から取得し、
// data/osm/expressways.json に書き出す（元データ）。トンネル区間は除く。
// ゲームで使う形（高さ付き・タイル分け）は scripts/build-expressways.mjs で作る。
// 使い方: node scripts/fetch-expressways.mjs [南,西,北,東] [分割数]
//   取得した区画は data/cache/expressways に保存し、途中で止まっても次はその続きから取得する
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力の形式: [[連絡路(0/1), 高架(0/1), 掘割(0/1), layer, 車線数, 名前, [[緯度,経度], ...]], ...]
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const [SOUTH, WEST, NORTH, EAST] = (process.argv[2] ?? '35.52,139.56,35.82,139.92').split(',').map(Number);
const SPLIT = Number(process.argv[3] ?? 4);
const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CACHE_DIR = new URL('../data/cache/expressways/', import.meta.url);
const OUT = new URL('../data/osm/expressways.json', import.meta.url);

async function overpass(query) {
  // 通信が不安定でも粘る（約10分）
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (expressway script)' },
          body: new URLSearchParams({ data: query }),
        });
        if (res.ok) return (await res.json()).elements;
        console.warn(`${endpoint} → ${res.status}`);
      } catch (e) {
        console.warn(`${endpoint} → ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
  throw new Error('Overpass API から取得できませんでした（もう一度流せば、取得済みの区画の続きから再開します）');
}

const ways = new Map();
for (let i = 0; i < SPLIT; i++) {
  for (let j = 0; j < SPLIT; j++) {
    const s = SOUTH + ((NORTH - SOUTH) * j) / SPLIT;
    const n = SOUTH + ((NORTH - SOUTH) * (j + 1)) / SPLIT;
    const w = WEST + ((EAST - WEST) * i) / SPLIT;
    const e = WEST + ((EAST - WEST) * (i + 1)) / SPLIT;
    const bbox = `${s},${w},${n},${e}`;
    const cacheFile = new URL(`${bbox}.json`, CACHE_DIR);
    let elements = await readFile(cacheFile, 'utf8').then(JSON.parse, () => null);
    if (!elements) {
      elements = await overpass(`[out:json][timeout:180];
        way["highway"~"^(motorway|motorway_link)$"]["tunnel"!~"^(yes|building_passage|covered)$"](${bbox});
        out tags geom qt;`);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(elements));
    }
    for (const el of elements) ways.set(el.id, el);
    console.log(`part ${i * SPLIT + j + 1}/${SPLIT * SPLIT}: ${ways.size} ways`);
  }
}

const out = [];
for (const way of ways.values()) {
  const t = way.tags ?? {};
  if (!way.geometry || way.geometry.length < 2) continue;
  const lanes = Math.max(1, Math.min(6, parseInt(t.lanes ?? '', 10) || (t.highway === 'motorway' ? 2 : 1)));
  out.push([
    t.highway === 'motorway_link' ? 1 : 0,
    t.bridge && t.bridge !== 'no' ? 1 : 0,
    t.cutting && t.cutting !== 'no' ? 1 : 0,
    parseInt(t.layer ?? '0', 10) || 0,
    lanes,
    t.name ?? '',
    way.geometry.map((p) => [+p.lat.toFixed(7), +p.lon.toFixed(7)]),
  ]);
}
await mkdir(new URL('./', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
console.log(`${out.length} ways → data/osm/expressways.json`);
