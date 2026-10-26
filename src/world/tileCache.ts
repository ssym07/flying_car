import { TILE_CACHE } from '../core/config';

/**
 * PLATEAU の建物タイルを、ブラウザの Cache Storage に長く残す。
 * 配信サーバーのキャッシュは1時間で切れるので、次に起動した時もダウンロードし直さずに済むようにする。
 * Cache Storage が使えない環境（プライベートモードなど）では、ふつうに取得する。
 */

/** 保存した日時を入れるヘッダー（期限切れの判定に使う） */
const SAVED_AT = 'x-sky-drive-saved-at';

let opening: Promise<Cache | null> | null = null;

function openCache(): Promise<Cache | null> {
  opening ??= (async () => {
    try {
      if (typeof caches === 'undefined') return null;
      // 名前を変えたら古いキャッシュを消す
      for (const name of await caches.keys()) {
        if (name.startsWith('sky-drive-tiles-') && name !== TILE_CACHE.name) await caches.delete(name);
      }
      return await caches.open(TILE_CACHE.name);
    } catch {
      return null;
    }
  })();
  return opening;
}

/** url を取得する。保存済みで期限内ならそれを返し、無ければ取得して保存する */
export async function cachedFetch(url: string, options?: RequestInit): Promise<Response> {
  // 手元のファイル（public/plateau）はキャッシュしなくても速い
  if (new URL(url, location.href).origin === location.origin) return fetch(url, options);
  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      const savedAt = Number(hit?.headers.get(SAVED_AT) ?? 0);
      if (hit && Date.now() - savedAt < TILE_CACHE.maxAgeDays * 86400_000) return hit;
    } catch {
      // 読めなければ取得し直す
    }
  }
  const res = await fetch(url, options);
  if (cache && res.ok) {
    // 保存した日時を付けて、別の Response として保存する（本体は呼び出し元に返す）
    const copy = res.clone();
    void copy
      .arrayBuffer()
      .then((body) => {
        const headers = new Headers(copy.headers);
        headers.set(SAVED_AT, `${Date.now()}`);
        return cache.put(url, new Response(body, { status: copy.status, statusText: copy.statusText, headers }));
      })
      .catch(() => {
        // 容量が足りないなど。保存できなくても表示には困らない
      });
  }
  return res;
}

/** 3d-tiles-renderer のプラグイン：タイルの取得を cachedFetch にする */
export class TileCachePlugin {
  fetchData(url: string, options?: RequestInit): Promise<Response> {
    return cachedFetch(url, options);
  }
}
