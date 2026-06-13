import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: '/app/' — TMA сервится бэкендом по пути /app/, поэтому все
// asset-URL в собранном index.html должны быть относительно него.
//   <script src="/app/assets/index-abc123.js"></script>
// Без base SPA откроется как 404 на ассетах (сервер не найдёт /assets/...).
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Sourcemaps для прода — критично для debug в Telegram WebView, где
    // нет полноценного devtools без weinre/eruda. Размер не страшен:
    // .map не сервится в Telegram-клиенте, а в Caddy можно отключить.
    sourcemap: true,
    target: 'es2020',
  },
  server: {
    port: 5173,
    // Vite-dev-сервер для локальной разработки. На сервере не используется
    // (там работает собранный dist). Чтобы тестить TMA локально, нужно:
    //   1. Запустить ngrok / cloudflared на :5173
    //   2. Положить публичный HTTPS URL в BotFather → /setmenubutton
    //   3. Настроить /api/tma/* на тот же домен (через прокси).
    // Это история для CONTRIBUTING.md, не для прода.
    host: true,
  },
});
