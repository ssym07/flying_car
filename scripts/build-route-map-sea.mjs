// 路線図の海（public/route-map-sea.json、大阪は public/osaka/route-map-sea.json）を作る。src/ui/routeMap.ts が背景に水色で塗る。
// 使い方: node scripts/build-route-map-sea.mjs（fetch-route-map.mjs の後に実行。REGION=osaka で大阪）
//
// - 海の形：国土地理院の淡色地図（ズーム ZOOM）の水色の画素を水とし、「開く」（RIVER m 縮めてから広げる）で川・運河・池を落とす。
//   残った水のうち、広さが MIN_SEA km² 以上のかたまりを海とする
// - 路線図は駅を動かした模式図なので、海も同じように動かす：まず路線図と同じ「中心から外へ広げる」変形をし、
//   残りのずれ（駅をまっすぐに並べた分）は、まわりの駅のずれを距離のガウス分布の重みでなめらかに足す
// - 出力：升の中心を結んだ格子の四角ごとに、海の部分の多角形（マーチングスクエア。海岸線が斜めにつながる）。
//   全部が海の四角は横につないで、長くても STRIP 個で区切る（曲がりに沿わせる）。座標は模式図（km、0.01 単位）
//
// 出力の形式: { "b": [左, 上, 右, 下]（路線図を動かせる範囲）, "p": [[x, y, x, y, ...], ...], "w": [[駅名, 駅名], ...]（駅のある島へ海を渡る区間） }
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { decodePng } from './lib/dem.mjs';
import { AREAS, BOUNDS, regionPath, SETTINGS } from './lib/region.mjs';

const ROUTE_MAP = regionPath('public/route-map.json');
const OUT = regionPath('public/route-map-sea.json');
const CACHE = new URL('../data/cache/pale/', import.meta.url);
const ZOOM = 11;
/** 範囲の外へ広げる量（度）：路線図を引いて見た時の、端の向こうの海も塗る */
const MARGIN = 0.7;
/** 海の升の大きさ (m)、川を落とす幅 (m)、海とみなす広さ (km²)、帯の長さ（升） */
const CELL = 125;
const RIVER = 250;
const MIN_SEA = 8;
/** 範囲からこれ（度）より離れた水のかたまりは描かない */
const NEAR = 0.2;
/** 水にする細い陸の線の幅の半分（升の数）。1 なら幅 250m 弱まで */
const BRIDGE_CELLS = 1;
const STRIP = 10;
/** 駅から遠い所（模式図のずれがほとんど無い所）は、全部が海の四角を長くつなぐ */
const STRIP_FAR = 80;

