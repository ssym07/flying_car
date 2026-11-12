// 高速道路の JCT・IC の名前と位置（public/junctions.json、大阪は public/kinki/junctions.json）を作る。src/ui/minimap.ts が地図に出す。
// 使い方: node scripts/fetch-expressway-junctions.mjs（REGION= で地域）
//
// - OpenStreetMap の highway=motorway_junction（本線から分かれる点）のうち、名前のあるもの。
//   SA・PA への分岐は除く。名前に JCT・ジャンクションがあれば JCT、ほかは IC（出入口）
// - 同じ名前の点（上り・下り、ランプごと）は、近いもの（GROUP m 以内）をまとめて1つにし、位置はその平均
// - データを取る範囲（AREAS）の中のものだけ
//
// 出力の形式: { "j": [[名前, 緯度, 経度, 種類（0 IC・1 JCT）], ...] }
// データ: © OpenStreetMap contributors (ODbL)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AREAS, BOUNDS, REGION_ID, regionPath } from './lib/region.mjs';

const OUT = regionPath('public/junctions.json');
/** 取った点のキャッシュ（名前のそろえ方を変えた時に取り直さない。範囲を広げたら消す） */
const CACHE = new URL(`../data/cache/junctions-${REGION_ID}.json`, import.meta.url);
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** 同じ名前の点をまとめる距離 (m) */
const GROUP = 3000;

async function overpass(query) {
  // 混んでいても粘る（約20分）
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (junction script)' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(240000),
        });
        if (res.ok) return (await res.json()).elements;
        console.warn(`${endpoint} → ${res.status}`);
      } catch (e) {
        console.warn(`${endpoint} → ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 60000));
  }
  throw new Error('Overpass API から取得できませんでした');
}

let elements = await readFile(CACHE, 'utf8').then(JSON.parse, () => null);
if (!elements) {
  elements = await overpass(`[out:json][timeout:200];
    node["highway"="motorway_junction"]["name"](${BOUNDS.join(',')});
    out;`);
  await mkdir(new URL('./', CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(elements));
}

const inArea = (lat, lon) => AREAS.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);
const K = Math.PI / 180;
const dist = (a, b) => Math.hypot((a.lat - b.lat) * 110950, (a.lon - b.lon) * 111320 * Math.cos(a.lat * K));

/**
 * 名前をそろえる：全角の英字を半角に、「インターチェンジ」「ジャンクション」を IC・JCT に。
 * （上り）（仮称）などのかっこ・「第一」「北側」などの付け足しは外す。SA・PA は、スマート IC・IC と一緒なら IC の名前に、
 * SA・PA だけなら null（出さない）
 */
function normalize(raw) {
  let name = raw
    .replace(/[Ａ-Ｚａ-ｚ０-９／]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s*[（(][^）)]*[）)]\s*$/g, '')
    .replace(/スマートインター(チェンジ)?/, 'スマートIC')
    .replace(/\s*インターチェンジ/, 'IC')
    .replace(/\s*ジャンクション/, 'JCT')
    .replace(/(IC|JCT)?(第[一二三]|[東西南北]側)$/, '$1')
    .replace(/\s+(IC|JCT)$/, '$1')
    .trim();
  // 「刈谷PA/スマートIC」→「刈谷スマートIC」、「武豊IC/PA」→「武豊IC」、「山陽姫路東IC/豊富PA」→「山陽姫路東IC」
  const parts = name.split('/');
  if (parts.length > 1) {
    const ic = parts.find((p) => /(IC|JCT)$/.test(p));
    if (!ic) return null;
    name = /^スマートIC$/.test(ic) ? parts[0].replace(/(SA|PA)$/, '') + ic : ic;
  }
  if (/(SA|PA)$|サービスエリア|パーキングエリア|ハイウェイオアシス/.test(name)) return null;
  return name;
}

const groups = [];
for (const el of elements) {
  if (!inArea(el.lat, el.lon)) continue;
  const name = normalize(el.tags.name);
  if (!name) continue;
  const kind = /JCT$/.test(name) ? 1 : 0;
  const point = { lat: el.lat, lon: el.lon };
  const group = groups.find((g) => g.name === name && g.points.some((p) => dist(p, point) < GROUP));
  if (group) group.points.push(point);
  else groups.push({ name, kind, points: [point] });
}
// 都市高速の「白川出口」「白川入口」のように、近くに出口と入口がそろっていれば「白川出入口」1つにする
for (const g of groups) {
  if (!g.name.endsWith('出口')) continue;
  const base = g.name.slice(0, -2);
  const pair = groups.find((h) => h.name === `${base}入口` && h.points.some((p) => g.points.some((q) => dist(p, q) < GROUP)));
  if (!pair) continue;
  g.name = `${base}出入口`;
  g.points.push(...pair.points);
  pair.points = [];
}
const out = groups
  .filter((g) => g.points.length > 0)
  .map(({ name, kind, points }) => [
    name,
    +(points.reduce((s, p) => s + p.lat, 0) / points.length).toFixed(5),
    +(points.reduce((s, p) => s + p.lon, 0) / points.length).toFixed(5),
    kind,
  ])
  .sort((a, b) => a[0].localeCompare(b[0], 'ja'));
await writeFile(OUT, JSON.stringify({ j: out }));
console.log(`${out.length} 個（JCT ${out.filter((j) => j[3] === 1).length}・IC ${out.filter((j) => j[3] === 0).length}） → ${OUT}`);
