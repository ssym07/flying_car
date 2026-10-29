// ズーム z のタイル（地形チャンクと同じ並び）と、緯度経度の範囲の行き来
const K = Math.PI / 180;

const lonOf = (x, n) => (x / n) * 360 - 180;
const latOf = (y, n) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / K;
const xOf = (lon, n) => ((lon + 180) / 360) * n;
const yOf = (lat, n) => ((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n;

/** 範囲 [南, 西, 北, 東]（度）を、ズーム z のタイルの境目まで外へ広げる */
export function snapBbox([s, w, n, e], z) {
  const N = 2 ** z;
  return [latOf(Math.ceil(yOf(s, N)), N), lonOf(Math.floor(xOf(w, N)), N), latOf(Math.floor(yOf(n, N)), N), lonOf(Math.ceil(xOf(e, N)), N)];
}

/** タイル 'x/y'（ズーム z）が範囲 [南, 西, 北, 東] の中に丸ごと入るか */
export function tileInBbox(key, [s, w, n, e], z) {
  const N = 2 ** z;
  const [x, y] = key.split('/').map(Number);
  const eps = 1e-9;
  return lonOf(x, N) >= w - eps && lonOf(x + 1, N) <= e + eps && latOf(y + 1, N) >= s - eps && latOf(y, N) <= n + eps;
}
