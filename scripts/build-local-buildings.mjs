// PLATEAU の建物タイル（src/data/wards.ts の各区）を一度だけダウンロードし、ゲームで使わないもの
// （バッチテーブルの用途・階数・住所などの属性、外壁の写真の画像）を取り除いて public/plateau/{区コード}/ に保存する。
// 建物を1棟ずつ見分けて差し替え・調整できるよう、属性のうち建物のID（gml_id）と名前（名称）だけは残す。
// 外壁はゲーム側で手続き的なテンプレートに塗り替えるので、画像は要らない。
// 保存が終わった区は public/plateau/wards.json に書き、アプリはその区を手元のデータから読む（まだの区は配信サーバーから）。
// 使い方: node scripts/build-local-buildings.mjs [区コード...]   例: node scripts/build-local-buildings.mjs 13113 13104
//   区コードを省くと23区すべて。保存済みのタイルは飛ばすので、止まっても続きから再開できる。
//   public/plateau は大きい（数百MB）ので git には入れない（.gitignore）。
//   --restrip を付けると、保存済みのタイルにも取り除く処理をかけ直す（取り除く内容を変えた時用。ダウンロードはしない）
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { AREAS } from './lib/region.mjs';

const OUT = new URL('../public/plateau/', import.meta.url);
/** 同時ダウンロード数（回線を使い切らないよう少なめ） */
const CONCURRENCY = 4;

const source = await readFile(new URL('../src/data/wards.ts', import.meta.url), 'utf8');
// コメントの行（差し替え用に残してある別のデータの URL）は読まない
const wards = [...source.matchAll(/^ {2}\{ code: '(\d+)', name: '([^']+)', kind: '[^']+', url: '([^']+)' \}/gm)].map(
  ([, code, name, url]) => ({ code, name, url }),
);
const RESTRIP = process.argv.includes('--restrip');
// --clip を付けると、地域のデータを取る範囲（scripts/lib/region.mjs の AREAS）にかからないタイルは取らない
// （京都市の左京区・右京区・北区の山奥など、道路や線路を取っていない所に建物だけ並ばないように。REGION=osaka などで地域を選ぶ）
const CLIP = process.argv.includes('--clip');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targets = only.length > 0 ? wards.filter((w) => only.includes(w.code)) : wards;

const exists = (url) => stat(url).then(() => true, () => false);

async function fetchRetry(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status === 404) throw new Error(`404 ${url}`);
      console.warn(`${res.status} ${url}`);
    } catch (e) {
      if (String(e.message).startsWith('404')) throw e;
      console.warn(`${e.message} ${url}`);
    }
    if (attempt >= 8) throw new Error(`取得できませんでした: ${url}`);
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
}

/** バッチテーブルに残す属性（建物のIDと名前） */
const KEEP_PROPERTIES = ['gml_id', '名称'];

