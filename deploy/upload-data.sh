#!/bin/zsh
# データ（public の下のタイル・建物・路線図など、約 20GB・8 万ファイル）を Cloudflare R2 に上げる。
# 2 回目からは変わったファイルだけを上げる（rclone sync。R2 にあって手元に無いファイルは消す）。
#
# 前もって：
#   brew install rclone
#   rclone config で R2 の接続先を「r2」という名前で作る（種類 s3、provider Cloudflare、
#   R2 の API トークンの Access Key ID / Secret、endpoint https://<アカウントID>.r2.cloudflarestorage.com）
# 使い方: deploy/upload-data.sh [バケット名]   （省略すると sky-drive-data）
set -e
cd "$(dirname "$0")/.."
BUCKET=${1:-sky-drive-data}
rclone sync public "r2:$BUCKET" \
  --transfers 32 --checkers 64 --fast-list --progress \
  --exclude '.DS_Store' \
  --header-upload 'Cache-Control: public, max-age=86400'
