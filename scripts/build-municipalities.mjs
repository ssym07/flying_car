// エントランス（市町村を選ぶ画面）の地図のデータ（public/municipalities.json、大阪は public/kinki/municipalities.json）を作る。
// src/scenes/EntranceScene.ts が市町村の形を描き、選んだ市町村の役所の上空から飛び始める。
// 使い方: node scripts/build-municipalities.mjs（REGION= で地域）
//
// - 出す市町村は、建物を再現している市町村（src/data/wards.ts）のうち、役所がこの地域のデータの範囲（AREAS）にあるもの
// - 政令市は区をつなげて1つの市にする（大阪市・横浜市など）。東京23区は区ごと
// - 形は国土数値情報の行政区域（N03、2024 年）。隣どうしの境が同じ線になるよう、境ごとに線を簡単にする
// - 役所の位置は国土数値情報の市町村役場等（P34、2014 年）の本庁。そのあと移った役所は MOVED で直す
//
// 出力の形式: { "m": [{ "n": 名前, "p": 都府県, "h": [緯度, 経度], "hn": 役所の名前, "l": [名前を置く緯度, 経度], "r": [[経度, 緯度, 経度, 緯度, ...], ...] }] }
// 輪（r）は外周と穴の区別なし（evenodd で塗る）
// データ: 国土数値情報（行政区域データ・市町村役場等及び公的集会施設データ）（国土交通省）を加工
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AREAS, REGION_ID, regionPath } from './lib/region.mjs';

const OUT = regionPath('public/municipalities.json');
const CACHE = fileURLToPath(new URL('../data/cache/ksj/', import.meta.url));
const WARDS = new URL('../src/data/wards.ts', import.meta.url);
/** 地域ごとの都府県コード（エントランスの一覧に並べる順。ワールドの中心の都府県から） */
const PREFS = { kanto: [13, 11, 12, 14], kinki: [27, 26, 28, 29], chubu: [23, 21, 24], kyushu: [40, 41] }[REGION_ID];
/** 線を簡単にする許し幅 (m)。エントランスの地図は 1px が 50〜100m ほど */
const TOLERANCE = 40;
/** 2014 年のあとに移った役所（国土地理院の住所検索で引いた新しい住所の位置） */
const MOVED = {
  豊島区: { lat: 35.72537, lon: 139.71709 }, // 2015 年に南池袋二丁目へ
  岐阜市: { lat: 35.42699, lon: 136.76019 }, // 2021 年に司町へ
};