/** b3dm のバッチテーブルを、建物のIDと名前だけにし、中の glTF から画像を取り除く */
function stripB3dm(buf) {
  if (buf.toString('ascii', 0, 4) !== 'b3dm') return buf;
  const ftJson = buf.readUInt32LE(12);
  const ftBin = buf.readUInt32LE(16);
  const btJson = buf.readUInt32LE(20);
  const btBin = buf.readUInt32LE(24);
  const ft = buf.subarray(28, 28 + ftJson + ftBin);
  const glb = stripGlb(buf.subarray(28 + ftJson + ftBin + btJson + btBin));
  // 属性は JSON の配列で入っているものだけ残す（バイナリ参照のものは本体ごと捨てるので残せない）
  const kept = {};
  if (btJson > 0) {
    const table = JSON.parse(buf.toString('utf8', 28 + ftJson + ftBin, 28 + ftJson + ftBin + btJson).trim() || '{}');
    for (const key of KEEP_PROPERTIES) {
      if (Array.isArray(table[key]) && table[key].some((v) => v !== '' && v !== null)) kept[key] = table[key];
    }
  }
  // glTF の開始位置が 8 バイト境界になるよう、JSON を空白で 8 バイトの倍数にする
  let bt = Buffer.from(JSON.stringify(kept), 'utf8');
  const pad = (8 - ((28 + ft.length + bt.length) % 8)) % 8;
  bt = Buffer.concat([bt, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(28);
  header.write('b3dm', 0, 'ascii');
  header.writeUInt32LE(buf.readUInt32LE(4), 4);
  header.writeUInt32LE(28 + ft.length + bt.length + glb.length, 8);
  header.writeUInt32LE(ftJson, 12);
  header.writeUInt32LE(ftBin, 16);
  header.writeUInt32LE(bt.length, 20);
  header.writeUInt32LE(0, 24);
  return Buffer.concat([header, ft, bt, glb]);
}

/**
 * GLB から画像・テクスチャと、EXT_structural_metadata の属性（建物のIDと名前以外）を取り除き、
 * 使われなくなった bufferView を詰める（3D Tiles 1.1 の .glb の区はこちらで属性を持っている）
 */
function stripGlb(glb) {
  if (glb.toString('ascii', 0, 4) !== 'glTF') return glb;
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/, ''));
  const metadata = json.extensions?.EXT_structural_metadata;
  if ((!json.images || json.images.length === 0) && !metadata) return glb;
  const binStart = 20 + jsonLen + 8;
  const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLen));

  // 画像と、残さない属性が使っている bufferView を捨てる
  const imageViews = new Set((json.images ?? []).map((im) => im.bufferView).filter((v) => v !== undefined));
  const VIEW_KEYS = ['values', 'stringOffsets', 'arrayOffsets'];
  for (const table of metadata?.propertyTables ?? []) {
    for (const [name, prop] of Object.entries(table.properties ?? {})) {
      if (KEEP_PROPERTIES.includes(name)) continue;
      for (const k of VIEW_KEYS) if (typeof prop[k] === 'number') imageViews.add(prop[k]);
      delete table.properties[name];
    }
  }
  for (const cls of Object.values(metadata?.schema?.classes ?? {})) {
    for (const name of Object.keys(cls.properties ?? {})) if (!KEEP_PROPERTIES.includes(name)) delete cls.properties[name];
  }
  const keep = [];
  const remap = new Map();
  json.bufferViews.forEach((view, i) => {
    if (imageViews.has(i)) return;
    remap.set(i, keep.length);
    keep.push(view);
  });
  const parts = [];
  let offset = 0;
  for (const view of keep) {
    const data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const pad = (4 - (offset % 4)) % 4;
    if (pad) parts.push(Buffer.alloc(pad));
    offset += pad;
    view.byteOffset = offset;
    view.buffer = 0;
    parts.push(data);
    offset += data.length;
  }
  const pad = (4 - (offset % 4)) % 4;
  if (pad) parts.push(Buffer.alloc(pad));
  const newBin = Buffer.concat(parts);
  json.bufferViews = keep;
  json.buffers = [{ byteLength: newBin.length }];
  // bufferView を参照している所を付け替える
  const fix = (obj) => {
    if (Array.isArray(obj)) obj.forEach(fix);
    else if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'bufferView' && typeof v === 'number') obj[k] = remap.get(v);
        else fix(v);
      }
    }
  };
  fix(json.accessors ?? []);
  fix(json.meshes ?? []);
  for (const table of metadata?.propertyTables ?? []) {
    for (const prop of Object.values(table.properties ?? {})) {
      for (const k of VIEW_KEYS) if (typeof prop[k] === 'number') prop[k] = remap.get(prop[k]);
    }
  }
  // 画像・テクスチャと、それを参照する材質の項目を消す
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    const pbr = m.pbrMetallicRoughness;
    if (pbr) {
      delete pbr.baseColorTexture;
      delete pbr.metallicRoughnessTexture;
    }
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
  }
  const drop = (list) => list?.filter((e) => e !== 'EXT_texture_webp' && e !== 'KHR_texture_transform');
  json.extensionsUsed = drop(json.extensionsUsed);
  json.extensionsRequired = drop(json.extensionsRequired);
  if (json.extensionsRequired?.length === 0) delete json.extensionsRequired;

  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jpad = (4 - (jsonBuf.length % 4)) % 4;
  if (jpad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jpad, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + newBin.length, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonBuf.length, 0);
  jsonHead.write('JSON', 4, 'ascii');
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(newBin.length, 0);
  binHead.write('BIN\0', 4, 'latin1');
  return Buffer.concat([header, jsonHead, jsonBuf, binHead, newBin]);
}

