// 東京23区と横浜市・川崎市まわりの駅の屋根（駅舎・ホームの上屋）の形を OpenStreetMap (Overpass API) から取得し、
// 地形チャンクと同じタイル（ズーム15）ごとに public/station-roofs/15/{x}/{y}.json に書き出す。
// 駅（src/data/stations.json）から一定距離以内のものだけ残す（ガソリンスタンドの屋根などを除くため）。
// ホームが線で描かれているもの（東京駅の JR など）は、両脇の線路（data/osm/railways）から
// PLATFORM_CLEAR m ずつ空けた形の面にする（fetch-railways.mjs の後に実行）。
// ホームは、1本の線・面のほか、リレーション（いくつかの線をまとめた形）や、駅舎・屋根の印も付いたものも読む。
// 地下のホーム（layer・level が負）は使わない。
// テンプレート：ホームのデータが1つも無い地上の駅には、線路の並びからホームを作り（線路の間が空いていれば島式、
// 無ければ外側に相対式）、屋根のデータがほとんど無い地上のホームには、ホームと同じ形の上屋を置く。
// 使い方: node scripts/fetch-station-roofs.mjs [南,西,北,東] [分割数]
//   取得した区画は data/cache/station-roofs に保存し、2回目からはそれを使う（取得し直す時は消す）
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力の形式（1タイル）: [[種類, 地面からの高さ(m), 駅の番号, [緯度,経度,...（1e-6度、先頭以外は前の点との差）]], ...]
//   種類：0 = 駅舎、1 = 上屋（屋根）、2 = ホーム（床）
//   上屋・ホームの高さは仮の値。scripts/build-platforms.mjs が線路の高さに合わせて書き換える
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { AREAS, areaCells } from './lib/tiles.mjs';

const [SOUTH, WEST, NORTH, EAST] = (process.argv[2] ?? AREAS.flat().join(',')).split(',').map(Number);
const partial = process.argv[2] !== undefined;
const SPLIT = Number(process.argv[3] ?? 4);
/** 区画（範囲を指定しなければ AREAS の長方形ごと） */
const CELLS = areaCells(SPLIT, process.argv[2] ? [SOUTH, WEST, NORTH, EAST] : null);
const ZOOM = 15;
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OUT_DIR = new URL('../public/station-roofs/15/', import.meta.url);
const CACHE_DIR = new URL('../data/cache/station-roofs/', import.meta.url);
const ELEVATED_FILE = new URL('../data/stations/elevated-platforms.json', import.meta.url);
const EXTRA_CACHE_DIR = new URL('../data/cache/station-platform-relations/', import.meta.url);
const RAIL_DIR = new URL('../data/osm/railways/15/', import.meta.url);
/** 駅からこの距離 (m) 以内の屋根だけ残す */
const NEAR_STATION = 300;
/** 1層（layer）あたりの高さ (m)。高架の線路はおよそこの高さ */
const LAYER_HEIGHT = 8;
/** 上屋の、乗っている面からの高さ (m) */
const CANOPY_HEIGHT = 6;
/** 線で描かれたホーム：ホームの縁と線路の中心の間 (m)、線路を探す範囲 (m)、片側に線路が無い時の半分の幅 (m) */
const PLATFORM_CLEAR = 1.6;
const TRACK_SEARCH = 9;
const DEFAULT_HALF = 2.5;
/** これより短い線のホームは使わない (m) */
const MIN_LINE_PLATFORM = 20;
/**
 * テンプレートのホーム（ホームのデータが1つも無い駅に作る）：
 * 駅の地点からこの距離 (m) 以内にホームのデータがあれば作らない、駅の地点から線路を探す範囲 (m)、
 * 並んで走る線路を見る範囲（左右, m）、並んでいるとみなす向きの近さ（cos）、線路に沿って調べる間隔 (m)、
 * ホームの長さ・これより短くなったら作らない長さ (m)、島式ホームにする線路の間隔 (m)、相対式ホームの幅 (m)
 */
