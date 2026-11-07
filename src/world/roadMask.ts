import { ROADS } from '../core/config';
import type { RoadClass } from './roadTemplates';
import { roadWidths } from './roadSpec';

/** 道路データ1タイルの道（RoadNetwork.ts の RoadTile と同じ並び。6番目は橋なら 0 以外） */
type RoadWay = [RoadClass, number, 0 | 1, number[], number[], unknown?];

/**
 * 地形チャンク (x, y, z) の道路を塗った size × size の画像（行 0 が北、1 = 道路）。道路データが無ければ null。
 * 道の幅は車道と歩道の幅に margin m を足したもの。bridgesOnly なら橋だけを塗る
 */
export async function roadMask(
  x: number,
  y: number,
  z: number,
  size: number,
  { margin = 1, bridgesOnly = false } = {},
): Promise<Uint8Array | null> {
  let tile: { w: RoadWay[] };
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${ROADS.tilePath.replace('{x}', `${x}`).replace('{y}', `${y}`)}`);
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    tile = await res.json();
  } catch {
    return null;
  }
  const ways = bridgesOnly ? tile.w.filter((w) => w[5]) : tile.w;
  if (ways.length === 0) return null;
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext('2d')!;
  const n = 2 ** z;
  const latMid = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  const metersPerPx = (40075016 * Math.cos((latMid * Math.PI) / 180)) / n / size;
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [cls, lanes, oneway, coords] of ways) {
    const layout = roadWidths(cls, lanes, oneway === 1);
    g.lineWidth = (layout.width + layout.sidewalk * 2 + margin * 2) / metersPerPx;
    g.beginPath();
    let lat = 0;
    let lon = 0;
    for (let i = 0; i < coords.length; i += 2) {
      lat += coords[i];
      lon += coords[i + 1];
      const px = (((lon / 1e6 + 180) / 360) * n - x) * size;
      const py = (((1 - Math.asinh(Math.tan((lat / 1e6) * (Math.PI / 180))) / Math.PI) / 2) * n - y) * size;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
  }
  const image = g.getImageData(0, 0, size, size).data;
  const mask = new Uint8Array(size * size);
  for (let i = 0; i < mask.length; i++) mask[i] = image[i * 4 + 3] > 0 ? 1 : 0;
  return mask;
}
