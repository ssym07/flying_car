import { cp } from 'node:fs/promises';
import { defineConfig, loadEnv } from 'vite';

/**
 * 公開版のビルド（VITE_DATA_URL を渡した時）は、データ（public の下のタイル・建物、約 20GB）を dist にコピーしない。
 * データは Cloudflare R2 に別に上げる（scripts/upload-data.sh）。dist にはプログラムと Draco のデコーダーだけを入れる。
 * VITE_DATA_URL が無い時は今までどおり（public を丸ごとコピー）
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const remoteData = Boolean(env.VITE_DATA_URL);
  return {
    build: {
      copyPublicDir: !remoteData,
    },
    plugins: remoteData
      ? [
          (() => {
            let outDir = 'dist';
            return {
              name: 'copy-draco',
              apply: 'build' as const,
              configResolved(config: { build: { outDir: string } }) {
                outDir = config.build.outDir;
              },
              async closeBundle() {
                await cp('public/draco', `${outDir}/draco`, { recursive: true });
              },
            };
          })(),
        ]
      : [],
  };
});
