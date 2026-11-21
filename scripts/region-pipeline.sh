#!/bin/zsh
# ワールド（地域）のデータを最初から全部作る（README「ワールドを足す・広げる手順」の 2 の順）。
# 会話や端末が止まっても最後まで走るよう、裏で流す。区切りごとにその地域のデータのフォルダだけコミットする（push はしない）。
# 取得（Overpass）は混んでいると待ってやり直すので、何時間もかかる。
#
# 使い方（例：北海道）:
#   REGION=hokkaido \
#   PLATEAU="01101 01102 ..." \                     # PLATEAU の建物を作る市区町村コード（src/data/wards.ts に URL があるもの）
#   GSI="01235:石狩市 01203:小樽市 ..." PREF=北海道 \  # 国土地理院の建物の形から作る市区町村（コード:名前）と都道府県名
#   nohup caffeinate -i scripts/region-pipeline.sh > /dev/null 2>&1 &
#
# 進み具合は logs/<地域>-progress.log（各スクリプトの出力は logs/<地域>-<スクリプト>.log）。
# 新しいワールドの時だけ使う（fetch-road-network などを「1つ目の長方形を丸ごと作り直す」形で流すので、
# 範囲を足す時は README の手順で、足した長方形だけ取り足す）。
set -u
cd "$(dirname "$0")/.."
: "${REGION:?REGION を渡してください}"
PLATEAU=${PLATEAU:-}
GSI=${GSI:-}
PREF=${PREF:-}
LOG=${LOG:-logs}
mkdir -p "$LOG"
P="$LOG/$REGION-progress.log"
export REGION
# 北海道の行政区域データ（build-municipalities）など、大きなファイルを読むスクリプトがある
export NODE_OPTIONS=--max-old-space-size=8192

# 取る範囲の長方形（scripts/lib/region.mjs の AREAS）。1つ目は引数なし（-）で、2つ目からは長方形を渡して取り足す
AREAS=("${(@f)$(node -e "import('./scripts/lib/region.mjs').then(({AREAS})=>console.log(AREAS.map(a=>a.join(',')).join('\n')))")}")
DIR=$(node -e "import('./scripts/lib/region.mjs').then(({REGION_ID})=>console.log(REGION_ID === 'kanto' ? '' : REGION_ID + '/'))")

log() { echo "$(date '+%m-%d %H:%M') $*" >> "$P"; }
# 1 本のスクリプトを、失敗したら 1 分おいて 4 回まで流す
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
# 長方形ごとの取得（分割数は 1つ目を多めに）
per_area() {
  local script=$1 first=$2 rest=$3
  step "$script" - "$first" || return 1
  for a in "${AREAS[@]:1}"; do step "$script" "$a" "$rest" || return 1; done
}

log "=== $REGION のデータを作る（長方形 ${#AREAS[@]} 個） ==="

# 建物（PLATEAU）は線路と関係ないので、先に裏で取り始める
( [ -n "$PLATEAU" ] && step build-local-buildings ${=PLATEAU} --clip; log "PLATEAU done" ) &

step fetch-stations || exit 1
step fetch-roads || exit 1
per_area fetch-road-network 5 3 || exit 1
step fetch-railways || exit 1
step fetch-expressways || exit 1
step fetch-station-roofs || exit 1
step build-rail-heights || exit 1
step build-station-footprints || exit 1
step build-platforms || exit 1
step build-expressways || exit 1
commit "$REGION のワールドの道路網・鉄道・高速道路・駅・駅の屋根・線路の高さ・ホーム"

# 国土地理院の建物（線路の上の建物を除くので、線路の高さの後）
for g in ${=GSI}; do step build-gsi-buildings "${g%%:*}" "${g#*:}" "$PREF" || exit 1; done
until grep -q "PLATEAU done" "$P"; do sleep 30; done
step build-building-pads || exit 1

step fetch-airports || exit 1
step build-station-cutouts || exit 1
step build-sky-lanes || exit 1
step fetch-route-map || exit 1
step build-route-map-sea || exit 1
commit "$REGION のワールドの建物の敷地・空港・駅の切り抜き・空路・路線図と路線図の海"

per_area fetch-landuse 4 2 || exit 1
step add-beaches || exit 1
step fetch-airports || exit 1
per_area fetch-parks 4 2 || exit 1
commit "$REGION のワールドの地面の種類・砂浜・空港の地面・公園"

step fetch-station-english || exit 1
step build-expressway-signs || exit 1
step fetch-expressway-junctions || exit 1
step fetch-river-names || exit 1
step fetch-schools || exit 1
step fetch-park-names || exit 1
step fetch-museums || exit 1
step build-municipalities || exit 1
commit "$REGION のワールドの方面看板・JCT と IC・川・学校・公園・ミュージアムの名前、エントランスの地図と役所"
log "=== done ==="
