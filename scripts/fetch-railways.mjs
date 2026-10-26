// 東京23区まわりの線路（1本ずつの線路の中心線）を OpenStreetMap (Overpass API) から取得し、
// 地形チャンクと同じタイル（ズーム15）ごとに public/railways/15/{x}/{y}.json に書き出す。
// 地下鉄・トンネル区間は除く。
// 使い方: node scripts/fetch-railways.mjs [南,西,北,東] [分割数]
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力の形式（1タイル）: [[高架(0/1), layer, 軌間(mm), [緯度,経度,...（1e-6度、先頭以外は前の点との差）]], ...]
import { mkdir, rm, writeFile } from 'node:fs/promises';

const [SOUTH, WEST, NORTH, EAST] = (process.argv[2] ?? '35.52,139.56,35.82,139.92').split(',').map(Number);
const partial = process.argv[2] !== undefined;
const SPLIT = Number(process.argv[3] ?? 4);
const ZOOM = 15;
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OUT_DIR = new URL('../public/railways/15/', import.meta.url);

async function overpass(query) {
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (railway script)' },
          body: new URLSearchParams({ data: query }),
        });
        if (res.ok) return (await res.json()).elements;
        console.warn(`${endpoint} → ${res.status}`);
      } catch (e) {
        console.warn(`${endpoint} → ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error('Overpass API から取得できませんでした');
}

const K = Math.PI / 180;
function tileOf(lat, lon) {
  const n = 2 ** ZOOM;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n);
  return `${x}/${y}`;
}

const ways = new Map();
for (let i = 0; i < SPLIT; i++) {
  for (let j = 0; j < SPLIT; j++) {
    const s = SOUTH + ((NORTH - SOUTH) * j) / SPLIT;
    const n = SOUTH + ((NORTH - SOUTH) * (j + 1)) / SPLIT;
    const w = WEST + ((EAST - WEST) * i) / SPLIT;
    const e = WEST + ((EAST - WEST) * (i + 1)) / SPLIT;
    const elements = await overpass(`[out:json][timeout:180];
      way["railway"~"^(rail|light_rail|narrow_gauge|monorail)$"]["tunnel"!~"^(yes|building_passage|covered)$"]["location"!="underground"](${s},${w},${n},${e});
      out tags geom qt;`);
    for (const el of elements) ways.set(el.id, el);
    console.log(`part ${i * SPLIT + j + 1}/${SPLIT * SPLIT}: ${ways.size} ways`);
  }
}

const tiles = new Map();
const q = (v) => Math.round(v * 1e6);
for (const way of ways.values()) {
  const t = way.tags;
  const bridge = t.bridge !== undefined && t.bridge !== 'no' ? 1 : 0;
  const layer = parseInt(t.layer ?? '0', 10) || 0;
  // 地上の線路が地面より下（掘割）なら、地面に置く
  if (layer < 0 && !bridge) continue;
  const gauge = parseInt(t.gauge ?? '1067', 10) || 1067;
  const g = way.geometry;
  // 線分の中点が入るタイルごとに、ひと続きの区間に分ける
  let run = null;
  const flush = () => {
    if (!run || run.points.length < 2) return;
    const coords = [];
    let plat = 0;
    let plon = 0;
    for (const p of run.points) {
      coords.push(q(p.lat) - plat, q(p.lon) - plon);
      plat = q(p.lat);
      plon = q(p.lon);
    }
    if (!tiles.has(run.key)) tiles.set(run.key, []);
    tiles.get(run.key).push([bridge, Math.max(0, layer), gauge, coords]);
  };
  for (let k = 1; k < g.length; k++) {
    const key = tileOf((g[k - 1].lat + g[k].lat) / 2, (g[k - 1].lon + g[k].lon) / 2);
    if (!run || run.key !== key) {
      flush();
      run = { key, points: [g[k - 1]] };
    }
    run.points.push(g[k]);
  }
  flush();
}

if (!partial) await rm(OUT_DIR, { recursive: true, force: true });
let bytes = 0;
for (const [key, data] of tiles) {
  const [x, y] = key.split('/');
  await mkdir(new URL(`${x}/`, OUT_DIR), { recursive: true });
  const json = JSON.stringify(data);
  bytes += json.length;
  await writeFile(new URL(`${x}/${y}.json`, OUT_DIR), json);
}
console.log(`${ways.size} ways → ${tiles.size} tiles, ${(bytes / 1e6).toFixed(2)} MB`);
