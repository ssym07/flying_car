#!/bin/zsh
# 今あるワールド（地域）の範囲を広げる（README「ワールドを足す・広げる手順」の 2 の順で、足した長方形だけ取り足す）。
# 先に scripts/lib/region.mjs の AREAS の後ろに長方形を足し、src/data/wards.ts に建物を作る市区町村を足しておく。
# 区切りごとにその地域のデータのフォルダだけコミットする（push はしない）。取得（Overpass）が混んでいると何時間もかかる。
#
# 使い方（例：北海道に 7 個目からの長方形を足した時）:
#   REGION=hokkaido FROM=7 \
#   PLATEAU="01205" \                                   # PLATEAU の建物を作る市区町村コード
#   GSI="01578:白老町 01230:登別市 ..." PREF=北海道 \    # 国土地理院の建物の形から作る市区町村（コード:名前）と都道府県名
#   nohup caffeinate -i scripts/region-extend.sh > /dev/null 2>&1 &
#
# 道路網・地面の種類・公園は、足した長方形ごとに長方形を渡して取る（引数なしで流すと 1つ目の長方形だけを作り直し、ほかを消すので）。
# 鉄道・高速道路・駅の屋根などは区画ごとのキャッシュがあるので、引数なしで流しても前の長方形は取り直さない。
# 範囲全体を1回で取るもの（路線図・空港・砂浜・JCT と IC・川）は、キャッシュを $LOG/old-cache に動かしてから取り直す。
set -u
cd "$(dirname "$0")/.."
: "${REGION:?REGION を渡してください}"
: "${FROM:?FROM（足した最初の長方形の番号。1 から数える）を渡してください}"
PLATEAU=${PLATEAU:-}
GSI=${GSI:-}
PREF=${PREF:-}
LOG=${LOG:-logs}
mkdir -p "$LOG/old-cache"
P="$LOG/$REGION-progress.log"
export REGION
export NODE_OPTIONS=--max-old-space-size=8192

AREAS=("${(@f)$(node -e "import('./scripts/lib/region.mjs').then(({AREAS})=>console.log(AREAS.map(a=>a.join(',')).join('\n')))")}")
DIR=$(node -e "import('./scripts/lib/region.mjs').then(({REGION_ID})=>console.log(REGION_ID === 'kanto' ? '' : REGION_ID + '/'))")
NEW=("${(@)AREAS[$FROM,-1]}")

log() { echo "$(date '+%m-%d %H:%M') $*" >> "$P"; }
step() {
  for i in 1 2 3 4; do
    log "start $* (try $i)"
    node "scripts/$1.mjs" "${@:2}" >> "$LOG/$REGION-$1.log" 2>&1 && { log "ok $1"; return 0; }
    sleep 60
  done
  log "FAILED $*"
  return 1
}
commit() {
  git add -A "public/$DIR" "data/$DIR" "src/data/$DIR" > /dev/null 2>&1
  git commit -q -m "$1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && log "commit $(git log --oneline -1 | cut -c1-9)"
}
# 長方形の大きさで分割数を決める（0.08 度ごとに 1 つ）
split_of() { node -e "const [s,w,n,e]='$1'.split(',').map(Number);console.log(Math.max(1,Math.ceil(Math.max(n-s,e-w)/0.08)))"; }
# 足した長方形ごとの取得
per_new() {
  local script=$1
  for a in "${NEW[@]}"; do step "$script" "$a" "$(split_of "$a")" || return 1; done
}
# 範囲全体を1回で取るもののキャッシュを動かす（消さない）
move_cache() {
  for f in "$@"; do [ -e "$f" ] && mv "$f" "$LOG/old-cache/$(echo "$f" | tr '/' '_')"; done
  return 0
}
# データのフォルダのファイルの数（前より減っていないか確かめる）
count() { for d in public/${DIR}*(/); do echo "$d $(find "$d" -type f | wc -l | tr -d ' ')"; done; }

log "=== $REGION の範囲を広げる（${#NEW[@]} 個の長方形：${NEW[*]}） ==="
count > "$LOG/$REGION-count-before.txt"

( [ -n "$PLATEAU" ] && step build-local-buildings ${=PLATEAU} --clip; log "PLATEAU done" ) &

step fetch-stations || exit 1
step fetch-roads || exit 1
per_new fetch-road-network || exit 1
step fetch-railways || exit 1
step fetch-expressways || exit 1
step fetch-station-roofs || exit 1
step build-rail-heights || exit 1
step build-station-footprints || exit 1
step build-platforms || exit 1
step build-expressways || exit 1
commit "$REGION のワールドを広げる：道路網・鉄道・高速道路・駅・駅の屋根・線路の高さ・ホーム"

for g in ${=GSI}; do step build-gsi-buildings "${g%%:*}" "${g#*:}" "$PREF" || exit 1; done
until grep -q "PLATEAU done" "$P"; do sleep 30; done
step build-building-pads || exit 1

move_cache "data/${DIR}cache/route-map.json" "data/cache/airports-$REGION.json"
step fetch-airports || exit 1
step build-station-cutouts || exit 1
step build-sky-lanes || exit 1
step fetch-route-map || exit 1
step build-route-map-sea || exit 1
commit "$REGION のワールドを広げる：建物の敷地・空港・駅の切り抜き・空路・路線図と路線図の海"

per_new fetch-landuse || exit 1
move_cache "data/cache/beaches-$REGION.json"
step add-beaches || exit 1
step fetch-airports || exit 1
per_new fetch-parks || exit 1
commit "$REGION のワールドを広げる：地面の種類・砂浜・空港の地面・公園"

move_cache "data/cache/junctions-$REGION.json" "data/cache/junctions-gsi-$REGION.json" "data/cache/rivers-$REGION.json"
step fetch-station-english || exit 1
step build-expressway-signs || exit 1
step fetch-expressway-junctions || exit 1
step fetch-river-names || exit 1
step fetch-schools || exit 1
step fetch-park-names || exit 1
step fetch-museums || exit 1
step build-municipalities || exit 1
count > "$LOG/$REGION-count-after.txt"
commit "$REGION のワールドを広げる：方面看板・JCT と IC・川・学校・公園・ミュージアムの名前、エントランスの地図と役所"
log "=== done ==="
