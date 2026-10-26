/**
 * 駅の形（OpenStreetMap の駅舎・上屋）。PLATEAU の建物が駅かどうかの判定に使う。
 * public/station-footprints.json（scripts/build-station-footprints.mjs で作る）を1回だけ読む。
 */

interface Footprint {
  south: number;
  west: number;
  north: number;
  east: number;
  /** 緯度経度（度）の多角形 */
  ring: Array<[number, number]>;
}

/** 範囲を探しやすくする格子の大きさ（度） */
const CELL = 0.005;
const grid = new Map<string, Footprint[]>();

let loading: Promise<void> | null = null;

/** 読み込みを始め、終わったら解決する（何回呼んでもよい。失敗しても解決する） */
export function loadStationFootprints(): Promise<void> {
  loading ??= fetch(`${import.meta.env.BASE_URL}station-footprints.json`)
    .then((res) => (res.ok ? (res.json() as Promise<Array<[number, number, number, number, number[]]>>) : []))
    .then((data) => {
      for (const [s, w, n, e, coords] of data) {
        const ring: Array<[number, number]> = [];
        let lat = 0;
        let lon = 0;
        for (let i = 0; i < coords.length; i += 2) {
          lat += coords[i];
          lon += coords[i + 1];
          ring.push([lat / 1e6, lon / 1e6]);
        }
        const fp = { south: s / 1e6, west: w / 1e6, north: n / 1e6, east: e / 1e6, ring };
        for (let y = Math.floor(fp.south / CELL); y <= Math.floor(fp.north / CELL); y++) {
          for (let x = Math.floor(fp.west / CELL); x <= Math.floor(fp.east / CELL); x++) {
            const key = `${y},${x}`;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key)!.push(fp);
          }
        }
      }
    })
    .catch((e) => console.warn('[StationFootprints] 読込に失敗しました', e));
  return loading;
}

/** (lat, lon)（度）が駅の形の中か */
export function isInStation(lat: number, lon: number): boolean {
  for (const fp of grid.get(`${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`) ?? []) {
    if (lat < fp.south || lat > fp.north || lon < fp.west || lon > fp.east) continue;
    if (insideRing(lat, lon, fp.ring)) return true;
  }
  return false;
}

function insideRing(lat: number, lon: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ay, ax] = ring[i];
    const [by, bx] = ring[j];
    if (ay > lat !== by > lat && lon < ((bx - ax) * (lat - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