const TEMPLATE_HAS_PLATFORM = 250;
const TEMPLATE_TRACK_SEARCH = 60;
const TEMPLATE_CROSS = 25;
const TEMPLATE_PARALLEL = 0.94;
const TEMPLATE_STEP = 5;
const TEMPLATE_LENGTH = 170;
const TEMPLATE_MIN_LENGTH = 40;
const ISLAND_GAP = [7.5, 16];
const SIDE_WIDTH = 3;
/** 大屋根の駅：ホームの上屋を置かない（PLATEAU の駅舎の屋根を残す。build-station-cutouts.mjs の BIG_ROOFS） */
const BIG_ROOF_STATIONS = ['高輪ゲートウェイ'];
/** 屋根のデータがこの割合より少なく覆っているホームには、テンプレートの上屋を置く */
const CANOPY_COVERED = 0.3;

const stations = JSON.parse(await readFile(new URL('../src/data/stations.json', import.meta.url), 'utf8'));

async function overpass(query) {
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (station roof script)' },
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
function meters(a, b) {
  const east = (b.lon - a.lon) * K * Math.cos(((a.lat + b.lat) / 2) * K);
  return Math.hypot(east, (b.lat - a.lat) * K) * 6371000;
}
function tileOf(lat, lon) {
  const n = 2 ** ZOOM;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n);
  return `${x}/${y}`;
}
/** 一番近い駅の番号と距離 */
function nearestStation(p) {
  let best = -1;
  let bestD = Infinity;
  stations.forEach((s, i) => {
    const d = meters(p, s);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return [best, bestD];
}

const ways = new Map();
const relations = new Map();
for (const [index, [s, w, n, e]] of CELLS.entries()) {
  {
    const bbox = `${s},${w},${n},${e}`;
    const cacheFile = new URL(`${bbox}.json`, CACHE_DIR);
    let elements = await readFile(cacheFile, 'utf8').then(JSON.parse, () => null);
    if (!elements) {
      elements = await overpass(`[out:json][timeout:180];
        (
          way["building"~"^(train_station|roof)$"](${bbox});
          way["railway"="platform"](${bbox});
        );
        out tags geom qt;`);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(elements));
    }
    for (const el of elements) ways.set(el.id, el);
    // リレーション（いくつかの線をまとめた形）で描かれたホーム（東京駅の JR など）は別に取る
    const extraFile = new URL(`${bbox}.json`, EXTRA_CACHE_DIR);
    let extra = await readFile(extraFile, 'utf8').then(JSON.parse, () => null);
    if (!extra) {
      extra = await overpass(`[out:json][timeout:180];
        (
          relation["railway"="platform"](${bbox});
          relation["public_transport"="platform"]["train"="yes"]["type"="multipolygon"](${bbox});
        );
        out tags geom qt;`);
      await mkdir(EXTRA_CACHE_DIR, { recursive: true });
      await writeFile(extraFile, JSON.stringify(extra));
    }
    for (const el of extra) relations.set(el.id, el);
    console.log(`part ${index + 1}/${CELLS.length}: ${ways.size} ways, ${relations.size} relations`);
  }
}

// リレーションの形（メンバーの線）は、番号を指定してまとめて取る（区画ごとの取得には形が付かない）
{
  const file = new URL('members.json', EXTRA_CACHE_DIR);
  let shapes = await readFile(file, 'utf8').then(JSON.parse, () => []);
  const missing = [...relations.keys()].filter((id) => !shapes.some((s) => s.id === id));
  if (missing.length > 0) {
    shapes = [...shapes, ...(await overpass(`[out:json][timeout:180];relation(id:${missing.join(',')});out body geom;`))];
    await writeFile(file, JSON.stringify(shapes));
  }
  for (const s of shapes) if (relations.has(s.id)) relations.set(s.id, s);
}

// ---- 線で描かれたホームを面にするための線路 ----
const MX = 111320 * Math.cos(35.68 * K);
const MY = 111320;
const T_CELL = 0.0005;
const trackGrid = new Map();
for (const x of await readdir(RAIL_DIR)) {
  for (const f of await readdir(new URL(`${x}/`, RAIL_DIR))) {
    for (const [, , , coords] of JSON.parse(await readFile(new URL(`${x}/${f}`, RAIL_DIR), 'utf8'))) {
      let lat = 0;
      let lon = 0;
      const pts = [];
      for (let i = 0; i < coords.length; i += 2) {
        lat += coords[i];
        lon += coords[i + 1];
        pts.push([lon * 1e-6 * MX, lat * 1e-6 * MY]);
      }
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 20));
        const cells = new Set();
        for (let k = 0; k <= n; k++) {
          cells.add(
            `${Math.floor((a[1] + ((b[1] - a[1]) * k) / n) / MY / T_CELL)},${Math.floor((a[0] + ((b[0] - a[0]) * k) / n) / MX / T_CELL)}`,
          );
        }
        for (const c of cells) {
          if (!trackGrid.has(c)) trackGrid.set(c, []);
          trackGrid.get(c).push([a, b]);
        }
      }
    }
  }
}
/** 点 p（平面の m）から、向き normal の側にある一番近い線路までの距離（TRACK_SEARCH m 以内に無ければ null） */
function trackDistance(p, normal) {
  let best = null;
  const cy = Math.floor(p[1] / MY / T_CELL);
  const cx = Math.floor(p[0] / MX / T_CELL);
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (const [a, b] of trackGrid.get(`${y},${x}`) ?? []) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
        const ox = a[0] + dx * t - p[0];
        const oy = a[1] + dy * t - p[1];
        const d = Math.hypot(ox, oy);
        // 向きの側にあり、ほぼ真横（ホームと並んで走る線路）
        if (d > TRACK_SEARCH || ox * normal[0] + oy * normal[1] < d * 0.7) continue;
        if (best === null || d < best) best = d;
      }
    }
  }
  return best;
}
/** 線のホームを、両脇の線路から PLATFORM_CLEAR m 空けた幅の面（緯度経度の輪）にする */
function lineToRing(g) {
  const line = g.map((p) => [p.lon * MX, p.lat * MY]);
  const pts = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  const left = [];
  const right = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const normal = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    const half = (side) => {
      const d = trackDistance(p, [normal[0] * side, normal[1] * side]);
      return d === null ? DEFAULT_HALF : Math.max(0.8, d - PLATFORM_CLEAR);
    };
    const l = half(1);
    const r = half(-1);
    left.push([p[0] + normal[0] * l, p[1] + normal[1] * l]);
    right.push([p[0] - normal[0] * r, p[1] - normal[1] * r]);
  });
  return [...left, ...right.reverse()].map(([x, y]) => ({ lat: y / MY, lon: x / MX }));
}
const lineLength = (g) => g.slice(1).reduce((s, p, i) => s + meters(g[i], p), 0);

