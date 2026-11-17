// 学校の名前と位置（public/schools.json、大阪は public/kinki/schools.json）を作る。
// src/ui/minimap.ts が地図に、src/world/Labels.ts が 3D の空の上に名前を出す。
// 使い方: node scripts/fetch-schools.mjs（REGION= で地域）
//
// - OpenStreetMap の amenity=school・university・college（名前のあるもの。敷地の形なら中心）
// - 出すのは小学校・中学校・高校・中等教育学校・大学・短大・高専。名前で分ける。
//   特別支援学校・専門学校・塾・予備校・幼稚園・大学校などは出さない
// - 小・中・高の名前の頭の「市立」「府立」「私立」などは外す（地図で短く読めるように）
// - 同じ名前の点（敷地と点、大学の建物ごとの点など）は、近いもの（GROUP m 以内）をまとめて1つにし、位置はその平均
// - データを取る範囲（AREAS）の中のものだけ。長方形ごとに取ってキャッシュする（範囲を足しても前の長方形は取り直さない）
//
// 出力の形式: { "s": [[名前, 緯度, 経度, 種類], ...] }（種類：0 小学校・1 中学校・2 高校（中等教育学校も）・3 大学・短大・高専）
// データ: © OpenStreetMap contributors (ODbL)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AREAS, REGION_ID, regionPath } from './lib/region.mjs';

const OUT = regionPath('public/schools.json');
/** 取った点のキャッシュ（長方形ごと。分け方を変えた時に取り直さない） */
const CACHE = new URL(`../data/cache/schools-${REGION_ID}.json`, import.meta.url);
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** 同じ名前の点をまとめる距離 (m)（大学は敷地が広いので長め） */
const GROUP = { school: 600, university: 1500 };

async function overpass(query) {
  // 混んでいても粘る（約20分）
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (school script)' },
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
      nwr["amenity"~"^(school|university|college)$"]["name"](${key});
      out tags center;`);
    // 要るものだけ残す（キャッシュを小さく）
    cache[key] = list.map((el) => ({
      name: el.tags['name:ja'] ?? el.tags.name,
      amenity: el.tags.amenity,
      lat: +(el.lat ?? el.center.lat).toFixed(6),
      lon: +(el.lon ?? el.center.lon).toFixed(6),
    }));
    await mkdir(new URL('./', CACHE), { recursive: true });
    await writeFile(CACHE, JSON.stringify(cache));
  }
  elements.push(...cache[key]);
}

/** 全角の英数字を半角に。後ろのかっこ書き（（本校）など）は外す */
const clean = (raw) =>
  raw
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s*[（(][^）)]*[）)]\s*$/g, '')
    .trim();

/**
 * 名前から種類を決める。出さないものは null。
 * 終わりで決める（「〇〇大学附属小学校」は小学校、「〇〇中学校・高等学校」は高校）。大学・短大・高専は途中でもよい（「〇〇大学 〇〇キャンパス」）
 */
function kindOf(name) {
  // 「旧〇〇小学校」（もう無い学校）・「〇〇小学校跡」は出さない
  if (/^旧|跡(地)?$/.test(name)) return null;
  if (/支援学校|養護学校|聾学校|盲学校|専門学校|専修学校|大学校|予備校|塾|教室|幼稚園|保育|教習所/.test(name)) return null;
  if (/(高等学校|高校|中等教育学校)$/.test(name)) return 2;
  if (/(中学校|中学)$/.test(name)) return 1;
  if (/(小学校|小学)$/.test(name)) return 0;
  if (/大学|短期大学|高等専門学校|高専/.test(name)) return 3;
  return null;
}

/**
 * 頭の「市立」「堺市立」「大阪府立」「兵庫県立」などを外す（小・中・高だけ。「大阪市立大学」などはそのまま）
 */
function normalize(name, kind) {
  if (kind <= 2) return name.replace(/^(\S{0,5}?[都道府県市区町村]立|国立|私立|公立)\s*(?=.{3,})/, '');
  return name;
}

/**
 * 大学・短大・高専の名前を分ける：base は大学の名前（「京都産業大学 神山研修室棟 市原テニスコート」→「京都産業大学」）、
 * campus は「〇〇キャンパス」まで書いてあればその名前、facility は大学の中の建物・施設だけの点（研究所・〇〇棟・グラウンドなど）
 */
function splitUniversity(name) {
  const m = name.match(/^(.+?(大学院大学|短期大学|大学|高等専門学校|高専))(.*)$/);
  if (!m) return { base: name, campus: null, facility: false };
  const [, base, , rest] = m;
  const campus = /キャンパス$/.test(rest) ? `${base} ${rest.trim()}` : null;
  const facility = !campus && /\S/.test(rest) && /棟|館|研究|センター|コート|グラウンド|グランド|寮|病院|ラボ|研修|施設|エリア|サテライト|学部|付属|附属|農場|演習林|体育|会館|ホール|学舎|I-site/.test(rest);
  return { base, campus, facility };
}

const K = Math.PI / 180;
const dist = (a, b) => Math.hypot((a.lat - b.lat) * 110950, (a.lon - b.lon) * 111320 * Math.cos(a.lat * K));
const inArea = (lat, lon) => AREAS.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);

const groups = [];
let dropped = 0;
for (const el of elements) {
  if (!el.name || !inArea(el.lat, el.lon)) continue;
  const cleaned = clean(el.name);
  const kind = kindOf(cleaned);
  if (kind === null) {
    dropped++;
    continue;
  }
  const name = normalize(cleaned, kind);
  // 大学は大学の名前でまとめる（キャンパスの名前があればそれを出す）
  const uni = kind === 3 ? splitUniversity(name) : { base: name, campus: null, facility: false };
  const point = { lat: el.lat, lon: el.lon, facility: uni.facility };
  const radius = kind === 3 ? GROUP.university : GROUP.school;
  const group = groups.find((g) => g.base === uni.base && g.kind === kind && g.points.some((p) => dist(p, point) < radius));
  if (group) {
    // 長方形の重なりで同じ点が2回来ることがある
    if (!group.points.some((p) => p.lat === point.lat && p.lon === point.lon)) group.points.push(point);
    group.campus ??= uni.campus;
  } else groups.push({ base: uni.base, campus: uni.campus, kind, points: [point] });
}
// 大学の建物・施設だけの点の集まり（キャンパスから離れたグラウンド・研究所など）は出さない
const shown = groups.filter((g) => g.points.some((p) => !p.facility));
dropped += groups.length - shown.length;

const out = shown
  .map(({ base, campus, kind, points }) => [
    campus ?? base,
    +(points.reduce((s, p) => s + p.lat, 0) / points.length).toFixed(5),
    +(points.reduce((s, p) => s + p.lon, 0) / points.length).toFixed(5),
    kind,
  ])
  .sort((a, b) => a[0].localeCompare(b[0], 'ja'));
await writeFile(OUT, JSON.stringify({ s: out }));
const count = (k) => out.filter((s) => s[3] === k).length;
console.log(
  `${out.length} 校（小 ${count(0)}・中 ${count(1)}・高 ${count(2)}・大学など ${count(3)}。出さないもの ${dropped}） → ${OUT}`,
);
