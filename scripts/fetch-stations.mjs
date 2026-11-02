// 東京23区と横浜市・川崎市まわりの駅一覧を OpenStreetMap (Overpass API) から取得し、src/data/stations.json に書き出す。
// 使い方: node scripts/fetch-stations.mjs
// データ: © OpenStreetMap contributors (ODbL)
import { writeFile } from 'node:fs/promises';
import { BBOX, regionPath } from './lib/region.mjs';

// 南,西,北,東（地域ごと。scripts/lib/region.mjs）
// 混んでいるとエラーを返すので、順に試す
const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** 同じ名前の駅をまとめる距離 (m) */
const MERGE_DISTANCE = 800;

const query = `[out:json][timeout:80];
(
  node["railway"="station"](${BBOX});
  node["public_transport"="station"]["station"~"subway|light_rail|monorail"](${BBOX});
);
out body;`;

async function fetchElements() {
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const endpoint of ENDPOINTS) {
      // つながらない取得先（通信の失敗・タイムアウト）は飛ばして次へ
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (station list script)' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(180000),
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
const elements = await fetchElements();

const distance = (a, b) => {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.hypot(x, y) * 6371000;
};

// 路線・事業者ごとに分かれている同名の駅を1つにまとめる
const stations = [];
for (const el of elements) {
  const name = el.tags?.name?.replace(/駅$/, '');
  if (!name || el.tags.railway === 'halt' || el.tags.usage === 'freight') continue;
  const p = { lat: el.lat, lon: el.lon };
  const same = stations.find((s) => s.name === name && distance(s, p) < MERGE_DISTANCE);
  if (same) {
    same.lat = (same.lat * same.n + p.lat) / (same.n + 1);
    same.lon = (same.lon * same.n + p.lon) / (same.n + 1);
    same.n++;
  } else {
    stations.push({ name, ...p, n: 1 });
  }
}

const out = stations
  .map(({ name, lat, lon }) => ({ name, lat: +lat.toFixed(6), lon: +lon.toFixed(6) }))
  .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
await writeFile(regionPath('src/data/stations.json'), JSON.stringify(out) + '\n');
console.log(`${elements.length} nodes → ${out.length} stations`);
