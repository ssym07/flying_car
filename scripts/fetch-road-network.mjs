// 東京23区まわりの道路（中心線）と横断歩道を OpenStreetMap (Overpass API) から取得し、
// 地形チャンクと同じタイル（ズーム15）ごとに public/roads/15/{x}/{y}.json に書き出す。
// 使い方: node scripts/fetch-road-network.mjs [南,西,北,東] [分割数]
//   範囲を省くと23区全体（1時間ほどかかる）。範囲を指定した時は、既存のタイルを消さずに追加・上書きする
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力の形式（1タイル）:
// {
//   "w": [[種別, 車線数, 一方通行(0/1), [緯度,経度,...（1e-6度の整数、先頭以外は前の点との差）], [交差点の点の番号...], 橋], ...],
//        橋：橋でなければ 0。橋なら [始点の緯度, 経度, 終点の緯度, 経度（1e-6度）, 橋全体の長さ(m), この区間の始まりまでの長さ(m), 名前]
//        （タイルの境目で分かれた橋の区間どうしが同じ高さでつながるよう、橋全体の両端を持たせる）
//   "c": [[緯度, 経度, 道の方位(rad, 北から時計回り), 道の種別], ...]   // 横断歩道
// }
import { mkdir, rm, writeFile } from 'node:fs/promises';

const [SOUTH, WEST, NORTH, EAST] = (process.argv[2] ?? '35.52,139.56,35.82,139.92').split(',').map(Number);
const partial = process.argv[2] !== undefined;
/** Overpass への問い合わせを分割する数（縦横）。大きすぎると応答が遅く、失敗しやすい */
const SPLIT = Number(process.argv[3] ?? 10);
const ZOOM = 15;
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OUT_DIR = new URL('../public/roads/15/', import.meta.url);

/** 種別：0=幹線（国道など） 1=2車線の道路 2=生活道路 */
const CLASS = {
  trunk: 0, trunk_link: 0, primary: 0, primary_link: 0,
  secondary: 1, secondary_link: 1, tertiary: 1, tertiary_link: 1,
  unclassified: 2, residential: 2, living_street: 2,
};

async function overpass(query) {
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (road network script)' },
          body: new URLSearchParams({ data: query }),
        });
        if (res.ok) return (await res.json()).elements;
        console.warn(`${endpoint} → ${res.status}`);
      } catch (e) {
        console.warn(`${endpoint} → ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error('Overpass API から取得できませんでした');
}

const K = Math.PI / 180;
function meters(a, b) {
  const east = (b.lon - a.lon) * K * Math.cos(((a.lat + b.lat) / 2) * K);
  return Math.hypot(east, (b.lat - a.lat) * K) * 6371000;
}
function bearing(a, b) {
  const east = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * K);
  return Math.atan2(east, b.lat - a.lat);
}
function tileOf(lat, lon) {
  const n = 2 ** ZOOM;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n);
  return `${x}/${y}`;
}

const ways = [];
const crossings = new Set();
const pointKey = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
for (let i = 0; i < SPLIT; i++) {
  for (let j = 0; j < SPLIT; j++) {
    const s = SOUTH + ((NORTH - SOUTH) * j) / SPLIT;
    const n = SOUTH + ((NORTH - SOUTH) * (j + 1)) / SPLIT;
    const w = WEST + ((EAST - WEST) * i) / SPLIT;
    const e = WEST + ((EAST - WEST) * (i + 1)) / SPLIT;
    const bbox = `${s},${w},${n},${e}`;
    // 道は「タグと形」だけ、横断歩道は「位置」だけ取る（ノード番号は使わず、座標の一致で交差点を探す）
    const elements = await overpass(`[out:json][timeout:180];
      way["highway"~"^(${Object.keys(CLASS).join('|')})$"]["tunnel"!~"yes|building_passage"]["area"!="yes"](${bbox});
      out tags geom qt;
      node["highway"="crossing"](${bbox});
      out skel qt;`);
    for (const el of elements) {
      if (el.type === 'way') ways.push(el);
      else crossings.add(pointKey(el));
    }
    console.log(`part ${i * SPLIT + j + 1}/${SPLIT * SPLIT}: ${ways.length} ways, ${crossings.size} crossings`);
  }
}

// 範囲の境目で同じ道を2回取ることがあるので、形の同じ道を除く
const seen = new Set();
const unique = ways.filter((w) => {
  const k = `${w.tags.highway}|${w.geometry.map(pointKey).join(';')}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// 2本以上の道が通る点 = 交差点
const usage = new Map();
for (const way of unique) {
  for (const p of new Set(way.geometry.map(pointKey))) usage.set(p, (usage.get(p) ?? 0) + 1);
}

const tiles = new Map();
const tile = (key) => {
  let t = tiles.get(key);
  if (!t) tiles.set(key, (t = { w: [], c: [] }));
  return t;
};
const q = (v) => Math.round(v * 1e6);

for (const way of unique) {
  const cls = CLASS[way.tags.highway];
  const oneway = way.tags.oneway === 'yes' || way.tags.oneway === '1' || way.tags.junction === 'roundabout' ? 1 : 0;
  const lanes = Math.max(0, Math.min(8, parseInt(way.tags.lanes ?? '0', 10) || 0));
  const g = way.geometry;
  const isBridge = way.tags.bridge !== undefined && way.tags.bridge !== 'no';
  const along = [0];
  for (let k = 1; k < g.length; k++) along.push(along[k - 1] + meters(g[k - 1], g[k]));

  // 線分の中点が入るタイルごとに、ひと続きの区間に分ける
  let run = null;
  const flush = () => {
    if (!run || run.points.length < 2) return;
    const coords = [];
    let plat = 0;
    let plon = 0;
    for (const p of run.points) {
      const lat = q(p.lat);
      const lon = q(p.lon);
      coords.push(lat - plat, lon - plon);
      plat = lat;
      plon = lon;
    }
    const bridge = isBridge
      ? [q(g[0].lat), q(g[0].lon), q(g[g.length - 1].lat), q(g[g.length - 1].lon),
         Math.round(along[g.length - 1]), Math.round(along[run.start]), way.tags['bridge:name'] ?? way.tags.name ?? '']
      : 0;
    tile(run.key).w.push([cls, lanes, oneway, coords, run.junctions, bridge]);
  };
  for (let k = 1; k < g.length; k++) {
    const key = tileOf((g[k - 1].lat + g[k].lat) / 2, (g[k - 1].lon + g[k].lon) / 2);
    if (!run || run.key !== key) {
      flush();
      run = { key, points: [g[k - 1]], junctions: [], start: k - 1 };
      if ((usage.get(pointKey(g[k - 1])) ?? 0) > 1) run.junctions.push(0);
    }
    run.points.push(g[k]);
    if ((usage.get(pointKey(g[k])) ?? 0) > 1) run.junctions.push(run.points.length - 1);
  }
  flush();

  // 横断歩道：道の上の点で、前後の点から道の向きを出す
  g.forEach((p, k) => {
    if (!crossings.has(pointKey(p))) return;
    const a = g[Math.max(0, k - 1)];
    const b = g[Math.min(g.length - 1, k + 1)];
    tile(tileOf(g[k].lat, g[k].lon)).c.push([q(g[k].lat), q(g[k].lon), +bearing(a, b).toFixed(3), cls]);
  });
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
console.log(`${unique.length} ways → ${tiles.size} tiles, ${(bytes / 1e6).toFixed(1)} MB`);
