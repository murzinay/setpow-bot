/**
 * REST-роуты для Telegram Mini App (бренд Cryox).
 *
 * Маунтится в web.ts по префиксу /api/tma. Каждый запрос обязан принести
 * Telegram WebApp initData в заголовке `Authorization: tma <initData>`.
 *
 * Архитектура: stateless. Никаких сессионных JWT — на каждый запрос
 * проверяем HMAC initData. Это:
 *   • проще (нет секретов и срока жизни сессии);
 *   • безопаснее (если Telegram перезапустит TMA, initData ротируется
 *     автоматически, "украденная" сессия живёт максимум 24ч).
 *
 * Эндпоинты:
 *   GET  /me           — всё для главного экрана (подписка, ключ, реферал, конфиг)
 *   POST /promo        — активировать промокод
 *   POST /pay/create   — создать инвойс (Telegram Stars / CryptoBot)
 *   POST /key/rotate   — перевыпустить ссылку-подписку (старая отзывается)
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { env, paymentsAvailable } from '../config';
import { db } from '../db';
import { bot } from '../bot';
import { createInvoice } from '../payments';
import { redeemPromoCode } from '../promo';
import { subscriptionUrl, genSubToken } from '../subscription';
import { PLANS, PLAN_ORDER, formatRub, type PlanId } from '../plans';
import { verifyInitData, type TmaUser, InitDataInvalid } from './auth';

declare module 'express-serve-static-core' {
  interface Request {
    tmaUser?: TmaUser;
  }
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Header: "Authorization: tma <initDataRaw>". Префикс "tma" — наш кастом
  // (стандарт rfc6750 не подходит, init-data это не Bearer-токен).
  const header = req.header('authorization') ?? '';
  const match = header.match(/^tma\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: 'no initdata' });
    return;
  }
  try {
    req.tmaUser = verifyInitData(match[1], env.BOT_TOKEN);
    next();
  } catch (e) {
    if (e instanceof InitDataInvalid) {
      res.status(401).json({ error: e.message });
      return;
    }
    next(e);
  }
}

// Юзернейм бота нужен для реф-ссылки (t.me/<bot>?start=ref_...). getMe —
// сетевой вызов; кешируем навсегда (юзернейм бота не меняется в рантайме).
let cachedBotUsername: string | null = null;
async function getBotUsername(): Promise<string> {
  if (cachedBotUsername) return cachedBotUsername;
  const me = await bot.api.getMe();
  cachedBotUsername = me.username;
  return cachedBotUsername;
}

/** Статический блок конфигурации для фронта (бренд, ссылки, тарифы). */
function buildConfig(botUsername: string) {
  return {
    brand: 'Cryox',
    botUsername,
    supportUrl: env.SUPPORT_URL,
    channelUrl: env.CHANNEL_URL,
    // Только реально доступные способы оплаты — фронт рисует кнопки по ним.
    providers: {
      tgStars: paymentsAvailable.tgStars,
      cryptobot: paymentsAvailable.cryptobot,
    },
    plans: PLAN_ORDER.map((id) => {
      const p = PLANS[id];
      return {
        id: p.id,
        title: p.title,
        days: p.days,
        priceRub: p.priceRub,
        priceLabel: formatRub(p.priceRub),
        priceStars: p.priceStars,
        discountPct: p.discountPct,
      };
    }),
  };
}

