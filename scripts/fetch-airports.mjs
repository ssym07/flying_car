// 空港（滑走路・誘導路・駐機場・駐機位置・管制塔・空港の敷地）を OpenStreetMap (Overpass API) から取得し、
// public/airports.json（大阪は public/osaka/airports.json）に書き出す。ゲームの src/world/Airports.ts が読む。
// あわせて、空港の敷地を地面の種類のタイル（public/landuse/15）の一番下に「空港の芝地」（種類 11）として、
// 駐機場を「駐機場」（種類 12）として書き足す（どちらも OpenStreetMap の地面の種類には無い番号なので、
// 前に足したものを見分けて消してから足せる。何回流してもよい）。
// 使い方: node scripts/fetch-airports.mjs（fetch-landuse.mjs の後に実行。REGION=osaka で大阪）
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力の形式:
// { "r": [[幅(m), [緯度,経度,...（1e-6度、先頭以外は差分）], 始点の表示, 終点の表示, 始点が端(0/1), 終点が端(0/1)], ...],  // 滑走路
//   "t": [[幅(m), [座標...]], ...],                     // 誘導路
//   "s": [[緯度, 経度（1e-6度）, 機首の向き（0.1度、東が 0 で北へ回る）], ...],  // 駐機している飛行機の位置（機首の先）
//   "c": [[緯度, 経度（1e-6度）, 高さ(m)], ...],          // 管制塔
//   "j": [[座標...（ターミナルの側から飛行機の側へ）], ...] }   // 搭乗橋（付け根は scripts/build-airport-fixed-links.mjs）
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BOUNDS, REGION_ID, regionPath } from './lib/region.mjs';

const OUT = regionPath('public/airports.json');
const LANDUSE_DIR = regionPath('public/landuse/15/');
const CACHE = new URL(`../data/cache/airports-${REGION_ID}.json`, import.meta.url);
const ZOOM = 15;
/** 地面の種類の番号（scripts/fetch-landuse.mjs・src/world/landuse.ts と同じ） */
const AIRFIELD = 11;
const APRON = 12;
/** 幅の印の無い誘導路の幅 (m) */
const TAXIWAY_WIDTH = 23;
/** OpenStreetMap に管制塔の無い空港の管制塔 [緯度, 経度, 高さ(m)]（地図と写真から） */
const EXTRA_TOWERS = { tokyo: [], osaka: [[34.78555, 135.43785, 52]] };
const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function overpass(query) {
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (airport script)' },
          body: new URLSearchParams({ data: query }),
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
  throw new Error('Overpass API から取得できませんでした');
}