/** リレーションの外側の線をつないで、閉じた輪（緯度経度の点の列）にする。閉じなければ、1本の線ならその線、それ以外は null */
function relationShape(rel) {
  const parts = (rel.members ?? [])
    .filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry?.length >= 2)
    .map((m) => m.geometry.map((p) => ({ lat: p.lat, lon: p.lon })));
  if (parts.length === 0) return null;
  const same = (a, b) => meters(a, b) <= 0.5;
  const rings = [];
  while (parts.length > 0) {
    let ring = parts.shift();
    for (let joined = true; joined && !same(ring[0], ring[ring.length - 1]); ) {
      joined = false;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const end = ring[ring.length - 1];
        if (same(end, p[0])) ring = [...ring, ...p.slice(1)];
        else if (same(end, p[p.length - 1])) ring = [...ring, ...[...p].reverse().slice(1)];
        else if (same(ring[0], p[p.length - 1])) ring = [...p, ...ring.slice(1)];
        else if (same(ring[0], p[0])) ring = [...[...p].reverse(), ...ring.slice(1)];
        else continue;
        parts.splice(i, 1);
        joined = true;
        break;
      }
    }
    rings.push(ring);
  }
  // 一番長い輪（外側）を使う
  rings.sort((a, b) => lineLength(b) - lineLength(a));
  const ring = rings[0];
  if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) return ring;
  return rings.length === 1 ? ring : null;
}

