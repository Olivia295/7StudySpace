import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { watch: { usePolling: true, interval: 600, ignored: ['**/data/**', '**/public/audio/**', '**/public/ocr/**', '**/design/**'] }, proxy: { '/api': { target: 'http://127.0.0.1:4174', changeOrigin: false } } }, build: { chunkSizeWarningLimit: 900 } });