const K = Math.PI / 180;
const n = 2 ** ZOOM;
const tileX = (lon) => ((lon + 180) / 360) * n;
const tileY = (lat) => ((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n;
const [S, W, N, E] = [BOUNDS[0] - MARGIN, BOUNDS[1] - MARGIN, BOUNDS[2] + MARGIN, BOUNDS[3] + MARGIN];

// ---- 淡色地図の画素 → 水かどうか ----
const tx0 = Math.floor(tileX(W));
const tx1 = Math.floor(tileX(E));
const ty0 = Math.floor(tileY(N));
const ty1 = Math.floor(tileY(S));
const tiles = new Map();
await mkdir(CACHE, { recursive: true });
for (let x = tx0; x <= tx1; x++) {
  for (let y = ty0; y <= ty1; y++) {
    const file = new URL(`${ZOOM}-${x}-${y}.png`, CACHE);
    let buf = await readFile(file).catch(() => null);
    if (!buf) {
      for (let attempt = 0; attempt < 5 && !buf; attempt++) {
        const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/pale/${ZOOM}/${x}/${y}.png`).catch(() => null);
        if (res?.ok) buf = Buffer.from(await res.arrayBuffer());
        else if (res?.status === 404) break;
        else await new Promise((r) => setTimeout(r, 2000));
      }
      if (buf) await writeFile(file, buf);
    }
    tiles.set(`${x}/${y}`, buf ? decodePng(buf) : null);
  }
}
// 淡色地図の水色（src/world/water.ts の isWaterColor と同じ）
const isWater = (r, g, b) => b > 0xf0 && r < 0xd0 && g < 0xe2 && g > r && b - r > 40;
const waterAt = (lat, lon) => {
  const fx = tileX(lon);
  const fy = tileY(lat);
  const t = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
  if (!t) return 0;
  const px = Math.min(255, Math.floor((fx % 1) * 256));
  const py = Math.min(255, Math.floor((fy % 1) * 256));
  const k = (py * 256 + px) * 3;
  return isWater(t[k], t[k + 1], t[k + 2]) ? 1 : 0;
};

// ---- 升の格子（行 0 が北） ----
const MX = 111320 * Math.cos(SETTINGS.lat0 * K);
const dLat = CELL / 111320;
const dLon = CELL / MX;
const cols = Math.ceil((E - W) / dLon);
const rows = Math.ceil((N - S) / dLat);
const water = new Uint8Array(cols * rows);
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    // 升の中の4点の多数決（細い線の文字・道路で穴があかないよう）
    const lat = N - (r + 0.5) * dLat;
    const lon = W + (c + 0.5) * dLon;
    let v = 0;
    for (const [a, b] of [
      [-0.25, -0.25],
      [0.25, -0.25],
      [-0.25, 0.25],
      [0.25, 0.25],
    ]) {
      v += waterAt(lat + a * dLat, lon + b * dLon);
    }
    water[r * cols + c] = v >= 2 ? 1 : 0;
  }
}
// 開く：川・運河を落とす

const pass = (src, horizontal, max, R = Math.max(1, Math.round(RIVER / CELL))) => {
  const out = new Uint8Array(src.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let v = max ? 0 : 1;
      for (let d = -R; d <= R; d++) {
        const rr = horizontal ? r : r + d;
        const cc = horizontal ? c + d : c;
        // 格子の外は水とみなす（端の海が削れないように）
        const s = rr < 0 || cc < 0 || rr >= rows || cc >= cols ? 1 : src[rr * cols + cc];
        if (max ? s : !s) {
          v = max ? 1 : 0;
          break;
        }
      }
      out[r * cols + c] = v;
    }
  }
  return out;
};
// 閉じる：水の上の細い陸の線（明石海峡大橋・大鳴門橋などの橋、防波堤）を水にする。
// 橋が残ると淡路島が本州・四国と陸続きになる
{
  const closed = pass(pass(pass(pass(water, true, true, BRIDGE_CELLS), false, true, BRIDGE_CELLS), true, false, BRIDGE_CELLS), false, false, BRIDGE_CELLS);
  water.set(closed);
}
const opened = pass(pass(pass(pass(water, true, false), false, false), true, true), false, true);
// 開いた後も残り、元も水の升のうち、広いかたまりだけ
const sea = new Uint8Array(cols * rows);
{
  const seen = new Uint8Array(cols * rows);
  const minCells = (MIN_SEA * 1e6) / (CELL * CELL);
  for (let start = 0; start < cols * rows; start++) {
    if (!opened[start] || !water[start] || seen[start]) continue;
    const members = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop();
      members.push(p);
      const r = Math.floor(p / cols);
      const c = p % cols;
      for (const [dr, dc] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const q = rr * cols + cc;
        if (opened[q] && water[q] && !seen[q]) ((seen[q] = 1), stack.push(q));
      }
    }
    // データを取る範囲から NEAR 度（約 20km）以内にかからない水（大阪から見た日本海・若狭湾など）は描かない。
    // 模式図の端に、まわりとつながらない湖のような切れ端として出てしまう
    const near = members.some((p) => {
      const lat = N - (Math.floor(p / cols) + 0.5) * dLat;
      const lon = W + ((p % cols) + 0.5) * dLon;
      return AREAS.some(([s, w, n, e]) => lat >= s - NEAR && lat <= n + NEAR && lon >= w - NEAR && lon <= e + NEAR);
    });
    if (near && members.length >= minCells) for (const p of members) sea[p] = 1;
  }
}
// 海から水づたいに HARBOR m までの水（港・運河の入口・広い川の河口）も海にする（開くと消える、埠頭の間の水面など）
{
  const HARBOR = 1500;
  const steps = Math.round(HARBOR / CELL);
  let front = [];
  for (let p = 0; p < cols * rows; p++) if (sea[p]) front.push(p);
  for (let k = 0; k < steps && front.length > 0; k++) {
    const next = [];
    for (const p of front) {
      const r = Math.floor(p / cols);
      const c = p % cols;
      for (const [dr, dc] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const q = rr * cols + cc;
        if (water[q] && !sea[q]) ((sea[q] = 1), next.push(q));
      }
    }
    front = next;
  }
}
/** 残した駅のある小さな島（中部国際空港など）。海岸線をぼかさず、角のある形のまま描く */
const island = new Uint8Array(cols * rows);
/** 島ごとの升と、島にある駅（模式図ではこの駅に合わせて、島をゆがめずにそのまま動かす） */
const islands = [];
// 海の中の小さな陸（地図の海の名前の文字の跡・小さな島）は海にする：格子の端に触れない、HOLE km² より小さい陸のかたまり
{
  const HOLE = 6;
  const stationCells = new Map();
  for (const st of JSON.parse(await readFile(regionPath('src/data/stations.json'), 'utf8'))) {
    const r = Math.floor((N - st.lat) / dLat);
    const c = Math.floor((st.lon - W) / dLon);
    if (r >= 0 && c >= 0 && r < rows && c < cols) stationCells.set(r * cols + c, st);
  }
  const seen = new Uint8Array(cols * rows);
  const maxCells = (HOLE * 1e6) / (CELL * CELL);
  for (let start = 0; start < cols * rows; start++) {
    if (sea[start] || seen[start]) continue;
    const members = [];
    const stack = [start];
    seen[start] = 1;
    let edge = false;
    while (stack.length > 0) {
      const p = stack.pop();
      members.push(p);
      const r = Math.floor(p / cols);
      const c = p % cols;
      for (const [dr, dc] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) {
          edge = true;
          continue;
        }
        const q = rr * cols + cc;
        if (!sea[q] && !seen[q]) ((seen[q] = 1), stack.push(q));
      }
    }
    // 駅のある島（中部国際空港・神戸空港など）は小さくても残す
    if (!edge && members.length <= maxCells) {
      const stops = members.filter((p) => stationCells.has(p)).map((p) => stationCells.get(p));
      if (stops.length === 0) for (const p of members) sea[p] = 1;
      else {
        for (const p of members) island[p] = 1;
        islands.push({ members, stops });
      }
    }
  }
}

if (process.env.DEBUG) {
  // 確認用の画像（PPM）：白 = 陸、水色 = 水、青 = 海
  const px = Buffer.alloc(cols * rows * 3);
  for (let i = 0; i < cols * rows; i++)
    px.set(sea[i] ? [30, 80, 220] : water[i] ? [140, 200, 240] : [245, 245, 240], i * 3);
  await writeFile(process.env.DEBUG, Buffer.concat([Buffer.from(`P6 ${cols} ${rows} 255\n`), px]));
}
// ---- 格子の点を模式図の座標へ ----
const route = JSON.parse(await readFile(ROUTE_MAP, 'utf8'));
// scripts/fetch-route-map.mjs と同じ：中心（SETTINGS.center）からの距離 r km を 6 × (r / 6)^0.7 に広げる
const cosLat = Math.cos(SETTINGS.lat0 * K);
const C = [SETTINGS.center[1] * 111.32 * cosLat, -SETTINGS.center[0] * 110.95];
const expand = (lat, lon) => {
  const x = lon * 111.32 * cosLat - C[0];
  const y = -lat * 110.95 - C[1];
  const r = Math.hypot(x, y) || 1e-6;
  const k = (6 * (r / 6) ** 0.7) / r;
  return [x * k, y * k];
};
// 駅ごとの残りのずれ（広げた位置 → 路線図の位置）
const stops = route.stations.map(([, lat, lon, x, y]) => {
  const [ex, ey] = expand(lat, lon);
  return { ex, ey, dx: x - ex, dy: y - ey };
});
/** ずれをならす幅（km、広げた後の座標） */
const SIGMA = 2.5;
const BIN = SIGMA * 3;
const bins = new Map();
for (const s of stops) {
  const k = `${Math.floor(s.ex / BIN)},${Math.floor(s.ey / BIN)}`;
  if (!bins.has(k)) bins.set(k, []);
  bins.get(k).push(s);
}
const toSchematic = (lat, lon) => {
  const [ex, ey] = expand(lat, lon);
  const bx = Math.floor(ex / BIN);
  const by = Math.floor(ey / BIN);
  let wx = 0;
  let wy = 0;
  let ws = 0;
  for (let i = bx - 1; i <= bx + 1; i++) {
    for (let j = by - 1; j <= by + 1; j++) {
      for (const s of bins.get(`${i},${j}`) ?? []) {
        const d2 = (s.ex - ex) ** 2 + (s.ey - ey) ** 2;
        const w = Math.exp(-d2 / (2 * SIGMA * SIGMA));
        wx += s.dx * w;
        wy += s.dy * w;
        ws += w;
      }
    }
  }
  // まわりに駅が少ない所（沖）は、ずれを小さくする（広げた位置のまま）
  const blend = ws / (ws + 0.3);
  return ws > 0 ? [ex + (wx / ws) * blend, ey + (wy / ws) * blend] : [ex, ey];
};
// 升の中心の点（行 r・列 c）を模式図の座標へ
// 駅のある島：島の駅の路線図の位置を基準に、島の中心での縮尺のまま（形を変えずに）置く。
// 島から ISLAND_FADE 升までの海は、その置き方からふつうのゆがめ方へ少しずつ戻す（海岸線が切れないように）
const ISLAND_FADE = 10;
const flat = (lat, lon) => [lon * 111.32 * cosLat, -lat * 110.95];
const rigid = islands.map(({ members, stops }) => {
  let lat = 0;
  let lon = 0;
  for (const p of members) {
    lat += N - (Math.floor(p / cols) + 0.5) * dLat;
    lon += W + ((p % cols) + 0.5) * dLon;
  }
  const [cx, cy] = flat(lat / members.length, lon / members.length);
  const r = Math.hypot(cx - C[0], cy - C[1]) || 1e-6;
  const k = (6 * (r / 6) ** 0.7) / r;
  const st = stops.map((s) => route.stations.find(([name]) => name === s.name)).find(Boolean);
  if (!st) return null;
  const [sx, sy] = flat(st[1], st[2]);
  return (lat2, lon2) => {
    const [x, y] = flat(lat2, lon2);
    return [st[3] + (x - sx) * k, st[4] + (y - sy) * k];
  };
});
// 島からの距離（升）と、どの島か
const islandDist = new Uint8Array(cols * rows).fill(255);
const islandOf = new Int16Array(cols * rows).fill(-1);
{
  let front = [];
  islands.forEach(({ members }, i) => {
    if (!rigid[i]) return;
    for (const p of members) ((islandDist[p] = 0), (islandOf[p] = i), front.push(p));
  });
  for (let d = 1; d <= ISLAND_FADE && front.length > 0; d++) {
    const next = [];
    for (const p of front) {
      const r = Math.floor(p / cols);
      const c = p % cols;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const q = rr * cols + cc;
        if (islandDist[q] === 255) ((islandDist[q] = d), (islandOf[q] = islandOf[p]), next.push(q));
      }
    }
    front = next;
  }
}
const vert = new Map();
const vertex = (r, c) => {
  const k = r * cols + c;
  if (!vert.has(k)) {
    const lat = N - (r + 0.5) * dLat;
    const lon = W + (c + 0.5) * dLon;
    const base = toSchematic(lat, lon);
    const d = islandDist[k];
    if (d === 255) vert.set(k, base);
    else {
      // 島とすぐ外（2 升）はそのまま、そこから ISLAND_FADE 升でふつうのゆがめ方へ
      const w = Math.min(1, Math.max(0, (ISLAND_FADE - d) / (ISLAND_FADE - 2)));
      const p = rigid[islandOf[k]](lat, lon);
      vert.set(k, [base[0] + (p[0] - base[0]) * w, base[1] + (p[1] - base[1]) * w]);
    }
  }
  return vert.get(k);
};
// ---- 海岸線のデフォルメ：海を 0/1 の値にして SMOOTH m ぼかし、0.5 の所を海岸線にする（入り組んだ港・小さな岬が丸くなる） ----
const SMOOTH = 900;
// 駅のある島は、まわりの海と一緒にぼかすと丸い形になるので、海としてぼかしてから島の升だけ陸に戻す
const field = Float32Array.from(sea, (v, i) => v || island[i]);
{
  const rad = Math.max(1, Math.round(SMOOTH / CELL / 2));
  const tmp = new Float32Array(field.length);
  // 箱型のぼかしを横・縦に 3 回ずつ（ガウスのぼかしに近い）。格子の外は端の値を延ばす
  for (let pass = 0; pass < 3; pass++) {
    for (let r = 0; r < rows; r++) {
      let sum = 0;
      const at = (c) => field[r * cols + Math.min(cols - 1, Math.max(0, c))];
      for (let c = -rad; c <= rad; c++) sum += at(c);
      for (let c = 0; c < cols; c++) {
        tmp[r * cols + c] = sum / (2 * rad + 1);
        sum += at(c + rad + 1) - at(c - rad);
      }
    }
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      const at = (r) => tmp[Math.min(rows - 1, Math.max(0, r)) * cols + c];
      for (let r = -rad; r <= rad; r++) sum += at(r);
      for (let r = 0; r < rows; r++) {
        field[r * cols + c] = sum / (2 * rad + 1);
        sum += at(r + rad + 1) - at(r - rad);
      }
    }
  }
}
// 島は狭くぼかす（ISLAND_SMOOTH m の箱を1回。升の階段は消えて、角は残る）
{
  const ISLAND_SMOOTH = 250;
  const rad = Math.max(1, Math.round(ISLAND_SMOOTH / CELL / 2));
  let a = Float32Array.from(island);
  for (let pass = 0; pass < 1; pass++) {
    const b = new Float32Array(a.length);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let d = -rad; d <= rad; d++) sum += a[r * cols + Math.min(cols - 1, Math.max(0, c + d))];
        b[r * cols + c] = sum / (2 * rad + 1);
      }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let d = -rad; d <= rad; d++) sum += b[Math.min(rows - 1, Math.max(0, r + d)) * cols + c];
        a[r * cols + c] = sum / (2 * rad + 1);
      }
  }
  for (let i = 0; i < field.length; i++) if (a[i] > 0) field[i] = Math.min(field[i], 1 - a[i]);
}
const valueAt = (r, c) => field[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
/** 角 a・b の間の、値が 0.5 になる所（線形に補間） */
const cross = (a, b) => {
  const va = valueAt(a[0], a[1]);
  const vb = valueAt(b[0], b[1]);
  const t = Math.min(1, Math.max(0, (0.5 - va) / (vb - va || 1e-6)));
  const pa = vertex(a[0], a[1]);
  const pb = vertex(b[0], b[1]);
  return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
};
/** その点のまわり（広げた後の座標で 4×SIGMA km）に駅が無いか */
const farFromStations = (r, c) => {
  const [ex, ey] = expand(N - (r + 0.5) * dLat, W + (c + 0.5) * dLon);
  const bx = Math.floor(ex / BIN);
  const by = Math.floor(ey / BIN);
  for (let i = bx - 2; i <= bx + 2; i++) for (let j = by - 2; j <= by + 2; j++) if (bins.has(`${i},${j}`)) return false;
  return true;
};
const isSea = (r, c) => (valueAt(r, c) >= 0.5 ? 1 : 0);

// ---- マーチングスクエア：4つの升の中心を角とする四角ごとに、海の部分の多角形 ----
const polys = [];
const round = (v) => Math.round(v * 100) / 100;
const push = (pts) => polys.push(pts.flat().map(round));
for (let r = 0; r < rows - 1; r++) {
  let c = 0;
  while (c < cols - 1) {
    const full = (cc) => isSea(r, cc) && isSea(r, cc + 1) && isSea(r + 1, cc + 1) && isSea(r + 1, cc);
    if (full(c)) {
      // 全部が海の四角は横につなぐ
      const c0 = c;
      const far = farFromStations(r, c0);
      // 島のまわり（ゆがめ方が升ごとに変わる所）はつながない（つなぐと四角の間にすき間ができる）
      const nearIsland = (cc) => islandDist[r * cols + cc] !== 255 || islandDist[(r + 1) * cols + cc] !== 255;
      do c++;
      while (c < cols - 1 && full(c) && c - c0 < (far ? STRIP_FAR : STRIP) && !nearIsland(c) && !nearIsland(c0));
      push([vertex(r, c0), vertex(r, c), vertex(r + 1, c), vertex(r + 1, c0)]);
      continue;
    }
    // 角（左上・右上・右下・左下）を回り、海の角と、海と陸の間の辺の中点を並べる
    const corners = [
      [r, c],
      [r, c + 1],
      [r + 1, c + 1],
      [r + 1, c],
    ];
    const inside = corners.map(([rr, cc]) => isSea(rr, cc));
    if (inside.some(Boolean)) {
      const pts = [];
      for (let k = 0; k < 4; k++) {
        const a = corners[k];
        const b = corners[(k + 1) % 4];
        if (inside[k]) pts.push(vertex(a[0], a[1]));
        if (inside[k] !== inside[(k + 1) % 4]) pts.push(cross(a, b));
      }
      if (pts.length >= 3) push(pts);
    }
    c++;
  }
}
// 動かせる範囲：格子の外周をゆがめた形の、内側に収まる長方形 [左, 上, 右, 下]（ゆがんだ外周の角の外を見せない）
const inner = [-Infinity, -Infinity, Infinity, Infinity];
for (let c = 0; c < cols; c += 4) {
  inner[1] = Math.max(inner[1], vertex(0, c)[1]);
  inner[3] = Math.min(inner[3], vertex(rows - 1, c)[1]);
}
for (let r = 0; r < rows; r += 4) {
  inner[0] = Math.max(inner[0], vertex(r, 0)[0]);
  inner[2] = Math.min(inner[2], vertex(r, cols - 1)[0]);
}
// 島の駅と島の外の駅を結ぶ区間（海を渡る橋）。路線図はこの区間のまわりを陸の色で塗らない（島が陸とつながって見えないように）
const onIsland = new Set(islands.flatMap(({ stops }) => stops.map((s) => s.name)));
const bridges = [];
for (const [, , ids] of route.lines) {
  for (let k = 1; k < ids.length; k++) {
    const a = route.stations[ids[k - 1]][0];
    const b = route.stations[ids[k]][0];
    if (onIsland.has(a) !== onIsland.has(b)) bridges.push([a, b]);
  }
}
await writeFile(OUT, JSON.stringify({ b: inner.map(round), p: polys, w: bridges }));
if (bridges.length > 0) console.log(`bridges to islands: ${bridges.map((p) => p.join('–')).join(', ')}`);
console.log(
  `${cols}×${rows} cells, ${sea.reduce((a, b) => a + b, 0)} sea cells → ${polys.length} polygons → ${OUT.pathname}`,
);