/** タイルの中身（b3dm か glb）から使わないものを取り除く */
function stripContent(buf) {
  const magic = buf.toString('ascii', 0, 4);
  if (magic === 'b3dm') return stripB3dm(buf);
  if (magic === 'glTF') return stripGlb(buf);
  return buf;
}

/** 範囲（boundingVolume.region、ラジアン）が地域のデータを取る範囲にかからない子のタイルを外す */
function clipToAreas(tileset) {
  const D = 180 / Math.PI;
  const hits = (r) => AREAS.some(([s, w, n, e]) => r[1] * D <= n && r[3] * D >= s && r[0] * D <= e && r[2] * D >= w);
  const walk = (node) => {
    if (!node.children) return;
    node.children = node.children.filter((c) => !c.boundingVolume?.region || hits(c.boundingVolume.region));
    for (const c of node.children) walk(c);
  };
  walk(tileset.root);
}

/** tileset.json の中のタイルの URI を全部集める */
function contentUris(tileset) {
  const out = [];
  const walk = (node) => {
    const uri = node.content?.uri ?? node.content?.url;
    if (uri) out.push(uri);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tileset.root);
  return out;
}

const done = new Set(await readFile(new URL('wards.json', OUT), 'utf8').then(JSON.parse, () => []));
for (const ward of targets) {
  const dir = new URL(`${ward.code}/`, OUT);
  const base = ward.url.slice(0, ward.url.lastIndexOf('/') + 1);
  const tileset = JSON.parse((await fetchRetry(ward.url)).toString('utf8'));
  if (CLIP) clipToAreas(tileset);
  const uris = contentUris(tileset);
  let downloaded = 0;
  let savedBytes = 0;
  let fetchedBytes = 0;
  let next = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (next < uris.length) {
      const uri = uris[next++];
      const file = new URL(uri, dir);
      if (await exists(file)) {
        if (RESTRIP) await writeFile(file, stripContent(await readFile(file)));
        continue;
      }
      const buf = await fetchRetry(new URL(uri, base).href);
      const out = stripContent(buf);
      await mkdir(new URL('./', file), { recursive: true });
      await writeFile(file, out);
      downloaded++;
      fetchedBytes += buf.length;
      savedBytes += out.length;
      if (downloaded % 50 === 0) {
        console.log(`  ${ward.name}: ${downloaded} tiles (${(fetchedBytes / 1e6).toFixed(0)}MB → ${(savedBytes / 1e6).toFixed(0)}MB)`);
      }
    }
  });
  await Promise.all(workers);
  // 属性の一覧（properties）はゲームでは使わないので消す
  delete tileset.properties;
  await mkdir(dir, { recursive: true });
  await writeFile(new URL('tileset.json', dir), JSON.stringify(tileset));
  done.add(ward.code);
  // ほかのスクリプト（build-gsi-buildings.mjs など）が足した区を消さないよう、書く直前に読み直して合わせる
  for (const code of await readFile(new URL('wards.json', OUT), 'utf8').then(JSON.parse, () => [])) done.add(code);
  await writeFile(new URL('wards.json', OUT), JSON.stringify([...done].sort()));
  console.log(
    `${ward.name} (${ward.code}): ${uris.length} tiles, new ${downloaded} (${(fetchedBytes / 1e6).toFixed(0)}MB → ${(savedBytes / 1e6).toFixed(0)}MB)`,
  );
}
