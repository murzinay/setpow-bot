/**
 * HTTP-сервер бота. Делает три вещи:
 *  1. /sub/<subAggregatorToken>?format=singbox — агрегатор подписок.
 *     Это ОСНОВНОЙ внешний endpoint для клиентов (Karing/Happ).
 *  2. /webhook/yookassa, /webhook/oxapay, /webhook/cryptobot — колбэки платёжек.
 *  3. /admin — простой админ-дашборд за Basic-Auth (минималистичный HTML).
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { env } from './config';
import { db } from './db';
import { buildSubscription, type SubFormat } from './subscription';
import { onPaymentSuccess } from './bot';
import { createTmaRouter } from './tma/router';

// Augment Request чтобы хранить raw тело — нужно для HMAC-проверки
// подписи Crypto Pay. Без этого express.json съедает оригинальные
// пробелы/порядок ключей и подпись не сходится.
declare module 'express-serve-static-core' {
  interface Request {
    rawBody?: Buffer;
  }
}

export function createWebServer() {
  const app = express();
  // За reverse-proxy (Caddy/nginx): доверяем X-Forwarded-* — тогда
  // req.hostname = реальный хост (sub.cryox.me), а не локалхост апстрима.
  app.set('trust proxy', 1);
  app.use(
    express.json({
      limit: '512kb',
      // Сохраняем сырое тело — Crypto Pay подписывает именно его.
      verify: (req, _res, buf) => {
        (req as Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.disable('x-powered-by');

  // ── /api/tma/* (Telegram Mini App backend) ────────────────
  // initData-аутентификация, без сессий. Подробности — в src/tma/router.ts.
  app.use('/api/tma', createTmaRouter());

  // ── /app/* (Telegram Mini App static SPA) ─────────────────
  // Frontend живёт в подкаталоге репы tma/. После `npm run build` Vite
  // кладёт собранную SPA в tma/dist/. Раздаём её через express.static.
  //
  // Путь к dist считаем от __dirname:
  //   • prod: tsc компилит src/web.ts → dist/web.js (rootDir=src,
  //     outDir=dist), значит __dirname = <repo>/dist, один `..` = repo
  //   • dev (tsx): запуск .ts напрямую, __dirname = <repo>/src,
  //     один `..` тоже даёт корень repo
  // process.cwd() намеренно НЕ используем — он зависит от того, как
  // PM2/systemd/пользователь стартанул процесс.
  const tmaDistPath = path.resolve(__dirname, '..', 'tma', 'dist');
  if (fs.existsSync(tmaDistPath)) {
    // immutable assets с хэшем в имени → агрессивный кэш на год.
    // index.html и манифесты — без кэша, чтобы релизы накатывались сразу.
    app.use(
      '/app',
      express.static(tmaDistPath, {
        index: false,
        setHeaders: (res, filePath) => {
          if (/\.(?:js|css|woff2?|png|jpg|svg|webp|ico)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-store');
          }
        },
      }),
    );
    // SPA-fallback: любой /app/* без расширения → отдаём index.html.
    // Vite-собранный TMA — это SPA, но сейчас у нас один экран и
    // react-router пока не подключали; всё равно делаем универсально,
    // чтобы при добавлении роутов не трогать backend.
    app.get(/^\/app(?:\/.*)?$/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(tmaDistPath, 'index.html'));
    });
  } else {
    // tma/dist отсутствует — TMA не собрана. Не критично для запуска бота
    // (он работает и без мини-аппа), но логируем громко, чтобы не
    // разбираться "почему кнопка ведёт в 404".
    // eslint-disable-next-line no-console
    console.warn(
      `[tma] dist not found at ${tmaDistPath} — mini-app будет 404. Сделай: cd tma && npm ci && npm run build`,
    );
  }

  // ── /sub/<token> ──────────────────────────────────────────
  // Внутренний путь. Reverse-proxy для sub.cryox.me переписывает чистый
  // /<token> сюда. Формат определяется по User-Agent (см. serveSubscription).
  app.get('/sub/:token', (req: Request, res: Response) => {
    void serveSubscription(req.params.token, req, res);
  });

  // ── Webhook YooKassa ──────────────────────────────────────
  // Формат: { event: "payment.succeeded", object: { id, metadata: { paymentId } } }
  // ВАЖНО: проверка подписи запросов от YooKassa делается через IP-allowlist
  // (см. их доку). В MVP-скелете оставляем TODO.
  app.post('/webhook/yookassa', async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        event?: string;
        object?: { id?: string; metadata?: { paymentId?: string } };
      };
      if (body.event === 'payment.succeeded' && body.object?.metadata?.paymentId) {
        const paymentId = parseInt(body.object.metadata.paymentId, 10);
        if (Number.isFinite(paymentId)) {
          await onPaymentSuccess(paymentId, body.object.id);
        }
      }
      res.json({ ok: true });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[webhook/yookassa]', e);
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Webhook OxaPay ────────────────────────────────────────
  app.post('/webhook/oxapay', async (req: Request, res: Response) => {
    try {
      const body = req.body as { status?: string; orderId?: string; trackId?: string };
      if (body.status === 'Paid' && body.orderId) {
        const paymentId = parseInt(body.orderId, 10);
        if (Number.isFinite(paymentId)) {
          await onPaymentSuccess(paymentId, body.trackId);
        }
      }
      res.json({ ok: true });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[webhook/oxapay]', e);
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Webhook Crypto Pay (@CryptoBot) ───────────────────────
  // Док: https://help.crypt.bot/crypto-pay-api → "Webhooks"
  //
  // Формат запроса:
  //   POST /webhook/cryptobot
  //   Header: crypto-pay-api-signature: hex(HMAC-SHA256(SHA256(token), body))
  //   Body:   { update_id, update_type: "invoice_paid", request_date,
  //             payload: { invoice_id, status, amount, asset, fiat,
  //                        payload: "<наш paymentId>", ... } }
  //
  // ВАЖНО: проверка подписи обязательна. Без неё кто угодно может
  // постучать на /webhook/cryptobot и кредитнуть себе подписку.
  // Crypto Pay подписывает СЫРОЕ тело запроса — поэтому используем
  // req.rawBody (см. express.json verify-callback выше).
  app.post('/webhook/cryptobot', async (req: Request, res: Response) => {
    try {
      if (!env.CRYPTOPAY_API_TOKEN) {
        // Webhook включили, но токена нет — кто-то ошибся в env.
        // Возвращаем 503 чтобы Crypto Pay повторил позже после фикса.
        return res.status(503).json({ error: 'cryptopay disabled' });
      }

      const signature = req.header('crypto-pay-api-signature');
      const rawBody = req.rawBody;
      if (!signature || !rawBody) {
        return res.status(400).json({ error: 'missing signature or body' });
      }

      // HMAC-SHA256, секрет = SHA-256(API_TOKEN). Документация Crypto Pay.
      const secret = crypto
        .createHash('sha256')
        .update(env.CRYPTOPAY_API_TOKEN)
        .digest();
      const computed = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

      // timingSafeEqual защищает от тайминг-атак при сравнении подписи.
      // Длины должны совпадать — иначе фолбэк на простое неравенство.
      const sigBuf = Buffer.from(signature, 'hex');
      const cmpBuf = Buffer.from(computed, 'hex');
      const sigOk =
        sigBuf.length === cmpBuf.length && crypto.timingSafeEqual(sigBuf, cmpBuf);
      if (!sigOk) {
        // eslint-disable-next-line no-console
        console.warn('[webhook/cryptobot] invalid signature');
        return res.status(401).json({ error: 'invalid signature' });
      }

      const body = req.body as {
        update_type?: string;
        payload?: {
          invoice_id?: number;
          status?: string;
          payload?: string;
        };
      };

      // Обрабатываем только успешную оплату. Остальные update_type
      // (например, в будущем "invoice_expired") тихо игнорим.
      if (body.update_type === 'invoice_paid' && body.payload) {
        const inv = body.payload;
        const paymentId = inv.payload ? parseInt(inv.payload, 10) : NaN;
        if (Number.isFinite(paymentId)) {
          // externalId = invoice_id из Crypto Pay (для аудита и idempotent
          // markPaid — чтобы повторный webhook не задвоил выдачу).
          await onPaymentSuccess(paymentId, String(inv.invoice_id ?? ''));
        } else {
          // eslint-disable-next-line no-console
          console.warn('[webhook/cryptobot] invoice_paid without valid payload', inv);
        }
      }

      // Crypto Pay требует 2xx иначе будет ретраить (по их доке —
      // несколько раз с экспоненциальной задержкой).
      res.json({ ok: true });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[webhook/cryptobot]', e);
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── /admin (Basic-Auth) ───────────────────────────────────
  app.use('/admin', basicAuthMiddleware);
  app.get('/admin', async (_req, res) => {
    const [users, activeSubs, paidPayments, recentPayments, activeSubsList] =
      await db.$transaction([
        db.user.count(),
        db.subscription.count({ where: { status: { in: ['active', 'trial'] } } }),
        db.payment.aggregate({
          where: { status: 'paid', currency: 'RUB', provider: { not: 'trial' } },
          _sum: { amount: true },
        }),
        db.payment.findMany({
          where: { status: 'paid' },
          orderBy: { paidAt: 'desc' },
          take: 20,
          include: { user: true },
        }),
        // Реальные подписки с фактическим остатком дней. Это то что
        // юзер видит в "Мои ключи" — НЕ путать с planDays из Payment
        // (planDays — длительность тарифа конкретной покупки, а
        // Subscription.expiresAt — когда реально истекает).
        db.subscription.findMany({
          where: { status: { in: ['active', 'trial'] } },
          orderBy: { expiresAt: 'asc' },
          take: 50,
          include: { user: true, server: true },
        }),
      ]);
    res.type('html').send(
      renderAdmin({
        users,
        activeSubs,
        revenueRub: paidPayments._sum.amount ?? 0,
        recent: recentPayments,
        subscriptions: activeSubsList,
      }),
    );
  });

  // ── sub.cryox.me/<token> (чистый путь без /sub/) ──────────
  // Резерв на случай, если reverse-proxy НЕ переписывает путь, а просто
  // проксирует sub-домен. Срабатывает ТОЛЬКО на хосте из SUB_BASE_URL,
  // чтобы не перехватывать произвольные пути на основном домене.
  const subHost = (() => {
    if (!env.SUB_BASE_URL) return '';
    try {
      return new URL(env.SUB_BASE_URL).hostname;
    } catch {
      return '';
    }
  })();
  if (subHost) {
    app.get('/:token', (req: Request, res: Response, next: NextFunction) => {
      if (req.hostname === subHost) {
        void serveSubscription(req.params.token, req, res);
        return;
      }
      next();
    });
  }

  return app;
}

/** Формат подписки: ?format= (override) или авто по User-Agent клиента. */
function pickFormat(req: Request): SubFormat {
  const q = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : '';
  if (q === 'clash' || q === 'mihomo' || q === 'meta') return 'clash';
  if (q === 'v2ray' || q === 'base64' || q === 'v2rayn') return 'v2ray';
  if (q === 'singbox' || q === 'sing-box' || q === 'json') return 'singbox';

  const ua = (req.header('user-agent') || '').toLowerCase();
  if (/clash|mihomo|meta|flclash|koala|stash|verge/.test(ua)) return 'clash';
  if (/sing-box|sfa|sfi|sfm|karing|hiddify|happ/.test(ua)) return 'singbox';
  // v2rayNG / NekoBox / Streisand / Shadowrocket / v2box / неизвестные.
  return 'v2ray';
}

