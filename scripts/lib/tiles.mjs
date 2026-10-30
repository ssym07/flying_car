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

/**
 * データを取る範囲：[南, 西, 北, 東] の長方形のならび。1つ目は東京23区・横浜・川崎、2つ目は多摩の西の帯、3つ目は埼玉の南の帯、4〜6つ目は埼玉の東・さいたま市・松戸と流山、7つ目は船橋・習志野の東の帯。
 * 長方形ごとに区画に分けて取るので、長方形を足しても、前の長方形の区画のキャッシュはそのまま使える
 */
export const AREAS = [
  [35.3, 139.46, 35.82, 139.92],
  [35.52, 139.34, 35.82, 139.46],
  [35.82, 139.37, 35.89, 139.79],
  [35.82, 139.79, 35.89, 139.92],
  [35.89, 139.54, 36.01, 139.86],
  [35.74, 139.92, 35.93, 140.01],
  [35.6, 140.01, 35.8, 140.09],
];

/**
 * 範囲を区画 [南, 西, 北, 東] に分ける。split は1つ目の長方形の1辺の分割数で、ほかの長方形は大きさに合わせて分ける。
 * bbox を渡した時は、その範囲だけを split × split に分ける
 */
export function areaCells(split, bbox = null) {
  const out = [];
  const [a0] = AREAS;
  for (const [s, w, n, e] of bbox ? [bbox] : AREAS) {
    const rows = bbox ? split : Math.max(1, Math.ceil((split * (n - s)) / (a0[2] - a0[0]) - 1e-9));
    const cols = bbox ? split : Math.max(1, Math.ceil((split * (e - w)) / (a0[3] - a0[1]) - 1e-9));
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        out.push([s + ((n - s) * j) / rows, w + ((e - w) * i) / cols, s + ((n - s) * (j + 1)) / rows, w + ((e - w) * (i + 1)) / cols]);
      }
    }
  }
  return out;
}