/**
 * 地下のホーム（トンネルの印、または地下2階より深い）。地下1階（-1）は掘割の駅（駒込・目白など）にも、
 * 地下鉄の印（subway=yes）は地上の地下鉄の駅（東大島など）にも付くので、それだけでは地下としない
 */
const underground = (t) =>
  t.tunnel === 'yes' ||
  t.location === 'underground' ||
  (parseFloat(t.layer ?? '0') || 0) <= -2 ||
  (parseFloat(t.level ?? '0') || 0) <= -2;
/** 地下のホームの形（描かないが、その駅にテンプレートのホームを作らないために使う） */
const undergroundRings = [];

// ---- 形を集める ----
// { kind, height, station, ring（閉じていない緯度経度の点の列）, template（テンプレートで作ったもの） }
const records = [];
let lines = 0;
let fromRelations = 0;
function addShape(el, g) {
  if (!g || g.length < 2) return;
  const t = el.tags;
  const platform = t.railway === 'platform' || t.public_transport === 'platform';
  const closed = g.length >= 4 && meters(g[0], g[g.length - 1]) <= 0.5;
  if (!closed) {
    // 線で描かれたホームは面にする（それ以外の閉じていない形は使わない）
    if (!platform || lineLength(g) < MIN_LINE_PLATFORM) return;
    const ring = lineToRing(g);
    g = [...ring, ring[0]];
    lines++;
  } else if (platform && t.area === 'no') return;
  if (platform && underground(t)) {
    undergroundRings.push(g);
    return;
  }
  const center = {
    lat: g.reduce((a, p) => a + p.lat, 0) / g.length,
    lon: g.reduce((a, p) => a + p.lon, 0) / g.length,
  };
  const [station, distance] = nearestStation(center);
  if (distance > NEAR_STATION) return;

  // ホームの印が付いていれば、駅舎・屋根の印も付いていてもホーム（その時は同じ形の上屋も置く）
  const kind = platform ? 2 : t.building === 'train_station' ? 0 : 1;
  const layer = Math.max(0, parseInt(t.layer ?? '0', 10) || 0);
  let height = parseFloat(t.height ?? '');
  if (!Number.isFinite(height)) {
    const levels = parseFloat(t['building:levels'] ?? '');
    height = Number.isFinite(levels) ? levels * 4 : kind === 0 ? 10 : CANOPY_HEIGHT;
  }
  // 高架（layer 1 以上）の上屋は、高架の上に載せる
  if (kind !== 0) height += layer * LAYER_HEIGHT;
  const ring = g.slice(0, -1);
  records.push({ kind, height, station, ring, layer });
  // 屋根付きのホーム（covered=yes、または建物の印付き）は、同じ形の上屋も置く
  if (kind === 2 && (t.covered === 'yes' || t.building)) records.push({ kind: 1, height, station, ring });
}
for (const way of ways.values()) addShape(way, way.geometry);
for (const rel of relations.values()) {
  const before = records.length;
  addShape(rel, relationShape(rel));
  if (records.length > before) fromRelations++;
}

