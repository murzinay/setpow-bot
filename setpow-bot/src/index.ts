/**
 * Bootstrap:
 *  1. Сидируем дефолтный Server из ENV если БД пустая.
 *  2. Стартуем бота (polling — в проде можно сменить на webhook).
 *  3. Стартуем Express (для /sub, /webhook/*, /admin).
 *  4. Запускаем cron-задачи.
 *
 * graceful shutdown по SIGINT/SIGTERM.
 */
import { env } from './config';
import { db, disconnectDb } from './db';
import { bot } from './bot';
import { createWebServer } from './web';
import { startJobs } from './jobs';
import { notifyAdminError } from './adminAlerts';

async function ensureDefaultServer() {
  const count = await db.server.count();
  if (count > 0) return;
  await db.server.create({
    data: {
      displayName: '🇫🇮 Финляндия',
      panelUrl: env.PANEL_URL,
      apiKey: env.PANEL_API_KEY,
      protocols: 'hy2,reality',
      active: true,
    },
  });
  // eslint-disable-next-line no-console
  console.log('[bootstrap] seeded default Server from ENV (PANEL_URL)');
}

async function main() {
  await ensureDefaultServer();

  const app = createWebServer();
  const httpServer = app.listen(env.HTTP_PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[web] listening on :${env.HTTP_PORT}`);
  });

  startJobs();

  // Запускаем бота в polling. В проде можно будет переключить на webhook
  // через bot.api.setWebhook + httpServer.use(webhookCallback(bot, 'express')).
  bot.start({
    onStart: (info) => {
      // eslint-disable-next-line no-console
      console.log(`[bot] @${info.username} started`);
    },
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[shutdown] ${signal}`);
    httpServer.close();
    await bot.stop();
    await disconnectDb();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[fatal]', e);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────
//  Process-level страховки. Любая необработанная ошибка в async
//  (вне grammY-handler — например, в Express-роуте, в cron-таске,
//  в panel.fetch) на Node 22 по умолчанию кладёт процесс. PM2
//  потом рестартует, но юзер видит "бот лежал секунд 5".
//
//  bot.catch уже ловит всё что в grammY-handler. Здесь — всё что
//  снаружи: webhook'и, /sub, jobs.ts, prisma при бд-блокировках.
//
//  ВАЖНО: НЕ делаем process.exit. PM2 не рестартует, юзер ничего
//  не замечает. Если ошибка фатальная и состояние памяти битое —
//  следующая операция всё равно упадёт и тогда уже свалит процесс.
// ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason);
  void notifyAdminError('unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[uncaughtException]', err);
  void notifyAdminError('uncaughtException', err);
});
