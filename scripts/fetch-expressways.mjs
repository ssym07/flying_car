// 東京23区と横浜市・川崎市まわりの高速道路（首都高・湾岸線・外環道など。本線と連絡路）を OpenStreetMap (Overpass API) から取得し、
// data/osm/expressways.json に書き出す（元データ）。トンネル区間は除く。
// ゲームで使う形（高さ付き・タイル分け）は scripts/build-expressways.mjs で作る。
// 使い方: node scripts/fetch-expressways.mjs [南,西,北,東] [分割数]
//   取得した区画は data/cache/expressways に保存し、途中で止まっても次はその続きから取得する
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力の形式: [[連絡路(0/1), 高架(0/1), 掘割(0/1), layer, 車線数, 名前, [[緯度,経度], ...]], ...]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AREAS, areaCells } from './lib/tiles.mjs';
import { regionPath } from './lib/region.mjs';

const [SOUTH, WEST, NORTH, EAST] = (process.argv[2] ?? AREAS.flat().join(',')).split(',').map(Number);
const SPLIT = Number(process.argv[3] ?? 6);
/** 区画（範囲を指定しなければ AREAS の長方形ごと） */
const CELLS = areaCells(SPLIT, process.argv[2] ? [SOUTH, WEST, NORTH, EAST] : null);
const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CACHE_DIR = new URL('../data/cache/expressways/', import.meta.url);
const OUT = regionPath('data/osm/expressways.json');
const TUNNEL_OUT = regionPath('data/osm/expressway-tunnels.json');

async function overpass(query) {
  // 通信が不安定でも粘る（約10分）
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (expressway script)' },
          body: new URLSearchParams({ data: query }),
          // 返事が来ないまま止まることがあるので4分で打ち切って次の取得先へ
          signal: AbortSignal.timeout(240000),
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
for (const [index, [s, w, n, e]] of CELLS.entries()) {
  {
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
    console.log(`part ${index + 1}/${CELLS.length}: ${ways.size} ways`);
  }
}

// ---- トンネルの端（全体を1回で取る）：トンネルに入る手前の高速道路を、地面（掘割）まで下ろすのに使う ----
const tunnelElements = [];
for (const [index, area] of (process.argv[2] ? [[SOUTH, WEST, NORTH, EAST]] : AREAS).entries()) {
  const bbox = area.join(',');
  const name = index === 0 && !process.argv[2] ? 'expressway-tunnels.json' : `expressway-tunnels-${bbox}.json`;
  const tunnelCache = new URL(`../data/cache/${name}`, import.meta.url);
  let elements = await readFile(tunnelCache, 'utf8').then(JSON.parse, () => null);
  if (!elements) {
    elements = await overpass(`[out:json][timeout:250];
      way["highway"~"^(motorway|motorway_link)$"]["tunnel"~"^(yes|building_passage|covered)$"](${bbox});
      out geom qt;`);
    await writeFile(tunnelCache, JSON.stringify(elements));
  }
  tunnelElements.push(...elements);
}
const tunnelEnds = [];
for (const el of tunnelElements) {
  const g = el.geometry;
  if (!g || g.length < 2) continue;
  for (const p of [g[0], g[g.length - 1]]) tunnelEnds.push([+p.lat.toFixed(7), +p.lon.toFixed(7)]);
}
await writeFile(TUNNEL_OUT, JSON.stringify(tunnelEnds));
console.log(`${tunnelEnds.length} tunnel ends → data/osm/expressway-tunnels.json`);

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
