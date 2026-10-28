// 東京23区まわりの線路（1本ずつの線路の中心線）を OpenStreetMap (Overpass API) から取得し、
// 地形チャンクと同じタイル（ズーム15）ごとに data/osm/railways/15/{x}/{y}.json に書き出す（元データ）。
// ゲームで使う形（高さ付き）は scripts/build-rail-heights.mjs で作る。
// トンネル・地下の区間は除く。ただし屋根付き・建物の下の区間（駅ビル・人工地盤の下）は普通の線路として使い、
// 本当のトンネルは両端（入口）の位置と向きを data/osm/rail-tunnels.json に書き出す。地下鉄（railway=subway）は、地上・高架を走る区間（都営新宿線の東大島〜一之江、
// 三田線の高島平付近、丸ノ内線の御茶ノ水・後楽園付近など）だけ使う（トンネル・地下・layer が負の区間を除く）。
// 使い方: node scripts/fetch-railways.mjs [南,西,北,東] [分割数]
//   取得した区画は data/cache/railways に保存し、2回目からはそれを使う（取得し直す時は消す）
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力の形式（1タイル）: [[高架(0/1), layer（負なら掘割）, 軌間(mm), [緯度,経度,...（1e-6度、先頭以外は前の点との差）], 地下鉄(0/1)], ...]
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const [SOUTH, WEST, NORTH, EAST] = (process.argv[2] ?? '35.52,139.56,35.82,139.92').split(',').map(Number);
const partial = process.argv[2] !== undefined;
const SPLIT = Number(process.argv[3] ?? 4);
const ZOOM = 15;
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OUT_DIR = new URL('../data/osm/railways/15/', import.meta.url);
const CACHE_DIR = new URL('../data/cache/railways/', import.meta.url);
/** 本当のトンネルの両端（scripts/build-rail-heights.mjs が入口（坑口）を作るのに使う） */
const TUNNEL_FILE = new URL('../data/osm/rail-tunnels.json', import.meta.url);

async function overpass(query) {
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (railway script)' },
          body: new URLSearchParams({ data: query }),
          // 応答の無いサーバーで止まらないよう、一定時間で次へ
          signal: AbortSignal.timeout(240000),
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
const q = (v) => Math.round(v * 1e6);
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
    const cacheFile = new URL(`${s},${w},${n},${e}.json`, CACHE_DIR);
    let elements = await readFile(cacheFile, 'utf8').then(JSON.parse, () => null);
    if (!elements) {
      elements = await overpass(`[out:json][timeout:180];
      (
        way["railway"~"^(rail|light_rail|narrow_gauge|monorail)$"]["tunnel"!~"^(yes|building_passage|covered)$"]["location"!="underground"](${s},${w},${n},${e});
        way["railway"="subway"]["tunnel"!~"^(yes|building_passage|covered)$"]["location"!="underground"]["layer"!~"^-"](${s},${w},${n},${e});
      );
      out tags geom qt;`);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(elements));
    }
    for (const el of elements) ways.set(el.id, el);
    console.log(`part ${i * SPLIT + j + 1}/${SPLIT * SPLIT}: ${ways.size} ways`);
  }
}

// ---- トンネル区間（23区まわり全体を1回で取る） ----
// 屋根付き・建物の下（駅ビル・人工地盤の下を地面の高さのまま通る区間）は、普通の線路として使う（地下鉄は除く）。
// 本当のトンネル（地下へ入る区間）は、両端の入口（坑口）を作るために端の位置と向きを書き出す
const tunnelCache = new URL('../data/cache/rail-tunnels/tunnels.json', import.meta.url);
let tunnelElements = await readFile(tunnelCache, 'utf8').then((t) => JSON.parse(t).elements, () => null);
if (!tunnelElements) {
  const bbox = `${SOUTH},${WEST},${NORTH},${EAST}`;
  tunnelElements = await overpass(`[out:json][timeout:250];
    (
      way["railway"~"^(rail|light_rail|narrow_gauge|monorail|subway)$"]["tunnel"~"^(yes|covered|building_passage)$"](${bbox});
      way["railway"~"^(rail|light_rail|narrow_gauge|monorail|subway)$"]["location"="underground"](${bbox});
      way["railway"="subway"]["layer"~"^-"](${bbox});
    );
    out tags geom qt;`);
  await mkdir(new URL('./', tunnelCache), { recursive: true });
  await writeFile(tunnelCache, JSON.stringify({ elements: tunnelElements }));
}
const tunnelEnds = []; // [緯度, 経度, トンネルの中の次の点の緯度, 経度]（1e-6度）
let covered = 0;
for (const el of tunnelElements) {
  const t = el.tags ?? {};
  const g = el.geometry;
  if (!g || g.length < 2) continue;
  // 屋根付き：tunnel=covered・building_passage のほか、tunnel=yes に covered=yes が付いたもの（新宿駅の南口の下など）
  const roofed =
    (t.tunnel === 'covered' || t.tunnel === 'building_passage' || (t.tunnel === 'yes' && t.covered === 'yes')) &&
    t.location !== 'underground';
  if (roofed && t.railway !== 'subway' && !((parseInt(t.layer ?? '0', 10) || 0) < 0)) {
    ways.set(el.id, el);
    covered++;
    continue;
  }
  if (roofed) continue;
  tunnelEnds.push([g[0], g[1]], [g[g.length - 1], g[g.length - 2]]);
}
await writeFile(
  TUNNEL_FILE,
  JSON.stringify(tunnelEnds.map(([a, b]) => [q(a.lat), q(a.lon), q(b.lat), q(b.lon)])),
);
console.log(`${covered} covered sections added as tracks, ${tunnelEnds.length} tunnel ends`);

const tiles = new Map();
for (const way of ways.values()) {
  const t = way.tags;
  const bridge = t.bridge !== undefined && t.bridge !== 'no' ? 1 : 0;
  // layer が負でトンネルでないものは掘割（切り通し）。地形を削って、その底に線路を置く
  const layer = parseInt(t.layer ?? '0', 10) || 0;
  const gauge = parseInt(t.gauge ?? '1067', 10) || 1067;
  const subway = t.railway === 'subway' ? 1 : 0;
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
    tiles.get(run.key).push([bridge, layer, gauge, coords, subway]);
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
