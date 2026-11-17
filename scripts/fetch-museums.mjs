// 美術館・科学館・博物館の名前と位置（public/museums.json、大阪は public/kinki/museums.json）を作る。
// src/ui/minimap.ts が地図に、src/world/Labels.ts が 3D の空の上に名前を出す。
// 使い方: node scripts/fetch-museums.mjs（REGION= で地域）
//
// - OpenStreetMap の tourism=museum（と、名前に「美術館」がある tourism=gallery）で名前のあるもの。敷地の形なら中心
// - 出すのは名前に「美術館」「科学館」「博物館」「ミュージアム」があるものだけ（資料館・記念館・ギャラリーなどは出さない）
// - 種類は名前のいちばん後ろにある言葉で決める（「国立科学博物館」は博物館、「〇〇美術館ミュージアムショップ」は出さない）
// - 同じ名前の点（敷地と点など）は、近いもの（GROUP m 以内）をまとめて1つにし、位置はその平均
// - データを取る範囲（AREAS）の中のものだけ。長方形ごとに取ってキャッシュする
//
// 出力の形式: { "m": [[名前, 緯度, 経度, 種類], ...] }（種類：0 美術館・1 科学館・2 博物館（ミュージアムも））
// データ: © OpenStreetMap contributors (ODbL)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AREAS, REGION_ID, regionPath } from './lib/region.mjs';

const OUT = regionPath('public/museums.json');
/** 取った点のキャッシュ（長方形ごと） */
const CACHE = new URL(`../data/cache/museums-${REGION_ID}.json`, import.meta.url);
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** 同じ名前の点をまとめる距離 (m) */
const GROUP = 500;

async function overpass(query) {
  // 混んでいても粘る（約20分）
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (museum script)' },
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

const cache = await readFile(CACHE, 'utf8').then(JSON.parse, () => ({}));
const elements = [];
for (const area of AREAS) {
  const key = area.join(',');
  if (!cache[key]) {
    console.log(`取得: ${key}`);
    const list = await overpass(`[out:json][timeout:200];
      nwr["tourism"~"^(museum|gallery)$"]["name"](${key});
      out tags center;`);
    cache[key] = list.map((el) => ({
      name: el.tags['name:ja'] ?? el.tags.name,
      tourism: el.tags.tourism,
      lat: +(el.lat ?? el.center.lat).toFixed(6),
      lon: +(el.lon ?? el.center.lon).toFixed(6),
    }));
    await mkdir(new URL('./', CACHE), { recursive: true });
    await writeFile(CACHE, JSON.stringify(cache));
  }
  elements.push(...cache[key]);
}

/** 全角の英数字を半角に。後ろのかっこ書きは外す */
const clean = (raw) =>
  raw
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s*[（(][^）)]*[）)]\s*$/g, '')
    .trim();

/** 種類（0 美術館・1 科学館・2 博物館）。名前の終わりがそれらの言葉でなければ null（「〇〇美術館 ショップ」「〇〇博物館前」など） */
function kindOf(name, tourism) {
  if (/^旧|跡(地)?$/.test(name)) return null;
  const m = name.match(/(美術館|科学館|科学未来館|博物館|ミュージアム)(\s*(本館|新館|別館|分館|[東西南北]館))?$/);
  if (!m) return null;
  const word = m[1];
  // ギャラリー（画廊）は「美術館」と名乗るものだけ
  if (tourism === 'gallery' && word !== '美術館') return null;
  if (word === '美術館') return 0;
  if (word === '科学館' || word === '科学未来館') return 1;
  return 2;
}

const K = Math.PI / 180;
const dist = (a, b) => Math.hypot((a.lat - b.lat) * 110950, (a.lon - b.lon) * 111320 * Math.cos(a.lat * K));
const inArea = (lat, lon) => AREAS.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);

const groups = [];
let dropped = 0;
const seen = new Set();
for (const el of elements) {
  if (!el.name || !inArea(el.lat, el.lon)) continue;
  const id = `${el.name},${el.lat},${el.lon}`;
  if (seen.has(id)) continue;
  seen.add(id);
  // 本館・新館・別館・分館は本体と同じ名前にしてまとめる（「五島美術館別館」→「五島美術館」）
  const name = clean(el.name).replace(/\s*(本館|新館|別館|分館)$/, '');
  // 館の名前が無いもの（「美術館別館」「郷土博物館分館」）は出さない
  const kind = /^(郷土)?(美術館|科学館|博物館|ミュージアム)$/.test(name) ? null : kindOf(name, el.tourism);
  if (kind === null) {
    dropped++;
    continue;
  }
  const point = { lat: el.lat, lon: el.lon };
  const group = groups.find((g) => g.name === name && g.points.some((p) => dist(p, point) < GROUP));
  if (group) group.points.push(point);
  else groups.push({ name, kind, points: [point] });
}

const out = groups
  .map(({ name, kind, points }) => [
    name,
    +(points.reduce((s, p) => s + p.lat, 0) / points.length).toFixed(5),
    +(points.reduce((s, p) => s + p.lon, 0) / points.length).toFixed(5),
    kind,
  ])
  .sort((a, b) => a[0].localeCompare(b[0], 'ja'));
await writeFile(OUT, JSON.stringify({ m: out }));
const count = (k) => out.filter((m) => m[3] === k).length;
console.log(`${out.length} か所（美術館 ${count(0)}・科学館 ${count(1)}・博物館 ${count(2)}。出さないもの ${dropped}） → ${OUT}`);