let elements = await readFile(CACHE, 'utf8').then(JSON.parse, () => null);
if (!elements) {
  const bbox = BOUNDS.join(',');
  elements = await overpass(`[out:json][timeout:240];
    (
      way["aeroway"~"^(runway|taxiway|taxilane|apron|parking_position|aerodrome|terminal|jet_bridge)$"](${bbox});
      relation["aeroway"~"^(apron|aerodrome|terminal)$"](${bbox});
      nwr["aeroway"="control_tower"](${bbox});
      nwr["man_made"="tower"]["name"~"管制塔"](${bbox});
    );
    out tags geom;`);
  await mkdir(new URL('./', CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(elements));
}

const K = Math.PI / 180;
const q = (v) => Math.round(v * 1e6);
const encode = (pts) => {
  const out = [];
  let plat = 0;
  let plon = 0;
  for (const [lat, lon] of pts) {
    out.push(q(lat) - plat, q(lon) - plon);
    plat = q(lat);
    plon = q(lon);
  }
  return out;
};
const meters = ([a, b], [c, d]) => Math.hypot((c - a) * 111320, (d - b) * 111320 * Math.cos(a * K));
/** a から b への向き（度、東が 0 で北へ回る） */
const bearing = ([a, b], [c, d]) => Math.atan2(c - a, (d - b) * Math.cos(a * K)) / K;
const width = (t, fallback) => {
  const w = parseFloat(t.width ?? '');
  return Number.isFinite(w) && w > 3 && w < 120 ? w : fallback;
};
const geom = (el) => (el.geometry ?? []).map((p) => [p.lat, p.lon]);
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
/** マルチポリゴンの outer のウェイをつないで輪にする */
function rings(el) {
  if (el.type === 'way') {
    const g = geom(el);
    return g.length >= 4 && same(g[0], g[g.length - 1]) ? [g] : [];
  }
  const left = (el.members ?? []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry.map((p) => [p.lat, p.lon]));
  const out = [];
  while (left.length > 0) {
    let ring = left.shift();
    let grown = true;
    while (grown && !same(ring[0], ring[ring.length - 1])) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const s = left[i];
        const end = ring[ring.length - 1];
        if (same(s[0], end)) ring = ring.concat(s.slice(1));
        else if (same(s[s.length - 1], end)) ring = ring.concat([...s].reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) out.push(ring);
  }
  return out;
}

const runways = elements.filter((e) => e.tags?.aeroway === 'runway' && e.type === 'way');
const taxiways = elements.filter((e) => /^(taxiway|taxilane)$/.test(e.tags?.aeroway ?? '') && e.type === 'way');
const stands = elements.filter((e) => e.tags?.aeroway === 'parking_position' && e.type === 'way');
const aprons = elements.filter((e) => e.tags?.aeroway === 'apron');
const fields = elements.filter((e) => e.tags?.aeroway === 'aerodrome');
const towers = elements.filter((e) => e.tags?.aeroway === 'control_tower' || e.tags?.man_made === 'tower');

// ---- 滑走路：端（ほかの滑走路の区間とつながっていない方）に、進入端の印と番号を描く ----
const endKey = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
const endCount = new Map();
for (const r of runways) {
  const g = geom(r);
  for (const p of [g[0], g[g.length - 1]]) endCount.set(endKey(p), (endCount.get(endKey(p)) ?? 0) + 1);
}
/** 端から滑走路の中へ向かう向き（真北からの度）に合う番号（"16R" など）。磁北は真北より約 7° 西 */
function designator(ref, headingTrue) {
  const parts = (ref ?? '').split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  const magnetic = (headingTrue + 7 + 360) % 360;
  let best = parts[0];
  let bestDiff = Infinity;
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (!Number.isFinite(n)) continue;
    const d = Math.abs(((n * 10 - magnetic + 540) % 360) - 180);
    if (d < bestDiff) (bestDiff = d), (best = p);
  }
  return best;
}
const outRunways = runways.map((r) => {
  const g = geom(r);
  const a = g[0];
  const b = g[g.length - 1];
  // 真北から時計回りの向き
  const toCompass = (deg) => (90 - deg + 360) % 360;
  const startLabel = designator(r.tags.ref, toCompass(bearing(a, b)));
  const endLabel = designator(r.tags.ref, toCompass(bearing(b, a)));
  return [
    width(r.tags, 45),
    encode(g),
    startLabel,
    endLabel,
    endCount.get(endKey(a)) === 1 ? 1 : 0,
    endCount.get(endKey(b)) === 1 ? 1 : 0,
  ];
});

// ---- 誘導路 ----
const outTaxiways = taxiways.map((t) => [width(t.tags, TAXIWAY_WIDTH), encode(geom(t))]);

// ---- 駐機している飛行機：駐機位置の線のうち、ターミナル・搭乗橋に近い方の端が機首の先（近くに無ければ、
// 誘導路から遠い方の端）。3割は空けておく ----
const terminalPts = elements
  .filter((e) => /^(terminal|jet_bridge)$/.test(e.tags?.aeroway ?? ''))
  .flatMap((e) => (e.type === 'way' ? geom(e) : (e.members ?? []).flatMap((m) => (m.geometry ?? []).map((p) => [p.lat, p.lon]))));