export function createTmaRouter(): Router {
  const r = Router();
  r.use(authMiddleware);

  /**
   * GET /api/tma/me
   *
   * Всё, что нужно для главного экрана мини-аппа:
   *   • notRegistered=true → юзер ни разу не делал /start (фронт покажет
   *     заглушку «Сначала запусти бота»). config всё равно отдаём.
   *   • user        → имя/username/id/premium для шапки и профиля.
   *   • subscription→ active/isTrial/daysLeft/expiresAt + count.
   *   • keyUrl      → универсальная ссылка-подписка (её копирует юзер).
   *   • referral    → код/ссылка/кол-во приглашённых/бонус-дни.
   *   • config      → бренд, юзернейм бота, ссылки, тарифы, провайдеры.
   *
   * 403 если юзер забанен — TMA не должен ничего показывать банлистнутому.
   */
  r.get('/me', async (req: Request, res: Response) => {
    const tg = req.tmaUser!;
    const botUsername = await getBotUsername();
    const config = buildConfig(botUsername);

    const user = await db.user.findUnique({ where: { tgId: tg.id } });
    if (!user) {
      res.json({ notRegistered: true, firstName: tg.firstName, config });
      return;
    }
    if (user.banned) {
      res.status(403).json({ error: 'banned' });
      return;
    }

    // Подписка с самым дальним expiresAt — её "осталось дней" мы и
    // показываем в шапке. hy2 и reality обычно продляются вместе.
    const longestSub = await db.subscription.findFirst({
      where: { userId: user.id, status: { in: ['active', 'trial'] } },
      orderBy: { expiresAt: 'desc' },
    });
    const now = Date.now();
    const daysLeft = longestSub
      ? Math.max(0, Math.ceil((longestSub.expiresAt.getTime() - now) / 86400_000))
      : 0;
    const activeCount = await db.subscription.count({
      where: { userId: user.id, status: { in: ['active', 'trial'] } },
    });
    const invitedCount = await db.user.count({ where: { referredById: user.id } });

    res.json({
      notRegistered: false,
      user: {
        // tgId как строка — JSON не умеет BigInt без сериализатора.
        tgId: String(user.tgId),
        firstName: user.firstName ?? tg.firstName,
        username: user.username ?? tg.username,
        isPremium: tg.isPremium,
      },
      subscription: {
        active: !!longestSub,
        isTrial: longestSub?.isTrial ?? false,
        daysLeft,
        expiresAt: longestSub ? longestSub.expiresAt.toISOString() : null,
        count: activeCount,
      },
      keyUrl: subscriptionUrl(user.subAggregatorToken),
      referral: {
        code: user.refCode,
        link: `https://t.me/${botUsername}?start=ref_${user.refCode}`,
        invited: invitedCount,
        bonusDays: env.REFERRAL_BONUS_DAYS,
      },
      config,
    });
  });

  /**
   * POST /api/tma/promo  { code }
   *
   * Активирует промокод. Логические ошибки (код не найден / истёк / уже
   * использован) возвращаем как 200 { ok:false, error } — фронт покажет
   * текст. Реальные исключения пробрасываются → 500 (ловит express).
   */
  r.post('/promo', async (req: Request, res: Response) => {
    const tg = req.tmaUser!;
    const user = await db.user.findUnique({ where: { tgId: tg.id } });
    if (!user || user.banned) {
      res.status(403).json({ error: 'banned' });
      return;
    }
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const result = await redeemPromoCode(user, code);
    if (!result.success) {
      res.json({ ok: false, error: result.error });
      return;
    }
    res.json({
      ok: true,
      daysGranted: result.daysGranted,
      expiresAt: result.expiresAt ? result.expiresAt.toISOString() : null,
    });
  });

  /**
   * POST /api/tma/pay/create  { planId, provider }
   *
   * provider ∈ { 'tg_stars', 'cryptobot' }.
   *   • tg_stars → создаём Payment(pending) и возвращаем invoiceLink
   *     (фронт открывает через WebApp.openInvoice). Оплату подтвердят
   *     те же pre_checkout_query/successful_payment-хендлеры в bot.ts.
   *   • cryptobot → создаём счёт в Crypto Pay и возвращаем payUrl
   *     (фронт открывает через WebApp.openLink/openTelegramLink).
   */
  r.post('/pay/create', async (req: Request, res: Response) => {
    const tg = req.tmaUser!;
    const user = await db.user.findUnique({ where: { tgId: tg.id } });
    if (!user || user.banned) {
      res.status(403).json({ error: 'banned' });
      return;
    }
    const planId = req.body?.planId as PlanId;
    const provider = req.body?.provider;
    const plan = PLANS[planId];
    if (!plan) {
      res.status(400).json({ error: 'unknown plan' });
      return;
    }
    if (provider !== 'tg_stars' && provider !== 'cryptobot') {
      res.status(400).json({ error: 'unknown provider' });
      return;
    }
    if (provider === 'tg_stars' && !paymentsAvailable.tgStars) {
      res.status(400).json({ error: 'stars disabled' });
      return;
    }
    if (provider === 'cryptobot' && !paymentsAvailable.cryptobot) {
      res.status(400).json({ error: 'cryptobot disabled' });
      return;
    }

    try {
      const invoice = await createInvoice(user, plan, provider);
      if (provider === 'tg_stars' && invoice.starsInvoice) {
        const i = invoice.starsInvoice;
        // createInvoiceLink в этой версии grammY требует provider_token
        // позиционным (4-й арг). Для XTR (Stars) он пустой — ''.
        // Возвращает ссылку https://t.me/$..., которую WebApp.openInvoice
        // открывает нативным платёжным окном Telegram.
        const link = await bot.api.createInvoiceLink(
          i.title,
          i.description,
          i.payload,
          '',
          i.currency,
          i.prices,
        );
        res.json({ ok: true, kind: 'stars', invoiceLink: link });
        return;
      }
      res.json({ ok: true, kind: 'url', payUrl: invoice.paymentUrl });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[tma:pay/create]', e);
      res.status(502).json({ error: (e as Error).message || 'payment error' });
    }
  });

  /**
   * POST /api/tma/key/rotate
   *
   * Перевыпускает subAggregatorToken — старая ссылка-подписка мгновенно
   * перестаёт открываться (404). Это «отзыв доступа по утёкшей ссылке».
   *
   * ВАЖНО про семантику: ротируется только ПУБЛИЧНЫЙ токен в URL. Сами
   * учётки hy2/reality на панели остаются прежними — мы лишь меняем
   * адрес, по которому отдаётся агрегированный конфиг. Для юзера это
   * выглядит как «сменил ключ»: старую ссылку, которую он кому-то скинул,
   * уже не открыть, а ему достаточно импортировать новую.
   */
  r.post('/key/rotate', async (req: Request, res: Response) => {
    const tg = req.tmaUser!;
    const user = await db.user.findUnique({ where: { tgId: tg.id } });
    if (!user || user.banned) {
      res.status(403).json({ error: 'banned' });
      return;
    }
    // Короткий base62-токен — как при регистрации (genAggregatorToken).
    const newToken = genSubToken();
    await db.user.update({
      where: { id: user.id },
      data: { subAggregatorToken: newToken },
    });
    res.json({ ok: true, keyUrl: subscriptionUrl(newToken) });
  });

  return r;
}