// ---- テンプレート：ホームのデータが1つも無い地上の駅に、線路の並びからホームを作る ----
const toPlane = (p) => [p.lon * MX, p.lat * MY];
const fromPlane = ([x, y]) => ({ lat: y / MY, lon: x / MX });
/** 点 p（平面の m）のまわり radius m 以内の線路の線分 */
function segmentsNear(p, radius) {
  const out = new Set();
  const ry = Math.ceil(radius / MY / T_CELL);
  const rx = Math.ceil(radius / MX / T_CELL);
  const cy = Math.floor(p[1] / MY / T_CELL);
  const cx = Math.floor(p[0] / MX / T_CELL);
  for (let y = cy - ry; y <= cy + ry; y++) {
    for (let x = cx - rx; x <= cx + rx; x++) for (const s of trackGrid.get(`${y},${x}`) ?? []) out.add(s);
  }
  return out;
}
/** 点 p に一番近い線路の点と向き（dir を渡すと、それとほぼ同じ向きの線路だけ） */
function nearestTrack(p, radius, dir = null) {
  let best = null;
  for (const [a, b] of segmentsNear(p, radius)) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const u = [dx / len, dy / len];
    if (dir && Math.abs(u[0] * dir[0] + u[1] * dir[1]) < TEMPLATE_PARALLEL) continue;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len)));
    const q = [a[0] + dx * t, a[1] + dy * t];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d > radius || (best && d >= best.d)) continue;
    // 向きは前の向きにそろえる
    const s = dir && u[0] * dir[0] + u[1] * dir[1] < 0 ? -1 : 1;
    best = { q, d, dir: [u[0] * s, u[1] * s] };
  }
  return best;
}
/** 点 q から、線路に直角な向きに見た、並んで走る線路の位置（右を正, m）の一覧 */
function crossSection(q, dir) {
  const n = [-dir[1], dir[0]];
  const out = [];
  for (const [a, b] of segmentsNear(q, TEMPLATE_CROSS)) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len === 0 || Math.abs((dx * dir[0] + dy * dir[1]) / len) < TEMPLATE_PARALLEL) continue;
    // q + n·s が線分 a-b の上に来る s
    const den = n[0] * dy - n[1] * dx;
    if (Math.abs(den) < 1e-9) continue;
    const s = ((a[0] - q[0]) * dy - (a[1] - q[1]) * dx) / den;
    const t = Math.abs(dx) > Math.abs(dy) ? (q[0] + n[0] * s - a[0]) / dx : (q[1] + n[1] * s - a[1]) / dy;
    if (t < -0.01 || t > 1.01 || Math.abs(s) > TEMPLATE_CROSS) continue;
    if (!out.some((o) => Math.abs(o - s) < 0.5)) out.push(s);
  }
  return out.sort((x, y) => x - y);
}
/** 線路に沿って、q から dir の向きに length m 進んだ点の列（線路が途切れたらそこまで） */
function walkTrack(q, dir, length) {
  const out = [];
  let p = q;
  let d = dir;
  for (let s = TEMPLATE_STEP; s <= length; s += TEMPLATE_STEP) {
    const next = nearestTrack([p[0] + d[0] * TEMPLATE_STEP, p[1] + d[1] * TEMPLATE_STEP], 3, d);
    if (!next) break;
    p = next.q;
    d = next.dir;
    out.push({ q: p, dir: d });
  }
  return out;
}
/**
 * ある地点の線路の並びから、ホームの縁（右を正, m）を選ぶ。
 * slot は { type: 'island', mid } か { type: 'side', track, sign }。前の地点の位置に近いものを選ぶ
 */
