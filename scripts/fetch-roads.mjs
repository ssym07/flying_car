// 東京23区まわりの主要な通りの名前と位置を OpenStreetMap (Overpass API) から取得し、
// ミニマップに通り名を置くための「ラベル位置」を src/data/roadLabels.json に書き出す。
// 使い方: node scripts/fetch-roads.mjs
// データ: © OpenStreetMap contributors (ODbL)
import { writeFile } from 'node:fs/promises';

const BBOX = '35.52,139.56,35.82,139.92'; // 南,西,北,東
// 混んでいるとエラーを返すので、順に試す
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
/** ラベルを置く間隔 (m) */
const LABEL_SPACING = 350;
/** これより短い道（名前付きの区間の合計）はラベルを付けない (m) */
const MIN_LENGTH = 300;

const query = `[out:json][timeout:120];
way["highway"~"^(trunk|primary|secondary)$"]["name"](${BBOX});
out geom;`;

async function fetchElements() {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const endpoint of ENDPOINTS) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': 'sky-drive-dev/0.1 (road label script)' },
        body: new URLSearchParams({ data: query }),
      });
      if (res.ok) return (await res.json()).elements;
      console.warn(`${endpoint} → ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Overpass API から取得できませんでした');
}

const K = Math.PI / 180;
const R = 6371000;
/** 2点間の距離 (m) と方位（北から時計回り, rad） */
function measure(a, b) {
  const east = (b.lon - a.lon) * K * Math.cos(((a.lat + b.lat) / 2) * K) * R;
  const north = (b.lat - a.lat) * K * R;
  return { length: Math.hypot(east, north), bearing: Math.atan2(east, north) };
}

const elements = await fetchElements();

// 名前ごとの総延長（短い道は除く）
const totals = new Map();
for (const way of elements) {
  let length = 0;
  for (let i = 1; i < way.geometry.length; i++) length += measure(way.geometry[i - 1], way.geometry[i]).length;
  way.length = length;
  totals.set(way.tags.name, (totals.get(way.tags.name) ?? 0) + length);
}

// 各道に沿って LABEL_SPACING ごとにラベル位置を置く（道の途中から始めて、端に寄らないように）
const labels = [];
for (const way of elements) {
  const name = way.tags.name;
  if (totals.get(name) < MIN_LENGTH) continue;
  let next = LABEL_SPACING / 2;
  let walked = 0;
  for (let i = 1; i < way.geometry.length; i++) {
    const a = way.geometry[i - 1];
    const b = way.geometry[i];
    const { length, bearing } = measure(a, b);
    while (walked + length >= next) {
      const t = (next - walked) / length;
      labels.push({
        name,
        lat: +(a.lat + (b.lat - a.lat) * t).toFixed(5),
        lon: +(a.lon + (b.lon - a.lon) * t).toFixed(5),
        // 方位は 0.01 rad 刻みで十分
        b: +bearing.toFixed(2),
      });
      next += LABEL_SPACING;
    }
    walked += length;
  }
}

// 同じ名前のラベルが近すぎる（上下線が別の道になっている等）ものを間引く
const kept = [];
const grid = new Map();
const cellOf = (l) => `${Math.floor(l.lat / 0.003)}/${Math.floor(l.lon / 0.0037)}`;
for (const l of labels) {
  const [cy, cx] = cellOf(l).split('/').map(Number);
  let near = false;
  for (let dy = -1; dy <= 1 && !near; dy++) {
    for (let dx = -1; dx <= 1 && !near; dx++) {
      for (const o of grid.get(`${cy + dy}/${cx + dx}`) ?? []) {
        if (o.name === l.name && measure(o, l).length < LABEL_SPACING * 0.6) near = true;
      }
    }
  }
  if (near) continue;
  kept.push(l);
  const key = cellOf(l);
  grid.set(key, [...(grid.get(key) ?? []), l]);
}

await writeFile(new URL('../src/data/roadLabels.json', import.meta.url), JSON.stringify(kept) + '\n');
console.log(`${elements.length} ways, ${totals.size} names → ${kept.length} labels`);
