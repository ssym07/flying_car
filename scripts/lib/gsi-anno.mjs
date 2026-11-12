// 国土地理院の最適化ベクトルタイル（optimal_bvmap、PMTiles）の注記（Anno）を読む。
// 使い方: const notes = await gsiAnno(z, x, y) → [{ code, text, lat, lon }, ...]（点の注記だけ）
import Pbf from 'pbf';
import { PMTiles } from 'pmtiles';

const pmtiles = new PMTiles('https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles');

/** 緯度・経度 → ズーム z のタイル番号 */
export function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
}

function readValue(pbf) {
  let value = null;
  pbf.readMessage((tag, _, p) => {
    if (tag === 1) value = p.readString();
    else if (tag === 2) value = p.readFloat();
    else if (tag === 3) value = p.readDouble();
    else if (tag === 4 || tag === 5) value = p.readVarint();
    else if (tag === 6) value = p.readSVarint();
    else if (tag === 7) value = p.readBoolean();
  }, null);
  return value;
}

export async function gsiAnno(z, x, y) {
  const tile = await pmtiles.getZxy(z, x, y);
  if (!tile) return [];
  const out = [];
  new Pbf(new Uint8Array(tile.data)).readFields((tag, _, pbf) => {
    if (tag !== 3) return;
    const layer = { name: '', extent: 4096, keys: [], values: [], features: [] };
    pbf.readMessage((t, L, p) => {
      if (t === 1) L.name = p.readString();
      else if (t === 5) L.extent = p.readVarint();
      else if (t === 3) L.keys.push(p.readString());
      else if (t === 4) L.values.push(readValue(p));
      else if (t === 2) {
        const f = { type: 0, tags: [], geometry: [] };
        p.readMessage((tt, F, q) => {
          if (tt === 3) F.type = q.readVarint();
          else if (tt === 2 || tt === 4) {
            const list = tt === 2 ? F.tags : F.geometry;
            const end = q.readVarint() + q.pos;
            while (q.pos < end) list.push(q.readVarint());
          }
        }, f);
        L.features.push(f);
      }
    }, layer);
    if (layer.name !== 'Anno') return;
    for (const f of layer.features) {
      // 点（MoveTo 1つ）だけ
      if (f.type !== 1 || f.geometry.length < 3) continue;
      const props = {};
      for (let i = 0; i < f.tags.length; i += 2) props[layer.keys[f.tags[i]]] = layer.values[f.tags[i + 1]];
      const zig = (v) => (v >>> 1) ^ -(v & 1);
      const px = (x + zig(f.geometry[1]) / layer.extent) / 2 ** z;
      const py = (y + zig(f.geometry[2]) / layer.extent) / 2 ** z;
      const lon = px * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * py))) * 180) / Math.PI;
      out.push({ code: props.vt_code, text: props.vt_text ?? '', lat, lon });
    }
  }, null);
  return out;
}