/** Найти юзера по токену и отдать подписку в подходящем формате. */
async function serveSubscription(token: string, req: Request, res: Response): Promise<void> {
  try {
    const user = await db.user.findUnique({ where: { subAggregatorToken: token } });
    if (!user || user.banned) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const format = pickFormat(req);
    const { body, contentType, expiresAt } = await buildSubscription(user.id, format);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Profile-Title', 'Cryox');
    res.setHeader('Profile-Update-Interval', '12');
    if (expiresAt) {
      // expire — unix-секунды; клиент покажет «осталось N дней». Трафик не
      // лимитируем → total/upload/download = 0.
      const ts = Math.floor(expiresAt.getTime() / 1000);
      res.setHeader('Subscription-Userinfo', `upload=0; download=0; total=0; expire=${ts}`);
    }
    res.type(contentType).send(body);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[/sub]', e);
    res.status(500).type('text/plain').send('Internal error');
  }
}

function basicAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="cryox-admin"').status(401).send('auth required');
    return;
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const [u, p] = decoded.split(':');
  if (u !== env.ADMIN_WEB_USER || p !== env.ADMIN_WEB_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="cryox-admin"').status(401).send('bad creds');
    return;
  }
  next();
}

interface AdminViewModel {
  users: number;
  activeSubs: number;
  revenueRub: number;
  recent: Array<{
    id: number;
    provider: string;
    amount: number;
    currency: string;
    planDays: number;
    paidAt: Date | null;
    user: { tgId: bigint; username: string | null };
  }>;
  subscriptions: Array<{
    id: number;
    kind: string;
    expiresAt: Date;
    status: string;
    isTrial: boolean;
    user: { tgId: bigint; username: string | null };
    server: { displayName: string };
  }>;
}

