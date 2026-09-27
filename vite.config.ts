import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// GitHub Pages はリポジトリ名配下に配信されるため base を合わせる。
// 独自ドメインやユーザーページの場合は VITE_BASE=/ を指定する。
const base = process.env.VITE_BASE ?? '/food-inventory-system/';

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  optimizeDeps: {
    // sql.js は CommonJS のため事前バンドルさせる（除外すると dev で default export を解決できない）。
    // wasm 本体は public/sql-wasm.wasm から locateFile 経由で実行時に取得する。
    include: ['sql.js', 'jszip'],
  },
  test: {
    globals: true,
    environment: 'node',
    // 画面テスト(tests/ui)は .tsx で、ファイル先頭の docblock で happy-dom 環境を指定する
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup/reactAct.ts'],
    coverage: { reporter: ['text', 'html'], include: ['src/**/*.{ts,tsx}'] },
  },
});