const taxiPts = taxiways.flatMap(geom);
const CELL = 0.002;
const gridOf = (pts) => {
  const grid = new Map();
  for (const p of pts) {
    const k = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  return (p) => {
    let best = Infinity;
    const [cy, cx] = [Math.floor(p[0] / CELL), Math.floor(p[1] / CELL)];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) for (const t of grid.get(`${cy + dy},${cx + dx}`) ?? []) best = Math.min(best, meters(p, t));
    }
    return best;
  };
};
const nearestTaxi = gridOf(taxiPts);
const nearestTerminal = gridOf(terminalPts);
const hash = (n) => {
  const h = Math.sin(n * 12.9898) * 43758.5453;
  return h - Math.floor(h);
};
const outStands = [];
for (const s of stands) {
  const g = geom(s);
  if (g.length < 2 || hash(s.id) < 0.3) continue;
  const a = g[0];
  const b = g[g.length - 1];
  if (meters(a, b) < 8) continue;
  const ta = nearestTerminal(a);
  const tb = nearestTerminal(b);
  const aIsNose = Math.min(ta, tb) < 150 ? ta < tb : nearestTaxi(a) > nearestTaxi(b);
  const [nose, tail] = aIsNose ? [a, g[1]] : [b, g[g.length - 2]];
  outStands.push([q(nose[0]), q(nose[1]), Math.round(((bearing(tail, nose) + 360) % 360) * 10)]);
}

// ---- 管制塔 ----
const outTowers = [];
for (const t of towers) {
  const c = t.type === 'node' ? [t.lat, t.lon] : (() => {
    const g = geom(t);
    return [g.reduce((s, p) => s + p[0], 0) / g.length, g.reduce((s, p) => s + p[1], 0) / g.length];
  })();
  if (outTowers.some(([la, lo]) => meters([la / 1e6, lo / 1e6], c) < 30)) continue;
  outTowers.push([q(c[0]), q(c[1]), Math.round(parseFloat(t.tags.height ?? '') || 60)]);
}
for (const [la, lo, h] of EXTRA_TOWERS[REGION_ID] ?? []) outTowers.push([q(la), q(lo), h]);

// ---- 搭乗橋：ターミナルに近い方の端から並べる ----
const outBridges = elements
  .filter((e) => e.tags?.aeroway === 'jet_bridge' && e.type === 'way')
  .map(geom)
  .filter((g) => g.length >= 2 && meters(g[0], g[g.length - 1]) >= 6)
  .map((g) => (nearestTerminal(g[0]) <= nearestTerminal(g[g.length - 1]) ? g : [...g].reverse()))
  .map(encode);

await writeFile(
  OUT,
  JSON.stringify({ r: outRunways, t: outTaxiways, s: outStands, c: outTowers, j: outBridges }),
);

// ---- 地面の種類：空港の敷地を一番下に芝地として、駐機場をコンクリートとして足す ----
const tileXY = (lat, lon) => {
  const n = 2 ** ZOOM;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n)];
};
const add = new Map(); // タイル → { under: [...], over: [...] }
const put = (ring, kind, over) => {
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const [lat, lon] of ring) (s = Math.min(s, lat)), (n = Math.max(n, lat)), (w = Math.min(w, lon)), (e = Math.max(e, lon));
  const [x0, y1] = tileXY(s, w);
  const [x1, y0] = tileXY(n, e);
  const record = [kind, 0, encode(ring.slice(0, -1))];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const key = `${x}/${y}`;
      if (!add.has(key)) add.set(key, { under: [], over: [] });
      add.get(key)[over ? 'over' : 'under'].push(record);
    }
  }
};
for (const f of fields) for (const ring of rings(f)) put(ring, AIRFIELD, false);
for (const a of aprons) for (const ring of rings(a)) put(ring, APRON, true);
let written = 0;
for (const [key, { under, over }] of add) {
  const [x, y] = key.split('/');
  const file = new URL(`${x}/${y}.json`, LANDUSE_DIR);
  const base = await readFile(file, 'utf8').then(JSON.parse, () => ({ a: [] }));
  // 前に足した空港の芝地・駐機場を消してから足す。駐機場は工場などの上、砂浜（種類 10）より下に塗る
  const kept = base.a.filter(([kind]) => kind !== AIRFIELD && kind !== APRON);
  const beaches = kept.filter(([kind]) => kind === 10);
  const rest = kept.filter(([kind]) => kind !== 10);
  const data = { a: [...under, ...rest, ...over, ...beaches] };
  await mkdir(new URL(`${x}/`, LANDUSE_DIR), { recursive: true });
  await writeFile(file, JSON.stringify(data));
  written++;
}
console.log(
  `${outRunways.length} runways, ${outTaxiways.length} taxiways, ${outStands.length} parked aircraft, ${outTowers.length} towers, ${outBridges.length} jet bridges → ${OUT.pathname}; ${fields.length} airfields, ${aprons.length} aprons → ${written} landuse tiles`,
);