function platformEdges(offsets, slot) {
  if (slot.type === 'island') {
    for (let i = 1; i < offsets.length; i++) {
      const lo = offsets[i - 1];
      const hi = offsets[i];
      if (hi - lo < ISLAND_GAP[0] || hi - lo > ISLAND_GAP[1] || Math.abs((lo + hi) / 2 - slot.mid) > 2.5) continue;
      slot.mid = (lo + hi) / 2;
      return [lo + PLATFORM_CLEAR, hi - PLATFORM_CLEAR];
    }
    return null;
  }
  const track = offsets.find((o) => Math.abs(o - slot.track) < 1.5);
  if (track === undefined) return null;
  // ホームを置く側に、別の線路が来たら終わり
  const near = slot.sign * PLATFORM_CLEAR;
  const far = slot.sign * (PLATFORM_CLEAR + SIDE_WIDTH);
  if (offsets.some((o) => o !== track && (o - track - near) * slot.sign > -1 && (o - track - far) * slot.sign < 2)) return null;
  slot.track = track;
  return [track + Math.min(near, far), track + Math.max(near, far)];
}
/** 駅の地点から、テンプレートのホーム（平面の m の輪）を作る */
function templatePlatforms(station) {
  const p = toPlane(station);
  const start = nearestTrack(p, TEMPLATE_TRACK_SEARCH);
  if (!start) return [];
  const center = { q: start.q, dir: start.dir };
  const offsets = crossSection(center.q, center.dir);
  // 線路の間が島式ホームの幅だけ空いている所は島式、無ければ外側に相対式
  const slots = [];
  for (let i = 1; i < offsets.length; i++) {
    const gap = offsets[i] - offsets[i - 1];
    if (gap >= ISLAND_GAP[0] && gap <= ISLAND_GAP[1]) slots.push({ type: 'island', mid: (offsets[i] + offsets[i - 1]) / 2 });
  }
  if (slots.length === 0) {
    if (offsets.length === 1) {
      // 線路が1本なら、駅のある側に置く
      const n = [-center.dir[1], center.dir[0]];
      const side = (p[0] - center.q[0]) * n[0] + (p[1] - center.q[1]) * n[1] >= 0 ? 1 : -1;
      slots.push({ type: 'side', track: offsets[0], sign: side });
    } else {
      slots.push({ type: 'side', track: offsets[0], sign: -1 });
      slots.push({ type: 'side', track: offsets[offsets.length - 1], sign: 1 });
    }
  }
  const forward = walkTrack(center.q, center.dir, TEMPLATE_LENGTH / 2);
  const backward = walkTrack(center.q, [-center.dir[0], -center.dir[1]], TEMPLATE_LENGTH / 2).map((s) => ({
    q: s.q,
    dir: [-s.dir[0], -s.dir[1]],
  }));
  const out = [];
  for (const slot of slots) {
    const at = (s, sl) => {
      const e = platformEdges(crossSection(s.q, s.dir), sl);
      if (!e) return null;
      const n = [-s.dir[1], s.dir[0]];
      return [e.map((o) => [s.q[0] + n[0] * o, s.q[1] + n[1] * o]), e];
    };
    const mid = at(center, { ...slot });
    if (!mid) continue;
    const run = (samples) => {
      const sl = { ...slot };
      const pts = [];
      for (const s of samples) {
        const r = at(s, sl);
        if (!r) break;
        pts.push(r[0]);
      }
      return pts;
    };
    const pts = [...run(backward).reverse(), mid[0], ...run(forward)];
    if ((pts.length - 1) * TEMPLATE_STEP < TEMPLATE_MIN_LENGTH) continue;
    // 縁の片方を行きに、もう片方を帰りにたどった輪
    out.push([...pts.map((e) => e[0]), ...pts.map((e) => e[1]).reverse()]);
  }
  return out;
}

const platformRings = [...records.filter((r) => r.kind === 2).map((r) => r.ring), ...undergroundRings];
let templated = 0;
const templatedStations = [];
stations.forEach((s, station) => {
  if (/貨物/.test(s.name)) return;
  // ホームのデータがある駅はそれを使う
  if (platformRings.some((ring) => ring.some((p) => meters(p, s) < TEMPLATE_HAS_PLATFORM))) return;
  const made = templatePlatforms(s);
  if (made.length === 0) return;
  for (const ring of made) {
    records.push({ kind: 2, height: CANOPY_HEIGHT, station, ring: ring.map(fromPlane), template: true });
  }
  templated += made.length;
  templatedStations.push(s.name);
});