function renderAdmin(vm: AdminViewModel): string {
  const paymentRows = vm.recent
    .map(
      (p) => `<tr>
        <td>${p.id}</td>
        <td>@${p.user.username ?? '—'} (${p.user.tgId})</td>
        <td>${p.provider}</td>
        <td>${(p.amount / (p.currency === 'XTR' ? 1 : 100)).toFixed(p.currency === 'XTR' ? 0 : 2)} ${p.currency}</td>
        <td>${p.planDays}д</td>
        <td>${p.paidAt?.toISOString().slice(0, 19).replace('T', ' ') ?? '—'}</td>
      </tr>`,
    )
    .join('');

  // Подписки: показываем фактический остаток дней. Это то что юзер реально
  // видит в "Мои ключи". Если в Payment-логе видно "30 дней", а тут осталось
  // только 3 — значит /give был сделан недавно, остаток нужно смотреть тут.
  const now = Date.now();
  const subRows = vm.subscriptions
    .map((s) => {
      const daysLeft = Math.max(0, Math.ceil((s.expiresAt.getTime() - now) / 86400_000));
      const badge = s.isTrial
        ? '<span style="color:#888">trial</span>'
        : `<span style="color:${daysLeft < 3 ? '#c00' : '#080'}">${s.status}</span>`;
      return `<tr>
        <td>${s.id}</td>
        <td>@${s.user.username ?? '—'} (${s.user.tgId})</td>
        <td>${s.server.displayName}</td>
        <td>${s.kind === 'hy2' ? 'Hysteria2' : 'Reality'}</td>
        <td><b>${daysLeft}д</b></td>
        <td>${badge}</td>
        <td>${s.expiresAt.toISOString().slice(0, 19).replace('T', ' ')}</td>
      </tr>`;
    })
    .join('');

  // Минималистичный HTML — без фреймворков. Когда нужно будет больше — берём
  // AdminJS или React + Vite. Пока хватает.
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Cryox admin</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 32px; color: #222; }
  h1 { margin-top: 0; }
  h2 { margin-top: 32px; }
  .stats { display: flex; gap: 16px; margin-bottom: 24px; }
  .stat { flex: 1; padding: 16px; background: #f5f5f7; border-radius: 12px; }
  .stat b { display: block; font-size: 28px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #eee; text-align: left; font-size: 13px; }
  th { background: #fafafa; }
  .hint { color: #888; font-size: 12px; margin-top: -16px; margin-bottom: 24px; }
</style>
</head><body>
<h1>Cryox — admin</h1>
<div class="stats">
  <div class="stat"><b>${vm.users}</b>юзеров</div>
  <div class="stat"><b>${vm.activeSubs}</b>активных подписок</div>
  <div class="stat"><b>${(vm.revenueRub / 100).toLocaleString('ru-RU')} ₽</b>выручка (RUB)</div>
</div>
<p class="hint">1 юзер на сервере = по одной подписке на каждый протокол (hy2 + reality = 2). Если активных подписок меньше чем юзеров×протоколов — у кого-то не достроилось, чините командой <code>/backfill</code> в боте.</p>

<h2>Активные подписки</h2>
<table>
  <thead><tr><th>#</th><th>Юзер</th><th>Сервер</th><th>Протокол</th><th>Осталось</th><th>Статус</th><th>Истекает</th></tr></thead>
  <tbody>${subRows || '<tr><td colspan="7">пока пусто</td></tr>'}</tbody>
</table>

<h2>Последние платежи</h2>
<p class="hint">Колонка "Дней" — длительность тарифа этого платежа (planDays), <b>не</b> остаток. Реальный остаток смотри в таблице "Активные подписки" выше.</p>
<table>
  <thead><tr><th>#</th><th>Юзер</th><th>Провайдер</th><th>Сумма</th><th>Дней</th><th>Когда</th></tr></thead>
  <tbody>${paymentRows || '<tr><td colspan="6">пока пусто</td></tr>'}</tbody>
</table>
</body></html>`;
}
