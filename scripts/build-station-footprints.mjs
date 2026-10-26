// 駅の屋根データ（public/station-roofs/15）から、駅の形（駅舎・上屋）を1つのファイルにまとめて
// public/station-footprints.json に書き出す。PLATEAU の建物が駅かどうかの判定に使う。
// 使い方: node scripts/build-station-footprints.mjs（fetch-station-roofs.mjs の後に実行）
//
// 出力の形式: [[南, 西, 北, 東（1e-6度）, [緯度,経度,...（1e-6度、先頭以外は前の点との差）]], ...]
import { readdir, readFile, writeFile } from 'node:fs/promises';

const DIR = new URL('../public/station-roofs/15/', import.meta.url);
const out = [];
for (const x of await readdir(DIR)) {
  for (const f of await readdir(new URL(`${x}/`, DIR))) {
    for (const [, , , coords] of JSON.parse(await readFile(new URL(`${x}/${f}`, DIR), 'utf8'))) {
      let lat = 0;
      let lon = 0;
      let s = Infinity;
      let w = Infinity;
      let n = -Infinity;
      let e = -Infinity;
      for (let i = 0; i < coords.length; i += 2) {
        lat += coords[i];
        lon += coords[i + 1];
        s = Math.min(s, lat);
        n = Math.max(n, lat);
        w = Math.min(w, lon);
        e = Math.max(e, lon);
      }
      out.push([s, w, n, e, coords]);
    }
  }
}
const json = JSON.stringify(out);
await writeFile(new URL('../public/station-footprints.json', import.meta.url), json);
console.log(`${out.length} footprints, ${(json.length / 1e6).toFixed(2)} MB`);