// ---- テンプレート：屋根のデータがほとんど無い地上のホームに、ホームと同じ形の上屋を置く ----
const roofRings = records.filter((r) => r.kind === 1).map((r) => r.ring.map(toPlane));
const insidePlane = (p, ring) => {
  let r = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[j];
    if (ay > p[1] !== by > p[1] && p[0] < ((bx - ax) * (p[1] - ay)) / (by - ay) + ax) r = !r;
  }
  return r;
};
let canopies = 0;
for (const r of [...records]) {
  if (r.kind !== 2) continue;
  const ring = r.ring.map(toPlane);
  // 地上の線路がそばに無いホーム（地下の駅）には置かない
  if (!ring.some((p) => nearestTrack(p, 6))) continue;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const near = roofRings.filter((rr) =>
    rr.some((p) => p[0] > box[0] - 30 && p[0] < box[2] + 30 && p[1] > box[1] - 30 && p[1] < box[3] + 30),
  );
  let inside = 0;
  let covered = 0;
  for (let x = box[0]; x <= box[2]; x += 2) {
    for (let y = box[1]; y <= box[3]; y += 2) {
      if (!insidePlane([x, y], ring)) continue;
      inside++;
      if (near.some((rr) => insidePlane([x, y], rr))) covered++;
    }
  }
  if (inside === 0 || covered / inside >= CANOPY_COVERED) continue;
  records.push({ kind: 1, height: r.height, station: r.station, ring: r.ring, template: true });
  canopies++;
}

const tiles = new Map();
const q = (v) => Math.round(v * 1e6);
// 高架（layer 1 以上）の印が付いたホーム（'x/y#番号'）。駅の高さを決めるのに使う（build-rail-heights.mjs）
const elevated = [];
for (const { kind, height, station, ring, layer } of records) {
  // 大屋根の駅（PLATEAU の駅舎を屋根として残す。build-station-cutouts.mjs の BIG_ROOFS）には上屋を置かない
  if (kind === 1 && BIG_ROOF_STATIONS.includes(stations[station].name)) continue;
  const center = {
    lat: ring.reduce((a, p) => a + p.lat, 0) / ring.length,
    lon: ring.reduce((a, p) => a + p.lon, 0) / ring.length,
  };
  const coords = [];
  let plat = 0;
  let plon = 0;
  for (const p of ring) {
    coords.push(q(p.lat) - plat, q(p.lon) - plon);
    plat = q(p.lat);
    plon = q(p.lon);
  }
  const key = tileOf(center.lat, center.lon);
  if (!tiles.has(key)) tiles.set(key, []);
  if (kind === 2 && layer >= 1) elevated.push(`${key}#${tiles.get(key).length}`);
  tiles.get(key).push([kind, Math.round(height * 10) / 10, station, coords]);
}

if (!partial) await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(new URL('./', ELEVATED_FILE), { recursive: true });
await writeFile(ELEVATED_FILE, JSON.stringify(elevated.sort()));
let bytes = 0;
for (const [key, data] of tiles) {
  const [x, y] = key.split('/');
  await mkdir(new URL(`${x}/`, OUT_DIR), { recursive: true });
  const json = JSON.stringify(data);
  bytes += json.length;
  await writeFile(new URL(`${x}/${y}.json`, OUT_DIR), json);
}
console.log(
  `${ways.size} ways, ${relations.size} relations → ${records.length} roofs and platforms near stations ` +
    `(${lines} platforms drawn as lines, ${fromRelations} from relations), ${tiles.size} tiles, ` +
    `${(bytes / 1e6).toFixed(2)} MB`,
);
console.log(
  `templates: ${templated} platforms at ${templatedStations.length} stations, ${canopies} canopies\n  ${templatedStations.join(' ')}`,
);
