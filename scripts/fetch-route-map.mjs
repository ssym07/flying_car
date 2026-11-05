// 路線図のデータ：OpenStreetMap の路線（route=train / subway / light_rail / monorail）ごとに、停車駅を順に並べて
// public/route-map.json に書き出す。駅の名前と位置は src/data/stations.json（scripts/fetch-stations.mjs）にそろえる。
// 使い方: node scripts/fetch-route-map.mjs（fetch-stations.mjs の後に実行）
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力: { rings: [[円で描く路線の番号, 中心 x, y, 半径], ...], stations: [[名前, 緯度, 経度, 模式図の x, y（km）], ...], lines: [[路線名, 色（#rrggbb）, [駅の番号, ...]], ...] }
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AREAS } from './lib/tiles.mjs';
import { regionPath, SETTINGS } from './lib/region.mjs';

const OUT = regionPath('public/route-map.json');
const CACHE = regionPath('data/cache/route-map.json');
const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** 停車位置を駅に当てはめる距離 (m) */
const SNAP = 400;
/** 色の無い路線に順に使う色 */
const PALETTE = ['#e60012', '#0079c2', '#f39700', '#009944', '#9b7cb6', '#e85298', '#00a7db', '#8f7e00', '#b5b5ac', '#d7c447'];

async function overpass(query) {
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (route map script)' },
          body: new URLSearchParams({ data: query }),
        });
        if (res.ok) return (await res.json()).elements;
        console.warn(`${endpoint} → ${res.status}`);
      } catch (e) {
        console.warn(`${endpoint} → ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
  throw new Error('Overpass API から取得できませんでした');
}

let elements = await readFile(CACHE, 'utf8').then(JSON.parse, () => null);
if (!elements) {
  elements = [];
  for (const area of AREAS) {
    const bbox = area.join(',');
    elements.push(
      ...(await overpass(`[out:json][timeout:250];
        rel["type"="route"]["route"~"^(train|subway|light_rail|monorail)$"](${bbox})->.r;
        .r out body;
        node(r.r);
        out skel qt;`)),
    );
    console.log(`${bbox}: ${elements.length} elements`);
  }
  await mkdir(new URL('./', CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(elements));
}

const nodes = new Map();
const relations = new Map();
for (const el of elements) {
  if (el.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
  else if (el.type === 'relation') relations.set(el.id, el);
}

// 駅（src/data/stations.json）：格子で近いものを探す
const stations = JSON.parse(await readFile(regionPath('src/data/stations.json'), 'utf8'));
const K = Math.PI / 180;
const CELL = 0.005;
const grid = new Map();
stations.forEach((s, i) => {
  const k = `${Math.floor(s.lat / CELL)},${Math.floor(s.lon / CELL)}`;
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(i);
});
function nearestStation([lat, lon]) {
  const cy = Math.floor(lat / CELL);
  const cx = Math.floor(lon / CELL);
  let best = -1;
  let bestD = SNAP;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const i of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
        const s = stations[i];
        const d = Math.hypot((s.lat - lat) * 111320, (s.lon - lon) * 111320 * Math.cos(lat * K));
        if (d < bestD) (bestD = d), (best = i);
      }
    }
  }
  return best;
}

// 路線（上り・下りの2つのリレーションがあるので、駅の多い方を使う）。路線名は ref か名前の「（…）」より前
const byLine = new Map();
for (const rel of relations.values()) {
  const t = rel.tags ?? {};
  const stops = [];
  for (const m of rel.members ?? []) {
    if (m.type !== 'node' || !/^(stop|stop_entry_only|stop_exit_only)$/.test(m.role)) continue;
    const p = nodes.get(m.ref);
    if (!p) continue;
    const i = nearestStation(p);
    if (i >= 0 && stops[stops.length - 1] !== i) stops.push(i);
  }
  if (stops.length < 2) continue;
  const base = (t['name:ja'] ?? t.name ?? t.ref ?? '')
    .replace(/[（(].*$/, '')
    .replace(/\s*[:：].*$/, '')
    .replace(/\s+\S*(→|->|⇒).*$/, '')
    .replace(/(上り|下り|各駅)$/, '')
    // OpenStreetMap の綴りの誤り
    .replace(/^Osaka Metor/, 'Osaka Metro')
    .trim();
  if (!base) continue;
  const key = `${t.operator ?? ''}|${base}`;
  const prev = byLine.get(key);
  if (!prev || stops.length > prev.stops.length) byLine.set(key, { name: base, operator: t.operator ?? '', colour: t.colour, stops });
}

// まとめる：快速・急行・直通運転などの種別は除き、各駅に止まる路線だけにする。
// 駅の多い路線から順に、まだ描いていない駅の間（隣どうしの駅の組）を半分以上持つものだけを残す
const SERVICE = /快速|急行|準急|特急|特快|快特|通勤|直通|ライナー|シャトル|臨時|回送|列車$|エクスプレス$|S-Train|踊り子|こまち|しおさい|ちちぶ|のぞみ|ひかり|こだま|はやて|はやぶさ|あずさ|かいじ|えのしま|ふじさん|小江戸|きぬがわ|スペーシア|成田エクスプレス|ロマンスカー|さがみ|^とき$|たにがわ|あさま|かがやき|はくたか|^ゆふ|ソニック|きらめき|かもめ|みどり|ハウステンボス|有明/;
// 載せる駅：データを取る範囲の中で、建物を作っている所（public/plateau のこの地域の区の、中身のある細かいタイルの範囲）にある駅だけ
const builtBoxes = [];
{
  const wards = JSON.parse(await readFile(new URL('../public/plateau/wards.json', import.meta.url), 'utf8').catch(() => '[]'));
  for (const ward of wards.filter((w) => SETTINGS.prefectures.some((p) => w.startsWith(p)))) {
    const tileset = JSON.parse(await readFile(new URL(`../public/plateau/${ward}/tileset.json`, import.meta.url), 'utf8').catch(() => 'null'));
    const walk = (node) => {
      const r = node.boundingVolume?.region;
      // 中身のあるタイルのうち、幅 0.03 度より細かいもの（区全体を覆う粗いタイルは使わない）
      if (node.content && r && (r[2] - r[0]) / K <= 0.03) builtBoxes.push(r.slice(0, 4).map((v) => v / K));
      for (const c of node.children ?? []) walk(c);
    };
    if (tileset) walk(tileset.root);
  }
}
const built = (lat, lon) => builtBoxes.some(([w, s, e, n]) => lat >= s && lat <= n && lon >= w && lon <= e);
const inArea = (i) =>
  AREAS.some(([s, w, n, e]) => stations[i].lat >= s && stations[i].lat <= n && stations[i].lon >= w && stations[i].lon <= e) &&
  built(stations[i].lat, stations[i].lon);
const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const drawn = new Set();
const kept = [];
for (const line of [...byLine.values()].filter((l) => !SERVICE.test(l.name)).sort((a, b) => b.stops.length - a.stops.length)) {
  const edges = [];
  for (let k = 1; k < line.stops.length; k++) edges.push(edgeKey(line.stops[k - 1], line.stops[k]));
  const fresh = edges.filter((e) => !drawn.has(e)).length;
  if (fresh < edges.length / 2) continue;
  for (const e of edges) drawn.add(e);
  // 名前の「各駅停車」「普通」は外す
  const name = line.name.replace(/\s*(各駅停車|普通|各停)$/, '').trim();
  kept.push({ ...line, name: name || line.operator });
}

// 使う駅だけに番号を振り直す。範囲の外の駅は除く（路線はそこで切る）
const used = new Map();
const outStations = [];
const lines = [];
let paletteIndex = 0;
for (const { name, colour, stops } of kept) {
  const color = /^#[0-9a-f]{6}$/i.test(colour ?? '') ? colour.toLowerCase() : PALETTE[paletteIndex++ % PALETTE.length];
  let run = [];
  const flush = () => {
    if (run.length >= 2) lines.push([name, color, run]);
    run = [];
  };
  for (const i of stops) {
    if (!inArea(i)) {
      flush();
      continue;
    }
    if (!used.has(i)) {
      used.set(i, outStations.length);
      const s = stations[i];
      outStations.push([s.name, +s.lat.toFixed(5), +s.lon.toFixed(5)]);
    }
    run.push(used.get(i));
  }
  flush();
}
/** 円で描く路線：[路線の番号, 円の中心 x, y, 半径] */
const rings = [];
// ---- 模式図の位置：路線がなるべくまっすぐ・0/45/90 度の線・同じ間隔になるよう、駅を少しずつ動かす ----
{
  const lat0 = SETTINGS.lat0;
  // 都心は駅が密なので、東京駅から外へ広げてから整える（中心からの距離 r km を 6 × (r / 6)^0.7 に）
  const C = [SETTINGS.center[1] * 111.32 * Math.cos(lat0 * K), -SETTINGS.center[0] * 110.95];
  const geo = outStations.map(([, lat, lon]) => {
    const x = lon * 111.32 * Math.cos(lat0 * K) - C[0];
    const y = -lat * 110.95 - C[1];
    const r = Math.hypot(x, y) || 1e-6;
    const k = (6 * (r / 6) ** 0.7) / r;
    return [x * k, y * k];
  });
  const pos = geo.map((p) => p.slice());
  // 環状の路線（山手線）：駅を等間隔で円の上に並べて動かさない。円の中心と半径は駅の地理の位置から
  const fixed = new Set();
  for (const [index, [name, , ids]] of lines.entries()) {
    if (!SETTINGS.ringLine.test(name)) continue;
    const ring = [...new Set(ids)];
    if (ring.length < 8) continue;
    const cx = ring.reduce((a, i) => a + geo[i][0], 0) / ring.length;
    const cy = ring.reduce((a, i) => a + geo[i][1], 0) / ring.length;
    const r = Math.max(ring.reduce((a, i) => a + Math.hypot(geo[i][0] - cx, geo[i][1] - cy), 0) / ring.length, (ring.length * 1.3) / (Math.PI * 2));
    // 回る向き：駅の並びの角度が増えるか減るか
    const angle = (i) => Math.atan2(geo[i][1] - cy, geo[i][0] - cx);
    let turn = 0;
    for (let k = 1; k < ring.length; k++) turn += Math.atan2(Math.sin(angle(ring[k]) - angle(ring[k - 1])), Math.cos(angle(ring[k]) - angle(ring[k - 1])));
    const dir = turn >= 0 ? 1 : -1;
    const base = angle(ring[0]);
    ring.forEach((i, k) => {
      const a = base + (dir * k * Math.PI * 2) / ring.length;
      pos[i] = [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
      fixed.add(i);
    });
    rings.push([index, +cx.toFixed(3), +cy.toFixed(3), +r.toFixed(3)]);
  }
  const edges = new Map();
  const triples = [];
  for (const [, , ids] of lines) {
    for (let k = 1; k < ids.length; k++) {
      const a = ids[k - 1];
      const b = ids[k];
      if (a === b) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      // 向きは、その路線の前後2駅ずつを結んだ向きで決める（1駅ずつのジグザグを向きの変化にしない）
      if (!edges.has(key)) edges.set(key, [a, b, 0, ids[Math.max(0, k - 3)], ids[Math.min(ids.length - 1, k + 2)]]);
      if (k >= 2) triples.push([ids[k - 2], a, b]);
    }
  }
  /** 駅の間の長さ：近い駅どうしは少し広げ、遠い駅どうしは縮めて、間隔をそろえる (km) */
  const target = () => 1.2;
  const MIN_GAP = 0.7;
  const move = pos.map(() => [0, 0, 0]);
  const add = (i, dx, dy, w) => {
    move[i][0] += dx * w;
    move[i][1] += dy * w;
    move[i][2] += w;
  };
  const ITER = 2500;
  for (let it = 0; it < ITER; it++) {
    for (const m of move) m.fill(0);
    // 後半は、向きを 0/45/90 度にそろえるのを優先する（まっすぐにする力は曲がり角とぶつかるので弱める）
    const late = it > ITER * 0.55;
    // まっすぐに：両隣の駅の中点へ（曲がり角の駅は弱く）
    for (const [a, b, c] of triples) {
      add(b, (pos[a][0] + pos[c][0]) / 2 - pos[b][0], (pos[a][1] + pos[c][1]) / 2 - pos[b][1], late ? 0.3 : 1.5);
    }
    for (const [a, b, len, p, q] of edges.values()) {
      const dx = pos[b][0] - pos[a][0];
      const dy = pos[b][1] - pos[a][1];
      const d = Math.hypot(dx, dy) || 1e-6;
      // 0/45/90 度の向き（前後の駅を結んだ向きに一番近いもの）と、そろえた長さ
      // 最後の 2 割は、その駅の間の向きのまま 0/45/90 度に合わせて仕上げる
      const final = it > ITER * 0.8;
      const vx = final ? dx : pos[q][0] - pos[p][0];
      const vy = final ? dy : pos[q][1] - pos[p][1];
      const ang = Math.round(Math.atan2(vy, vx) / (Math.PI / 4)) * (Math.PI / 4);
      // 長さ：前半はそろえ、後半は今の長さのまま向きだけ回す
      const L = late ? Math.max(d, MIN_GAP) : target(len);
      const tx = Math.cos(ang) * L;
      const ty = Math.sin(ang) * L;
      const ex = (tx - dx) / 2;
      const ey = (ty - dy) / 2;
      // 初めはゆるく、だんだん強く 0/45/90 度にそろえる
      const w = late ? 6 : 0.3 + 3 * (it / (ITER * 0.55));
      add(a, -ex, -ey, w);
      add(b, ex, ey, w);
      void d;
    }
    // 元の場所へ弱く
    pos.forEach((p, i) => add(i, geo[i][0] - p[0], geo[i][1] - p[1], 0.03));
    // 近すぎる駅を押し離す
    const grid = new Map();
    pos.forEach(([x, y], i) => {
      const k = `${Math.floor(x / MIN_GAP)},${Math.floor(y / MIN_GAP)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    });
    pos.forEach(([x, y], i) => {
      const gx = Math.floor(x / MIN_GAP);
      const gy = Math.floor(y / MIN_GAP);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (const j of grid.get(`${gx + ox},${gy + oy}`) ?? []) {
            if (j === i) continue;
            const dx = x - pos[j][0];
            const dy = y - pos[j][1];
            const d = Math.hypot(dx, dy) || 1e-6;
            if (d < MIN_GAP) add(i, (dx / d) * (MIN_GAP - d) * 0.5, (dy / d) * (MIN_GAP - d) * 0.5, 1);
          }
        }
      }
    });
    const step = 0.5;
    pos.forEach((p, i) => {
      if (move[i][2] === 0 || fixed.has(i)) return;
      p[0] += (move[i][0] / move[i][2]) * step;
      p[1] += (move[i][1] / move[i][2]) * step;
    });
  }
  outStations.forEach((s, i) => s.push(+pos[i][0].toFixed(3), +pos[i][1].toFixed(3)));
}
await writeFile(OUT, JSON.stringify({ stations: outStations, lines, rings }));
console.log(`${relations.size} routes → ${kept.length} lines (${lines.length} pieces), ${outStations.length} stations`);
