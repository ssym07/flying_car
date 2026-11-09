import { WATER } from '../core/config';

/**
 * 国土地理院のベクトルタイル（experimental_bvmap）の水域（waterarea）の面を、地形チャンクの水域の画像の画素に塗る。
 * 淡色地図は川の上に高速道路・幅の広い橋を描くので、その下が水色にならず地面になる（日本橋川の上の首都高など）。
 * 水域の面は道路と別の層なので、高架や橋の下も水として入っている。
 * three・DOM を使わない（Web Worker の中で動かす）。Mapbox Vector Tile の読み取りは、使う所だけを自前で書く
 */

/** 地形チャンク (x, y, z) の範囲（size × size 画素、上の行から）の水域の面。読めなかった・無ければ null */
export async function waterAreaMask(x: number, y: number, z: number, size: number): Promise<Uint8Array | null> {
  const vz = Math.min(WATER.areaZoom, z + WATER.zoomOffset);
  const k = 2 ** (vz - z);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  let drawn = false;
  await Promise.all(
    Array.from({ length: k * k }, async (_, n) => {
      const tx = x * k + (n % k);
      const ty = y * k + Math.floor(n / k);
      const url = WATER.areaUrl.replace('{z}', `${vz}`).replace('{x}', `${tx}`).replace('{y}', `${ty}`);
      let buf: Uint8Array;
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        buf = new Uint8Array(await res.arrayBuffer());
      } catch {
        return;
      }
      const layer = readLayer(buf, 'waterarea');
      if (!layer) return;
      // ベクトルタイルの座標（0..extent）→ チャンクの画素
      const scale = size / k / layer.extent;
      const ox = (tx - x * k) * (size / k);
      const oy = (ty - y * k) * (size / k);
      ctx.beginPath();
      for (const geom of layer.polygons) {
        let cx = 0;
        let cy = 0;
        for (let i = 0; i < geom.length; ) {
          const cmd = geom[i] & 7;
          const count = geom[i] >> 3;
          i++;
          if (cmd === 7) {
            ctx.closePath();
            continue;
          }
          for (let c = 0; c < count; c++) {
            cx += zigzag(geom[i]);
            cy += zigzag(geom[i + 1]);
            i += 2;
            if (cmd === 1) ctx.moveTo(ox + cx * scale, oy + cy * scale);
            else ctx.lineTo(ox + cx * scale, oy + cy * scale);
          }
        }
      }
      // 島（内側の輪）は穴にする
      ctx.fill('evenodd');
      drawn = true;
    }),
  );
  if (!drawn) return null;
  const { data } = ctx.getImageData(0, 0, size, size);
  const mask = new Uint8Array(size * size);
  let any = false;
  for (let p = 0; p < mask.length; p++) {
    if (data[p * 4 + 3] > 127) {
      mask[p] = 1;
      any = true;
    }
  }
  return any ? mask : null;
}

const zigzag = (v: number) => (v >>> 1) ^ -(v & 1);

/** 1つの層の面（type 3）の図形と extent */
function readLayer(buf: Uint8Array, name: string): { extent: number; polygons: number[][] } | null {
  const r = new Reader(buf);
  while (r.more()) {
    const [field, wire] = r.key();
    if (field === 3 && wire === 2) {
      const end = r.lengthEnd();
      const layer = { name: '', extent: 4096, polygons: [] as number[][] };
      while (r.pos < end) {
        const [f, w] = r.key();
        if (f === 1 && w === 2) layer.name = r.string();
        else if (f === 5 && w === 0) layer.extent = r.varint();
        else if (f === 2 && w === 2) {
          const fend = r.lengthEnd();
          let type = 0;
          let geom: number[] = [];
          while (r.pos < fend) {
            const [ff, fw] = r.key();
            if (ff === 3 && fw === 0) type = r.varint();
            else if (ff === 4 && fw === 2) geom = r.packed();
            else r.skip(fw);
          }
          if (type === 3) layer.polygons.push(geom);
        } else r.skip(w);
      }
      if (layer.name === name) return layer;
    } else r.skip(wire);
  }
  return null;
}

/** Protocol Buffers の読み取り（varint・長さ付きの値だけ） */
class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  more(): boolean {
    return this.pos < this.buf.length;
  }
  varint(): number {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++];
      v += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return v;
      shift += 7;
    }
  }
  key(): [number, number] {
    const k = this.varint();
    return [Math.floor(k / 8), k & 7];
  }
  lengthEnd(): number {
    const len = this.varint();
    return this.pos + len;
  }
  string(): string {
    const end = this.lengthEnd();
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, end));
    this.pos = end;
    return s;
  }
  packed(): number[] {
    const end = this.lengthEnd();
    const out: number[] = [];
    while (this.pos < end) out.push(this.varint());
    return out;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos = this.lengthEnd();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`wire type ${wire}`);
  }
}