/** 国土数値情報の zip を落として展開し、展開したフォルダを返す */
async function ksj(dataset, file) {
  const dir = `${CACHE}${file}`;
  if (!existsSync(dir)) {
    await mkdir(CACHE, { recursive: true });
    const url = `https://nlftp.mlit.go.jp/ksj/gml/data/${dataset}/${file}.zip`;
    console.log(`取得: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    await writeFile(`${dir}.zip`, Buffer.from(await res.arrayBuffer()));
    execFileSync('unzip', ['-oq', `${dir}.zip`, '-d', dir]);
  }
  return dir;
}

const inArea = (lat, lon) => AREAS.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);

// 建物のある市区町村コード
const wardCodes = new Set([...(await readFile(WARDS, 'utf8')).matchAll(/code: '(\d+)'/g)].map((m) => m[1]));

// 役所（本庁）
const halls = [];
for (const p of PREFS) {
  const dir = await ksj('P34/P34-14', `P34-14_${p}_GML`);
  const xml = await readFile(`${dir}/P34-14_${p}.xml`, 'utf8');
  const pos = {};
  for (const m of xml.matchAll(/gml:id="(p\d+)">\s*<gml:pos>([\d.]+) ([\d.]+)/g)) pos[m[1]] = [+m[2], +m[3]];
  for (const m of xml.matchAll(
    /href="#(p\d+)"\/>\s*<ksj:administrativeAreaCode[^>]*>(\d+)<\/ksj:administrativeAreaCode>\s*<ksj:publicOfficeClassification>1<\/ksj:publicOfficeClassification>\s*<ksj:publicOfficeName>([^<]+)/g,
  )) {
    halls.push({ pref: p, code: m[2], name: m[3], lat: pos[m[1]][0], lon: pos[m[1]][1] });
  }
}

// 市町村の形（政令市は区をまとめる）。建物のある区を1つでも含む市町村だけ
const groups = new Map();
for (const p of PREFS) {
  const dir = await ksj('N03/N03-2024', `N03-20240101_${p}_GML`);
  const { features } = JSON.parse(await readFile(`${dir}/N03-20240101_${p}.geojson`, 'utf8'));
  for (const f of features) {
    const pr = f.properties;
    if (!pr.N03_004 || !f.geometry) continue;
    const key = `${p}|${pr.N03_003 ?? ''}|${pr.N03_004}`;
    if (!groups.has(key)) groups.set(key, { key, pref: p, prefName: pr.N03_001, name: pr.N03_004, polys: [], hasBuildings: false });
    const g = groups.get(key);
    g.polys.push(...(f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates));
    if (wardCodes.has(pr.N03_007)) g.hasBuildings = true;
  }
}

const munis = [];
for (const g of groups.values()) {
  const hall = halls.find((h) => h.pref === g.pref && (h.name === `${g.name}役所` || h.name === `${g.name}役場`));
  // 政令市は wards.ts に市のコード（神戸市 28100）で入っていることがある（行政区域データは区のコードだけ）
  if (!g.hasBuildings && !(hall && wardCodes.has(hall.code))) continue;
  if (!hall) {
    console.warn(`役所が見つからない: ${g.prefName}${g.name}`);
    continue;
  }
  const at = MOVED[g.name] ?? hall;
  if (!inArea(at.lat, at.lon)) continue;
  munis.push({ ...g, hall: { name: hall.name, code: hall.code, lat: at.lat, lon: at.lon } });
}

// --- 区をつなげる：同じ市の中で2回出てくる辺（区と区の境）を消して、残った辺をつなぎ直す ---
const K = Math.PI / 180;
const key = ([lon, lat]) => `${lon.toFixed(7)},${lat.toFixed(7)}`;

function dissolve(polys) {
  const edges = new Map(); // 向きを無視した辺 → 何回出てきたか
  const directed = [];
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = key(ring[i]);
        const b = key(ring[i + 1]);
        if (a === b) continue;
        const u = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(u, (edges.get(u) ?? 0) + 1);
        directed.push([a, b, ring[i + 1], u]);
      }
    }
  }
  const out = new Map(); // 始点 → 残った辺
  for (const e of directed) {
    if (edges.get(e[3]) !== 1) continue;
    if (!out.has(e[0])) out.set(e[0], []);
    out.get(e[0]).push(e);
  }
  const rings = [];
  for (const [start, list] of out) {
    while (list.length > 0) {
      let e = list.pop();
      const ring = [];
      let guard = 0;
      while (e && guard++ < 1e6) {
        ring.push(e[2]);
        if (e[1] === start) break;
        e = out.get(e[1])?.pop();
      }
      if (ring.length >= 3) rings.push([ring[ring.length - 1], ...ring]);
    }
  }
  return rings;
}

for (const m of munis) m.rings = dissolve(m.polys);

// --- 境ごとに線を簡単にする：隣の市町村と同じ境は同じ形にする（隙間や重なりが出ないように） ---
const owners = new Map(); // 点 → その点を通る市町村の番号
munis.forEach((m, i) => {
  for (const ring of m.rings) for (const p of ring) {
    const k = key(p);
    if (!owners.has(k)) owners.set(k, new Set());
    owners.get(k).add(i);
  }
});
const ownerKey = (p) => [...owners.get(key(p))].sort((a, b) => a - b).join(',');

function xy([lon, lat]) {
  return [lon * Math.cos(35 * K) * 111320, lat * 110950];
}

/** Douglas-Peucker（両端は残す） */
function dp(pts) {
  if (pts.length <= 2) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = xy(pts[s]);
    const [bx, by] = xy(pts[e]);
    let best = -1;
    let bestD = TOLERANCE;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = xy(pts[i]);
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > bestD) (bestD = d), (best = i);
    }
    if (best >= 0) {
      keep[best] = true;
      stack.push([s, best], [best, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** 輪を、通る市町村が変わる点で区切り、区切りごとに簡単にする。区切りの向きは決まった向きにそろえる（隣と同じ結果になるように） */
function simplifyRing(ring) {
  const pts = ring.slice(0, -1);
  const n = pts.length;
  const fixed = pts.map((p, i) => ownerKey(p) !== ownerKey(pts[(i + n - 1) % n]) || ownerKey(p) !== ownerKey(pts[(i + 1) % n]));
  if (!fixed.some(Boolean)) {
    // 境の変わり目が無い輪（島・飛び地）：いちばん小さい点と、そこからいちばん遠い点を残す
    let a = 0;
    for (let i = 1; i < n; i++) if (key(pts[i]) < key(pts[a])) a = i;
    let b = a;
    let far = -1;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = xy(pts[a]);
      const [x1, y1] = xy(pts[i]);
      const d = Math.hypot(x1 - x0, y1 - y0);
      if (d > far) (far = d), (b = i);
    }
    fixed[a] = fixed[b] = true;
  }
  const first = fixed.indexOf(true);
  const out = [];
  let i = first;
  do {
    let j = (i + 1) % n;
    const run = [pts[i]];
    while (!fixed[j]) run.push(pts[j]), (j = (j + 1) % n);
    run.push(pts[j]);
    const flip = key(run[0]) > key(run[run.length - 1]);
    const simple = flip ? dp(run.slice().reverse()).reverse() : dp(run);
    out.push(...simple.slice(0, -1));
    i = j;
  } while (i !== first);
  out.push(out[0]);
  return out;
}

const ringAreaKm2 = (ring) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = xy(ring[i]);
    const [xj, yj] = xy(ring[j]);
    s += xj * yi - xi * yj;
  }
  return Math.abs(s / 2) / 1e6;
};

// --- 名前を置く点：いちばん広い輪の内側で、縁からいちばん遠い点 ---
function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function edgeDistance(p, rings) {
  const [px, py] = xy(p);
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = xy(ring[j]);
      const [bx, by] = xy(ring[i]);
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
    }
  }
  return best;
}
function labelPoint(rings) {
  const main = rings.reduce((a, r) => (ringAreaKm2(r) > ringAreaKm2(a) ? r : a));
  const isIn = (p) => rings.filter((r) => inside(p, r)).length % 2 === 1;
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of main) (w = Math.min(w, x)), (e = Math.max(e, x)), (s = Math.min(s, y)), (n = Math.max(n, y));
  let [cx, cy, sx, sy] = [(w + e) / 2, (s + n) / 2, (e - w) / 2, (n - s) / 2];
  let best = [cx, cy];
  let bestD = -1;
  for (let round = 0; round < 4; round++) {
    const N = 16;
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const p = [cx - sx + (2 * sx * i) / N, cy - sy + (2 * sy * j) / N];
        if (!isIn(p)) continue;
        const d = edgeDistance(p, rings);
        if (d > bestD) (bestD = d), (best = p);
      }
    }
    [cx, cy, sx, sy] = [best[0], best[1], sx / 4, sy / 4];
  }
  return best;
}

const round = (v) => +v.toFixed(5);
const out = munis.map((m) => {
  // 簡単にしたあと小さすぎる島（0.02km² 未満）は描かない
  const rings = m.rings.map(simplifyRing).filter((r) => r.length >= 4 && ringAreaKm2(r) >= 0.02);
  const [lon, lat] = labelPoint(rings);
  return {
    code: m.hall.code,
    n: m.name,
    p: m.prefName,
    h: [round(m.hall.lat), round(m.hall.lon)],
    hn: m.hall.name,
    l: [round(lat), round(lon)],
    r: rings.map((r) => r.flatMap(([x, y]) => [round(x), round(y)])),
  };
});
// 都府県は PREFS の順、その中は市区町村コードの順（東京は千代田区から）
const prefOrder = (code) => PREFS.indexOf(+code.slice(0, 2));
out.sort((a, b) => prefOrder(a.code) - prefOrder(b.code) || a.code.localeCompare(b.code));
await writeFile(OUT, JSON.stringify({ m: out.map(({ code, ...m }) => m) }));
const points = out.reduce((s, m) => s + m.r.reduce((t, r) => t + r.length / 2, 0), 0);
console.log(`${out.length} 市区町村（点 ${points}） → ${OUT}`);
console.log(out.map((m) => m.n).join(' '));
