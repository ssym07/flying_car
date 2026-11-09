import { LOCATION } from '../core/config';
import { wardName } from '../world/places';

/**
 * 緯度経度（度）の住所（区・町名、例「千代田区 丸の内一丁目」）を国土地理院の逆ジオコーダに問い合わせる。
 * 海の上など住所の無い所は ''。返事が無い・エラーの時は例外（LOCATION.geocodeTimeoutSec で打ち切る）
 */
export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  const url = LOCATION.reverseGeocoderUrl.replace('{lat}', lat.toFixed(6)).replace('{lon}', lon.toFixed(6));
  const res = await fetch(url, { signal: AbortSignal.timeout(LOCATION.geocodeTimeoutSec * 1000) });
  if (!res.ok) throw new Error(`reverse geocoder: ${res.status}`);
  const json = (await res.json()) as { results?: { muniCd: string; lv01Nm: string } } | null;
  const r = json?.results;
  if (!r) return '';
  const town = r.lv01Nm === '－' ? '' : r.lv01Nm;
  return [wardName(r.muniCd), town].filter(Boolean).join(' ');
}
