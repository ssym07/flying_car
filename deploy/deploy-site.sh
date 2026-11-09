#!/bin/zsh
# プログラム（dist、約 6MB）を Cloudflare Pages に上げる。データは R2 から読む（deploy/upload-data.sh）。
# 前もって：npx wrangler login（ブラウザで Cloudflare にログイン）
# 使い方: VITE_DATA_URL=https://<R2 の公開 URL>/ deploy/deploy-site.sh [プロジェクト名]   （省略すると sky-drive）
set -e
cd "$(dirname "$0")/.."
: "${VITE_DATA_URL:?VITE_DATA_URL（R2 の公開 URL、末尾は /）を渡してください}"
PROJECT=${1:-sky-drive}
rm -rf dist
VITE_DATA_URL="$VITE_DATA_URL" npx vite build
npx wrangler pages deploy dist --project-name "$PROJECT"
