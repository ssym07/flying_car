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
// - 大学・短大は駅検索でも探せる（src/ui/stationSearch.ts）。検索に出す名前は、キャンパスの名前があればそれ、
//   無くて同じ名前の大学がほかにもあれば、いちばん近い駅の名前を付けて分ける（「日本大学（水道橋駅付近）」）
//
// 出力の形式: { "s": [[名前, 緯度, 経度, 種類, 検索に出す名前（大学・短大だけ）], ...] }
//   （種類：0 小学校・1 中学校・2 高校（中等教育学校も）・3 大学・短大・高専）
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
  // 「大学本部B棟」のように「大学」で始まるものは、大学の名前ではないので出さない
  if (/^旧|跡(地)?$|^大学/.test(name)) return null;
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
  // 「国立〇〇大学附属小学校」の「国立」も外す（「国立音楽大学」は大学の名前なので残す）
  if (kind <= 2) return name.replace(/^(\S{0,5}?[都道府県市区町村]立|国立(?!音楽大学)|私立|公立)\s*(?=.{3,})/, '');
  // 大学：「国立大学法人 千葉大学」→「千葉大学」
  return name.replace(/^(国立|公立)大学法人\s*/, '').replace(/^国立(?!音楽大学)(?=\S+大学)/, '');
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
  const facility = !campus && /\S/.test(rest) && /棟|館|研究|センター|コート|グラウンド|グランド|寮|病院|ラボ|研修|施設|エリア|サテライト|学部|付属|附属|農場|演習林|体育|会館|ホール|学舎|I-site|運動場|球場|競技場|プール|研究林|試験地|試験場|実験所|臨海|牧場|植物園|博物館|図書館|総合研究|跡/.test(rest);
  return { base, campus, facility };
}

const K = Math.PI / 180;
const dist = (a, b) => Math.hypot((a.lat - b.lat) * 110950, (a.lon - b.lon) * 111320 * Math.cos(a.lat * K));
const inArea = (lat, lon) => AREAS.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);

// 学校の点をそろえる（大学は大学の名前とキャンパスの名前に分ける）
const entries = [];
let dropped = 0;
const seen = new Set();
for (const el of elements) {
  if (!el.name || !inArea(el.lat, el.lon)) continue;
  // 長方形の重なりで同じ点が2回来ることがある
  const id = `${el.name},${el.lat},${el.lon}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const cleaned = clean(el.name);
  const kind = kindOf(cleaned);
  if (kind === null) {
    dropped++;
    continue;
  }
  const name = normalize(cleaned, kind);
  const uni = kind === 3 ? splitUniversity(name) : { base: name, campus: null, facility: false };
  entries.push({ ...uni, kind, point: { lat: el.lat, lon: el.lon, facility: uni.facility } });
}

// まとめる。キャンパスの名前のある点を先に、キャンパスごとに（近くの別のキャンパスとは混ぜない）。
// キャンパスの名前の無い点（「早稲田大学」「早稲田大学3号館」など）は、いちばん近い同じ大学のキャンパスに入れ、
// 近くに無ければ大学の名前だけでまとめる。キャンパスの位置は、キャンパスの名前のある点だけで決める
const groups = [];
const near = (g, point, radius) => g.points.some((p) => dist(p, point) < radius);
for (const e of entries.filter((e) => e.campus)) {
  const group = groups.find((g) => g.campus === e.campus && near(g, e.point, GROUP.university));
  if (group) group.points.push(e.point);
  else groups.push({ base: e.base, campus: e.campus, kind: e.kind, points: [e.point], extra: [] });
}
for (const e of entries.filter((e) => !e.campus)) {
  const radius = e.kind === 3 ? GROUP.university : GROUP.school;
  const candidates = groups.filter((g) => g.base === e.base && g.kind === e.kind && near(g, e.point, radius));
  // キャンパスのまとまりがあれば、いちばん近いものへ（位置は動かさない）
  const campus = candidates
    .filter((g) => g.campus)
    .sort((a, b) => Math.min(...a.points.map((p) => dist(p, e.point))) - Math.min(...b.points.map((p) => dist(p, e.point))))[0];
  if (campus) campus.extra.push(e.point);
  else if (candidates[0]) candidates[0].points.push(e.point);
  else groups.push({ base: e.base, campus: null, kind: e.kind, points: [e.point], extra: [] });
}
// 大学の建物・施設だけの点の集まり（キャンパスから離れたグラウンド・研究所など）は出さない。
// キャンパスの名前のある大学で、名前の無いまとまりがキャンパスから 4km 以内なら、大学全体を指す点などとみなして出さない
// （「大阪大学」だけの点が吹田キャンパスの 3km 西にあった）
const hasCampus = new Set(groups.filter((g) => g.campus).map((g) => g.base));
const nearCampus = (g) =>
  groups.some((c) => c.campus && c.base === g.base && c.points.some((p) => g.points.some((q) => dist(p, q) < 4000)));
const shown = groups.filter(
  (g) =>
    g.campus ||
    (g.points.some((p) => !p.facility) && !(g.kind === 3 && hasCampus.has(g.base) && nearCampus(g))),
);
dropped += groups.length - shown.length;

const rows = shown.map(({ base, campus, kind, points }) => [
  campus ?? base,
  +(points.reduce((s, p) => s + p.lat, 0) / points.length).toFixed(5),
  +(points.reduce((s, p) => s + p.lon, 0) / points.length).toFixed(5),
  kind,
]);

// 検索に出す大学・短大の名前（高専は出さない）。同じ名前が2つ以上あれば、いちばん近い駅の名前を付ける
const stations = JSON.parse(await readFile(regionPath('src/data/stations.json'), 'utf8'));
const nearestStation = (lat, lon) => {
  let best = null;
  let bestD = Infinity;
  for (const st of stations) {
    const d = dist(st, { lat, lon });
    if (d < bestD) (bestD = d), (best = st.name);
  }
  return best;
};
const universities = rows.filter((r) => r[3] === 3 && /大学/.test(r[0]));
const sameName = new Map();
for (const r of universities) sameName.set(r[0], (sameName.get(r[0]) ?? 0) + 1);
const used = new Map();
for (const r of universities) {
  let label = sameName.get(r[0]) > 1 ? `${r[0]}（${nearestStation(r[1], r[2])}駅付近）` : r[0];
  // 近い駅まで同じなら番号を付ける
  const n = (used.get(label) ?? 0) + 1;
  used.set(label, n);
  if (n > 1) label = label.replace(/）$/, ` ${n}）`);
  r.push(label);
}
const out = rows.sort((a, b) => a[0].localeCompare(b[0], 'ja'));
await writeFile(OUT, JSON.stringify({ s: out }));
const count = (k) => out.filter((s) => s[3] === k).length;
console.log(
  `${out.length} 校（小 ${count(0)}・中 ${count(1)}・高 ${count(2)}・大学など ${count(3)}。出さないもの ${dropped}） → ${OUT}`,
);
