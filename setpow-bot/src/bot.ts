/**
 * Telegram-бот на grammY. Вся логика хендлеров здесь — для MVP-скелета
 * достаточно одного файла. Когда будем добавлять scenes (мульти-степовые
 * флоу), вынесем в src/bot/handlers/*.
 *
 * Поддержка: /start [ref_<code>], главное меню, выбор тарифа, оплата
 * (только Stars в этом коммите — остальные провайдеры скаффолжены).
 */
import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, Keyboard, type Context } from 'grammy';
import crypto from 'node:crypto';
import { env, isAdmin, paymentsAvailable } from './config';
import { db } from './db';
import { PLANS, PLAN_ORDER, type PlanId, formatRub } from './plans';
import { createInvoice, markPaid, type PaymentProvider } from './payments';
import { grantOrExtend, activeForUser, revokeAll } from './subscription';
import { createRateLimiter } from './rateLimit';
import * as notify from './notify';
import { fmtDate, pluralDays } from './notify';
import { redeemPromoCode } from './promo';
import { createBackup, formatBytes } from './backup';
import { notifyAdminError } from './adminAlerts';
import type { Subscription } from '@prisma/client';

export const bot = new Bot(env.BOT_TOKEN);

// ─────────────────────────────────────────────────────────────
//  Глобальный error handler grammY.
//
//  Без него ЛЮБАЯ ошибка в любом handler'е валит процесс целиком —
//  grammY печатает "No error handler was set! Stopping bot" и кидает.
//  PM2 перезапускает (мы это видели в проде: 5 рестартов за день).
//
//  Самый частый триггер — "message is not modified": юзер дважды жмёт
//  одну и ту же inline-кнопку, бот делает editMessageText с идентичным
//  контентом, TG отвечает 400. Это НОРМАЛЬНОЕ состояние, не баг.
// ─────────────────────────────────────────────────────────────
bot.catch((err) => {
  const e = err.error;

  if (e instanceof GrammyError) {
    const desc = e.description || '';

    // 1. "message is not modified" — двойной клик по той же кнопке.
    //    Тихо игнорируем + закрываем "часики" callback'а.
    if (desc.includes('message is not modified')) {
      if (err.ctx.callbackQuery) {
        // void — отвечаем не дожидаясь, нам важно не упасть здесь самим.
        void err.ctx.answerCallbackQuery().catch(() => {});
      }
      return;
    }

    // 2. Старый callback (>15 минут) — кнопка из давнего сообщения.
    if (
      desc.includes('query is too old') ||
      desc.includes('query ID is invalid') ||
      desc.includes('QUERY_ID_INVALID')
    ) {
      return;
    }

    // 3. Юзер заблокировал бота / удалил аккаунт / закрыл чат.
    //    Не наша проблема — просто не пишем ему больше.
    if (
      desc.includes('bot was blocked') ||
      desc.includes('user is deactivated') ||
      desc.includes('chat not found')
    ) {
      return;
    }

    // 4. Реальная проблема со стороны TG — логируем но не падаем.
    // eslint-disable-next-line no-console
    console.error(
      '[bot.catch] GrammyError',
      JSON.stringify({ code: e.error_code, method: e.method, desc }),
    );
    return;
  }

  if (e instanceof HttpError) {
    // Сетевая ошибка до api.telegram.org. grammY авторетраит
    // long-polling, нам нужно только не упасть.
    // eslint-disable-next-line no-console
    console.error('[bot.catch] HttpError', e.message);
    return;
  }

  // Что-то неожиданное в нашем коде — логируем со стеком
  // и ОТДЕЛЬНО шлём админу через notifyAdminError (с дедупликацией,
  // см. src/adminAlerts.ts). Раньше такие ошибки только писались
  // в pm2 logs — админ узнавал о них постфактум, иногда через дни.
  // eslint-disable-next-line no-console
  console.error('[bot.catch] unexpected', e);
  void notifyAdminError('bot.catch', e);
});

// ─────────────────────────────────────────────────────────────
//  Rate limit — анти-спам для persistent ReplyKeyboard.
//
//  Юзер может зажать кнопку "🏠 Меню" внизу и долбить её, или жать
//  inline-кнопки очередями. Без лимита это:
//    1. Грузит наш Express + Prisma (каждый /start читает БД).
//    2. Превышает 30 msg/sec у TG Bot API → flood wait → бот не
//       отвечает остальным юзерам.
//    3. Заваливает чат юзера сотней сообщений главного меню.
//
//  Лимит: 5 апдейтов в 5 секунд на юзера. Админы — без лимита.
//  Подробности в src/rateLimit.ts.
// ─────────────────────────────────────────────────────────────
bot.use(createRateLimiter({ max: 5, windowMs: 5_000 }));

// ─────────────────────────────────────────────────────────────
//  In-memory state для ввода промокода.
//
//  Юзер жмёт «🎟 Промокод» → бот ставит для его tgId timestamp,
//  до которого следующее обычное текстовое сообщение трактуется как
//  попытка ввода промокода. После таймаута state молча забывается —
//  юзер просто пишет в чате как обычно, никакого «не понял» не получает.
//
//  Map хранится в памяти процесса, не в БД. Минусы:
//    - PM2 reload теряет все ожидающие state'ы. Это ОК: их мало
//      (5-минутное окно, и юзер просто заново нажмёт кнопку).
//    - Не работает в multi-process режиме. Бот запущен в одном
//      процессе (long-polling от grammY) — этого достаточно.
//  Плюсы: ноль доп. таблиц, моментальный доступ, истечение само
//  собой через timestamp-сравнение.
// ─────────────────────────────────────────────────────────────
const awaitingPromo = new Map<bigint, number>();
const PROMO_INPUT_TIMEOUT_MS = 5 * 60_000;

// ─────────────────────────────────────────────────────────────
//  In-memory state для двухшагового флоу /broadcast.
//
//  Карта: adminTgId → черновик рассылки.
//  Этапы:
//    'awaitingText'  ← /broadcast установил, ждём текст
//    'confirming'    ← текст получен, юзер видит превью + 2 кнопки
//
//  Хранение в памяти процесса. Та же логика, что у awaitingPromo:
//  pm2 reload теряет состояние — это допустимо (админ просто заново
//  напишет /broadcast). Multi-process нам не нужен (бот в одном
//  процессе long-polling).
// ─────────────────────────────────────────────────────────────
type BroadcastDraft =
  | { stage: 'awaitingText' }
  | { stage: 'confirming'; text: string };
const broadcastState = new Map<bigint, BroadcastDraft>();

// ─────────────────────────────────────────────────────────────
//  Утилиты — find/create user, формат текста "Мои ключи".
// ─────────────────────────────────────────────────────────────

function genRefCode(): string {
  // 8 url-safe символов — достаточно энтропии для нескольких миллионов юзеров.
  return crypto.randomBytes(6).toString('base64url');
}
function genAggregatorToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * Найти название тарифа по числу дней. Используется для уведомлений
 * о платеже — onPaymentSuccess получает только Payment с planDays,
 * а человеку приятнее увидеть "Год" чем "365 дней".
 * Если совпадения нет (например, /give выдал нестандартное число
 * дней) — возвращаем форматированное число.
 */
function planTitleFromDays(days: number): string {
  for (const id of PLAN_ORDER) {
    if (PLANS[id].days === days) return PLANS[id].title;
  }
  return `${days} дн.`;
}

/** Максимальная дата истечения из массива подписок. null если пусто. */
function maxExpiresAt(subs: Subscription[]): Date | null {
  if (subs.length === 0) return null;
  return new Date(Math.max(...subs.map((s) => s.expiresAt.getTime())));
}

async function findOrCreateUser(ctx: Context) {
  if (!ctx.from) throw new Error('ctx.from is missing');
  const tgId = BigInt(ctx.from.id);
  let user = await db.user.findUnique({ where: { tgId } });
  if (user) return { user, isNew: false, referrer: null as null };

  // Парсим ref_<code> из /start args (только при создании юзера).
  const startPayload = (ctx.message?.text || '').split(' ')[1] ?? '';
  let referredById: number | null = null;
  let referrer: Awaited<ReturnType<typeof db.user.findUnique>> = null;
  if (startPayload.startsWith('ref_')) {
    const code = startPayload.slice(4);
    const found = await db.user.findUnique({ where: { refCode: code } });
    if (found && found.tgId !== tgId) {
      referredById = found.id;
      referrer = found;
    }
  }

  user = await db.user.create({
    data: {
      tgId,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      refCode: genRefCode(),
      subAggregatorToken: genAggregatorToken(),
      referredById,
    },
  });
  return { user, isNew: true, referrer };
}

function mainMenuKeyboard() {
  const kb = new InlineKeyboard()
    .text('🔑 Мои ключи', 'menu:keys').text('💳 Купить', 'menu:buy').row()
    .text('🎁 Реферальная', 'menu:ref').text('🎟 Промокод', 'menu:promo').row()
    .text('ℹ️ Как подключить', 'menu:howto');

  // Кнопка-вход в Telegram Mini App. WebApp-кнопки требуют HTTPS-URL
  // (Telegram отказывается открывать http). PUBLIC_URL валидируется как
  // .url() в config.ts, в проде это всегда https://.
  //
  // URL должен совпадать с тем, что забит в BotFather → /setmenubutton —
  // иначе кнопка из меню работает, а кнопка из inline-клавиатуры нет (или
  // наоборот). В нашей конфигурации одно место: ${PUBLIC_URL}/app/.
  //
  // Слэш в конце важен: без него express.static редиректит /app → /app/,
  // а Telegram WebView не любит редиректы на initial load (initData может
  // потеряться при перенаправлении).
  if (env.PUBLIC_URL.startsWith('https://')) {
    kb.row().webApp('🚀 Открыть приложение', `${env.PUBLIC_URL}/app/`);
  }
  return kb;
}

/**
 * Persistent ReplyKeyboard с одной кнопкой — постоянное меню снизу
 * экрана. Прикрепляется к /start и к ответу на нажатие "🏠 Меню",
 * чтобы юзер мог вернуться в главное меню в любой момент без /start.
 *
 * .resized() — клавиатура подстраивается по размеру (1 кнопка → узкая).
 * .persistent() — TG не сворачивает её в значок (Bot API 6.5+).
 *
 * При нажатии TG отправляет ботy текстовое сообщение "🏠 Меню" —
 * ловим через bot.hears(/^🏠 Меню$/) ниже.
 */
const persistentMenuKeyboard = new Keyboard().text('🏠 Меню').resized().persistent();

/**
 * Текст главного меню. Используется и в /start, и в menu:home callback —
 * чтобы при возврате в меню юзер видел тот же приветственный экран,
 * а не голое "Главное меню:".
 *
 * Параметр extra — для вставки доп. сообщений (например, инфо о триале
 * при первом /start). Вставляется между описанием продукта и "Выбирай:".
 */
function mainMenuText(firstName?: string | null, extra = ''): string {
  const greeting = `Привет${firstName ? ', ' + firstName : ''}!\n` +
    `Это Cryox — VPN, который просто работает.`;
  return greeting + extra + '\n\nВыбирай:';
}

function plansKeyboard() {
  const kb = new InlineKeyboard();
  for (const id of PLAN_ORDER) {
    const p = PLANS[id];
    const label =
      p.discountPct > 0
        ? `${p.title} — ${formatRub(p.priceRub)} (-${p.discountPct}%)`
        : `${p.title} — ${formatRub(p.priceRub)}`;
    kb.text(label, `plan:${id}`).row();
  }
  kb.text('« Назад', 'menu:home');
  return kb;
}

function paymentMethodsKeyboard(planId: PlanId) {
  const kb = new InlineKeyboard();
  if (paymentsAvailable.tgStars)   kb.text('⭐ Telegram Stars', `pay:tg_stars:${planId}`).row();
  if (paymentsAvailable.cryptobot) kb.text('🪙 Крипта (CryptoBot)', `pay:cryptobot:${planId}`).row();
  if (paymentsAvailable.yookassa)  kb.text('💳 Карта (YooKassa)', `pay:yookassa:${planId}`).row();
  if (paymentsAvailable.oxapay)    kb.text('🪙 Крипта (OxaPay)', `pay:oxapay:${planId}`).row();
  kb.text('« Назад', 'menu:buy');
  return kb;
}

// ─────────────────────────────────────────────────────────────
//  Команды
// ─────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const { user, isNew, referrer } = await findOrCreateUser(ctx);

  // Авто-выдача триала ТОЛЬКО для новых юзеров и только если триал ещё не
  // использовался. Триал может быть отключён через TRIAL_DAYS=0.
  let trialExpiresAt: Date | null = null;
  let trialFailed = false;
  if (isNew && !user.trialUsed && env.TRIAL_DAYS > 0) {
    try {
      const subs = await grantOrExtend(user, env.TRIAL_DAYS, true);
      trialExpiresAt = maxExpiresAt(subs);
      // Помечаем trialUsed только если хоть одна подписка реально создалась.
      // Иначе юзер сможет повторить /start когда серверы вернутся.
      if (trialExpiresAt) {
        await db.user.update({ where: { id: user.id }, data: { trialUsed: true } });
        await db.payment.create({
          data: {
            userId: user.id,
            provider: 'trial',
            amount: 0,
            currency: 'RUB',
            planDays: env.TRIAL_DAYS,
            status: 'paid',
            paidAt: new Date(),
          },
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[trial] grant failed', e);
      trialFailed = true;
    }
  }

  const greetingTail = trialExpiresAt
    ? '\n\n🎁 Тебе выдан пробный доступ — детали ниже ⬇️'
    : trialFailed
      ? '\n\n⚠️ Не удалось выдать триал автоматически — напиши в поддержку.'
      : '';

  await ctx.reply(
    mainMenuText(ctx.from?.first_name, greetingTail),
    { reply_markup: mainMenuKeyboard() },
  );

  // Однократно за всё существование юзера — отправить служебное
  // сообщение, которое УСТАНАВЛИВАЕТ persistent ReplyKeyboard в этом
  // чате. TG помнит её до тех пор, пока её не уберут — мы не убираем.
  // Поэтому одно сообщение в жизни юзера = постоянная кнопка снизу.
  if (!user.replyKbInstalled) {
    try {
      await ctx.reply('👇 Кнопка «🏠 Меню» внизу всегда вернёт тебя сюда.', {
        reply_markup: persistentMenuKeyboard,
      });
      await db.user.update({
        where: { id: user.id },
        data: { replyKbInstalled: true },
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[replyKb] install failed', e);
      // Флаг НЕ ставим — попробуем ещё раз на следующий /start.
    }
  }

  // Отдельное подробное уведомление о триале — чтобы дата и срок были
  // на виду, а не терялись в "Привет, выбирай".
  if (trialExpiresAt) {
    await notify.trialGranted(user.tgId, env.TRIAL_DAYS, trialExpiresAt);
  }

  // Уведомляем реферера, что по его ссылке кто-то зарегистрировался
  // (бонус начислится только после первой ОПЛАТЫ — так задумано).
  if (isNew && referrer && !referrer.banned && env.REFERRAL_BONUS_DAYS > 0) {
    await notify.referralRegistered(referrer.tgId, env.REFERRAL_BONUS_DAYS);
  }
});

bot.command('admin', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) return;
  const stats = await db.$transaction([
    db.user.count(),
    db.user.count({ where: { banned: false } }),
    db.subscription.count({ where: { status: { in: ['active', 'trial'] } } }),
    db.payment.count({ where: { status: 'paid', provider: { not: 'trial' } } }),
  ]);
  // Кол-во подписок ≠ кол-во юзеров: один юзер на сервере имеет по
  // подписке на каждый протокол (hy2 + reality = 2 на юзера). Поэтому
  // при 5 юзерах и одном сервере с двумя протоколами будет 10 подписок.
  // Если меньше — у кого-то не достроилось (например, был временный
  // сбой панели). Чинится командой /backfill.
  const servers = await db.server.findMany({ where: { active: true } });
  const expectedSubsPerUser = servers.reduce(
    (sum, s) => sum + s.protocols.split(',').filter(Boolean).length,
    0,
  );
  const expectedTotal = stats[0] * expectedSubsPerUser;
  await ctx.reply(
    [
      '🛠 *Admin*',
      `Юзеров всего: ${stats[0]}`,
      `Активных (не баненых): ${stats[1]}`,
      `Подписок активных: ${stats[2]}` +
        (expectedTotal > 0 && stats[2] < expectedTotal
          ? ` _(ожидалось ${expectedTotal} = ${stats[0]}×${expectedSubsPerUser} протоколов, не хватает ${expectedTotal - stats[2]} — почини /backfill)_`
          : ''),
      `Оплаченных платежей: ${stats[3]}`,
      '',
      'Команды:',
      '`/give <tg_id> <days>` — продлить юзеру (1..3650)',
      '`/ban <tg_id>` — забанить',
      '`/unban <tg_id>` — разбанить',
      '`/backfill [tg_id]` — достроить недостающие подписки',
      '`/backup` — снять бэкап БД сейчас (gzip + в этот чат)',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  );
});

bot.command('give', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) return;
  const m = (ctx.message?.text || '').match(/^\/give\s+(\d+)\s+(\d+)/);
  if (!m) return ctx.reply('Использование: /give <tg_id> <days>');
  const tgId = BigInt(m[1]);
  const days = parseInt(m[2], 10);
  // Sanity-cap: 1..3650 дней (10 лет). Без верхней границы можно случайно
  // словить Date-overflow: JS Date максимум ~8.64×10^15 ms (≈100M дней).
  // При days × 86400000 > этого предела `new Date(...)` даёт Invalid Date,
  // Prisma отказывается записать → бот падает в uncaught. Видели в проде:
  // /give <id> 4578327527578278 → бот сдох. Cap 3650 покрывает любые
  // разумные сценарии (пожизненная подписка = 10 лет максимум).
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    return ctx.reply('❌ days должно быть числом от 1 до 3650 (10 лет максимум).');
  }
  const user = await db.user.findUnique({ where: { tgId } });
  if (!user) return ctx.reply('Юзер не найден.');
  try {
    const subs = await grantOrExtend(user, days, false);
    // Создаём Payment-запись чтобы /give был виден в логе платежей
    // веб-админки и считался в "оплаченных платежах". Provider='manual'
    // отличает ручную выдачу от реальных платежей. Amount=0 (admin не
    // платит), но planDays корректный — это удобно для аудита.
    await db.payment.create({
      data: {
        userId: user.id,
        provider: 'manual',
        amount: 0,
        currency: 'RUB',
        planDays: days,
        status: 'paid',
        paidAt: new Date(),
      },
    });
    // Уведомляем юзера. Если активных серверов нет (subs пустой) —
    // всё равно отвечаем админу, но юзеру ничего не пишем (нечего).
    const expiresAt = maxExpiresAt(subs);
    if (expiresAt) {
      const delivered = await notify.adminGranted(user.tgId, days, expiresAt);
      await ctx.reply(
        `✅ Выдано ${days} дней юзеру ${tgId}. ` +
          (delivered
            ? 'Уведомление доставлено.'
            : '(юзер заблокировал бота — уведомление не доставлено).'),
      );
    } else {
      await ctx.reply(
        `⚠️ Записал, но активных серверов нет — подписки не созданы. ` +
          `Включи сервер и запусти /backfill ${tgId}.`,
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[/give] grantOrExtend failed', e);
    await ctx.reply(`⚠️ Ошибка: ${(e as Error).message}`);
  }
});

bot.command('ban', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) return;
  const m = (ctx.message?.text || '').match(/^\/ban\s+(\d+)/);
  if (!m) return ctx.reply('Использование: /ban <tg_id>');
  const tgId = BigInt(m[1]);
  const user = await db.user.findUnique({ where: { tgId } });
  if (!user) return ctx.reply('Юзер не найден.');
  await db.user.update({ where: { id: user.id }, data: { banned: true } });
  // Уведомляем ДО revoke — пока юзер ещё может прочитать, и пока бот
  // не вступил в гонку с самим собой за TG API rate limit.
  await notify.banned(user.tgId);
  await revokeAll(user.id);
  await ctx.reply(`🚫 Забанен и отозваны подписки: ${tgId}.`);
});

bot.command('unban', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) return;
  const m = (ctx.message?.text || '').match(/^\/unban\s+(\d+)/);
  if (!m) return ctx.reply('Использование: /unban <tg_id>');
  const tgId = BigInt(m[1]);
  const result = await db.user.updateMany({ where: { tgId }, data: { banned: false } });
  if (result.count > 0) {
    await notify.unbanned(tgId);
  }
  await ctx.reply(`✅ Разбанен ${tgId}.`);
});

// ─────────────────────────────────────────────────────────────
//  /backup — ручной триггер бэкапа БД.
//
//  Та же логика что в cron'е (см. src/jobs.ts) — VACUUM INTO + gzip,
//  только адресат один: админ, который вызвал команду. Полезно перед
//  риск-операциями (миграции схемы, ручные UPDATE'ы) и для проверки
//  что бэкап-механика жива сразу после деплоя.
//
//  Цикла «бэкап → уведомить всех админов» здесь нет специально:
//  ручной вызов — личное действие, не нужно спамить остальных.
// ─────────────────────────────────────────────────────────────
bot.command('backup', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) return;
  await ctx.reply('💾 Создаю бэкап...');
  try {
    const { gzPath, size, fileName } = await createBackup();
    await ctx.replyWithDocument(new InputFile(gzPath, fileName), {
      caption: `💾 Ручной бэкап БД (${formatBytes(size)})`,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[/backup] failed', e);
    await ctx.reply(`⚠️ Ошибка бэкапа: ${(e as Error).message}`);
  }
});

/**
 * Backfill — достраивает недостающие подписки у юзеров.
 *
 * Зачем: один юзер на сервере получает подписку на каждый протокол
 * (hy2 + reality = 2 на юзера). Если в момент создания у бота упала
 * связь с панелью на одном из протоколов (например, был баг x25519
 * для Reality) — у юзера могла остаться только одна подписка вместо
 * двух. Эта команда находит таких "неполных" юзеров и достраивает
 * недостающие подписки с тем же expiresAt что у имеющейся.
 *
 * Без аргумента — проходит всех юзеров (до 200).
 * С tg_id — только этого юзера.
 */
bot.command('backfill', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) return;
  const m = (ctx.message?.text || '').match(/^\/backfill(?:\s+(\d+))?/);
  const targetTgId = m && m[1] ? BigInt(m[1]) : null;

  const users = targetTgId
    ? await db.user.findMany({ where: { tgId: targetTgId } })
    : await db.user.findMany({ where: { banned: false }, take: 200 });

  if (users.length === 0) {
    return ctx.reply('Юзеры не найдены.');
  }

  const servers = await db.server.findMany({ where: { active: true } });
  if (servers.length === 0) {
    return ctx.reply('Активных серверов нет.');
  }

  let scanned = 0;
  let created = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const user of users) {
    scanned++;
    for (const server of servers) {
      const protocols = server.protocols
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean) as Array<'hy2' | 'reality'>;

      // Берём sibling — любую активную подписку юзера на этом сервере.
      // Используем её expiresAt чтобы новая подписка имела такой же срок.
      const sibling = await db.subscription.findFirst({
        where: {
          userId: user.id,
          serverId: server.id,
          status: { in: ['active', 'trial'] },
        },
      });
      if (!sibling) continue; // юзер без активных подписок на сервере — не достраиваем

      const remainingMs = sibling.expiresAt.getTime() - Date.now();
      if (remainingMs <= 0) continue;
      const remainingDays = Math.max(1, Math.min(3650, Math.ceil(remainingMs / 86400_000)));

      for (const kind of protocols) {
        const existing = await db.subscription.findFirst({
          where: { userId: user.id, serverId: server.id, kind },
        });
        if (existing) continue; // уже есть, ничего не делаем

        // Создаём недостающую подписку через панель.
        const name =
          kind === 'hy2'
            ? `tg${user.tgId}_${crypto.randomBytes(2).toString('hex')}`
            : `tg${user.tgId}_${crypto.randomBytes(2).toString('hex')}`;
        const password =
          kind === 'hy2' ? crypto.randomBytes(12).toString('base64url') : undefined;

        try {
          // Импорт panel здесь чтобы не плодить top-level imports;
          // grantOrExtend использует его же.
          const { panel } = await import('./panel');
          const result = await panel.createUser(server, {
            kind,
            name,
            password,
            expireDays: remainingDays,
          });
          await db.subscription.create({
            data: {
              userId: user.id,
              serverId: server.id,
              kind,
              panelUserKey: result.name,
              password: result.password ?? null,
              uuid: result.uuid ?? null,
              panelSubToken: result.subToken,
              expiresAt: new Date(result.expiresAt),
              status: sibling.isTrial ? 'trial' : 'active',
              isTrial: sibling.isTrial,
            },
          });
          created++;
        } catch (e) {
          failed++;
          failures.push(`tg${user.tgId} ${kind}: ${(e as Error).message}`);
          // eslint-disable-next-line no-console
          console.error('[backfill] failed', user.tgId, kind, e);
        }
      }
    }
  }

  const lines = [
    `✅ *Backfill завершён*`,
    `Просканировано юзеров: ${scanned}`,
    `Создано подписок: ${created}`,
  ];
  if (failed > 0) {
    lines.push(`❌ Ошибок: ${failed}`);
    lines.push(failures.slice(0, 5).map((f) => `  · ${f}`).join('\n'));
    if (failures.length > 5) lines.push(`  · ... и ещё ${failures.length - 5}`);
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────────────────────
//  Промокоды: админская часть.
//
//  /promo_create CODE DAYS [maxUses=N] [expires=YYYY-MM-DD]
//  /promo_list
//  /promo_del CODE   ← soft-delete (active=false)
//
//  Все три — только для isAdmin. Хранение/валидация — см. src/promo.ts
//  (для активации) и prisma/schema.prisma (PromoCode + Redemption).
// ─────────────────────────────────────────────────────────────

bot.command('promo_create', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) return;
  const text = ctx.message?.text || '';
  // Формат:  /promo_create CODE DAYS [key=value ...]
  // Опц. ключи: maxUses=N (целое > 0), expires=YYYY-MM-DD.
  const parts = text.trim().split(/\s+/).slice(1);
  if (parts.length < 2) {
    return ctx.reply(
      'Использование: `/promo_create CODE DAYS [maxUses=N] [expires=YYYY-MM-DD]`',
      { parse_mode: 'Markdown' },
    );
  }
  const codeRaw = parts[0];
  const days = parseInt(parts[1], 10);
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    return ctx.reply('❌ DAYS должно быть числом от 1 до 3650.');
  }
  const code = codeRaw.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
    return ctx.reply(
      '❌ CODE: только латиница/цифры/`_-`, длина 2..32. Кириллицу и пробелы не используем.',
      { parse_mode: 'Markdown' },
    );
  }

  let maxUses: number | null = null;
  let expiresAt: Date | null = null;
  for (const kv of parts.slice(2)) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    if (k === 'maxUses') {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1) {
        return ctx.reply('❌ maxUses должно быть положительным целым.');
      }
      maxUses = n;
    } else if (k === 'expires') {
      // Принимаем только YYYY-MM-DD; интерпретируем как 23:59:59 МСК
      // (UTC+3) — чтобы юзер успел активировать в течение всего дня.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        return ctx.reply('❌ expires: формат YYYY-MM-DD.');
      }
      // 23:59:59 в Europe/Moscow = 20:59:59 UTC.
      const d = new Date(`${v}T20:59:59.000Z`);
      if (Number.isNaN(d.getTime())) {
        return ctx.reply('❌ expires: некорректная дата.');
      }
      expiresAt = d;
    } else {
      return ctx.reply(`❌ Неизвестный параметр: ${k}`);
    }
  }

  // Дубль — отдадим понятный ответ вместо stack trace из Prisma.
  const exists = await db.promoCode.findUnique({ where: { code } });
  if (exists) {
    return ctx.reply(`❌ Промокод *${code}* уже существует.`, {
      parse_mode: 'Markdown',
    });
  }

  await db.promoCode.create({
    data: { code, freeDays: days, maxUses, expiresAt },
  });
  await ctx.reply(
    `✅ Промокод *${code}* создан: ${days} дней, ` +
      `max=${maxUses ?? '∞'}, expires=${expiresAt ? expiresAt.toISOString().slice(0, 10) : '—'}.`,
    { parse_mode: 'Markdown' },
  );
});

bot.command('promo_list', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) return;
  const now = new Date();
  // Активные = active=true И (expiresAt null ИЛИ в будущем).
  const promos = await db.promoCode.findMany({
    where: {
      active: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  if (promos.length === 0) {
    return ctx.reply('Активных промокодов нет.');
  }
  const lines = ['🎟 *Активные промокоды* (топ 30):', ''];
  for (const p of promos) {
    const usesPart = p.maxUses === null ? `${p.uses}/∞` : `${p.uses}/${p.maxUses}`;
    const expPart = p.expiresAt ? p.expiresAt.toISOString().slice(0, 10) : '—';
    lines.push(`\`${p.code}\`: ${p.freeDays} дней | uses ${usesPart} | exp ${expPart}`);
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

bot.command('promo_del', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) return;
  const m = (ctx.message?.text || '').match(/^\/promo_del\s+(\S+)/);
  if (!m) return ctx.reply('Использование: `/promo_del CODE`', { parse_mode: 'Markdown' });
  const code = m[1].trim().toUpperCase();
  // Soft-delete: ставим active=false, не удаляем строку. Иначе
  // PromoCodeRedemption.promoCodeId превратился бы в висящую ссылку,
  // и админ не смог бы понять «откуда у юзера эти 7 бонусных дней».
  const updated = await db.promoCode.updateMany({
    where: { code, active: true },
    data: { active: false },
  });
  if (updated.count === 0) {
    return ctx.reply(`Промокод *${code}* не найден или уже деактивирован.`, {
      parse_mode: 'Markdown',
    });
  }
  await ctx.reply(`🗑 Промокод *${code}* деактивирован.`, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────────────────────
//  Broadcast — рассылка одного сообщения всем активным юзерам.
//
//  Двухшаговый флоу через broadcastState:
//    1. /broadcast               → state = 'awaitingText'
//    2. <admin шлёт текст>       → ловим в bot.on('message:text'),
//                                  state = 'confirming', показываем превью
//    3. [✅ Отправить] / [❌]    → callback'и broadcast:send | broadcast:cancel
//
//  /cancel — снимает активный broadcastState ИЛИ awaitingPromo (общий
//  «откат» из любого ожидающего состояния).
// ─────────────────────────────────────────────────────────────

bot.command('broadcast', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) return;
  broadcastState.set(BigInt(ctx.from.id), { stage: 'awaitingText' });
  await ctx.reply(
    `📢 *Рассылка*\n\n` +
      `Отправь текст следующим сообщением. Поддерживается Markdown.\n` +
      `Напиши /cancel чтобы отменить.`,
    { parse_mode: 'Markdown' },
  );
});

bot.command('cancel', async (ctx) => {
  if (!ctx.from) return;
  const tgId = BigInt(ctx.from.id);
  // /cancel — общий «откат» для любых ожидающих состояний. Если у юзера
  // ничего не ждётся — тихо ничего не делаем (не показываем «нечего
  // отменять» — лишний шум).
  let cancelled = false;
  if (broadcastState.has(tgId)) {
    broadcastState.delete(tgId);
    cancelled = true;
  }
  if (awaitingPromo.has(tgId)) {
    awaitingPromo.delete(tgId);
    cancelled = true;
  }
  if (cancelled) {
    await ctx.reply('Отменено.');
  }
});

// ─────────────────────────────────────────────────────────────
//  Callback'и меню
// ─────────────────────────────────────────────────────────────

/**
 * Persistent ReplyKeyboard "🏠 Меню" → текстовое сообщение.
 * Здесь же ловим, отвечаем НОВЫМ сообщением с inline-меню.
 *
 * Используем sendMessage (через ctx.reply), а не editMessageText,
 * потому что ReplyKeyboard приходит как обычное message — старого
 * inline-сообщения, которое можно отредактировать, у нас тут нет.
 *
 * Регекс с якорями ^...$ — чтобы не реагировать на сообщения вроде
 * "хочу 🏠 Меню купить" или произвольный текст с эмодзи дома.
 */
bot.hears(/^🏠 Меню$/, async (ctx) => {
  await ctx.reply(mainMenuText(ctx.from?.first_name), {
    reply_markup: mainMenuKeyboard(),
  });
});

bot.callbackQuery('menu:home', async (ctx) => {
  await ctx.editMessageText(mainMenuText(ctx.from?.first_name), {
    reply_markup: mainMenuKeyboard(),
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('menu:buy', async (ctx) => {
  await ctx.editMessageText(
    'Выбери срок. Чем длиннее — тем выгоднее:',
    { reply_markup: plansKeyboard() },
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('menu:keys', async (ctx) => {
  if (!ctx.from) return;
  const user = await db.user.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
  if (!user) return ctx.answerCallbackQuery('Запусти /start заново.');

  const subs = await activeForUser(user.id);
  const subUrl = `${env.PUBLIC_URL.replace(/\/$/, '')}/sub/${user.subAggregatorToken}?format=singbox`;

  let text: string;
  if (subs.length === 0) {
    text =
      '🔑 У тебя пока нет активных подписок.\nКупи доступ через «💳 Купить» или используй триал /start.';
  } else {
    const lines = ['🔑 *Твои подписки:*', ''];
    for (const s of subs) {
      const days = Math.max(0, Math.ceil((s.expiresAt.getTime() - Date.now()) / 86400_000));
      lines.push(
        `• ${s.server.displayName} · ${s.kind === 'hy2' ? 'Hysteria2' : 'Reality'}` +
          ` — ${days}д${s.isTrial ? ' (триал)' : ''}`,
      );
    }
    lines.push('');
    lines.push('🌐 *Универсальная подписка* (одна для всех протоколов и серверов):');
    lines.push('`' + subUrl + '`');
    lines.push('');
    lines.push('Импортируй в Karing / Happ / Hiddify / sing-box.');
    text = lines.join('\n');
  }

  // Клавиатура: если есть активные подписки — показываем «🔄 Продлить»
  // отдельной строкой над «« Назад». Кнопка ведёт на тот же callback,
  // что и основное «💳 Купить» (menu:buy → выбор тарифа). Бэкенд
  // (grantOrExtend в src/subscription.ts) одинаково обрабатывает
  // создание новой подписки и продление существующей, поэтому никакого
  // отдельного флоу для renew не нужно — это чисто UX-сокращение,
  // экономящее юзеру 2 тапа: вместо «Назад → Купить → план» он жмёт
  // одну кнопку «Продлить» прямо на экране со своими ключами.
  // При subs.length === 0 продлевать нечего — оставляем только «Назад».
  const kb = new InlineKeyboard();
  if (subs.length > 0) {
    kb.text('🔄 Продлить', 'menu:buy').row();
  }
  kb.text('« Назад', 'menu:home');

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('menu:ref', async (ctx) => {
  if (!ctx.from) return;
  const user = await db.user.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
  if (!user) return ctx.answerCallbackQuery('Запусти /start заново.');
  const me = await ctx.api.getMe();
  const link = `https://t.me/${me.username}?start=ref_${user.refCode}`;
  const invitedCount = await db.user.count({ where: { referredById: user.id } });

  await ctx.editMessageText(
    `🎁 *Реферальная программа*\n\n` +
      `Зови друзей — за каждого, кто оплатит подписку, получишь *+${env.REFERRAL_BONUS_DAYS} дней*.\n\n` +
      `Твоя ссылка:\n\`${link}\`\n\n` +
      `Уже приглашено: *${invitedCount}*`,
    {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().text('« Назад', 'menu:home'),
      link_preview_options: { is_disabled: true },
    },
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('menu:howto', async (ctx) => {
  await ctx.editMessageText(
    `*Как подключить:*\n\n` +
      `1️⃣ Установи клиент:\n` +
      `   • iOS — *Karing* / *Happ* / *Streisand*\n` +
      `   • Android — *Karing* / *Hiddify*\n` +
      `   • Windows / macOS — *Hiddify*\n\n` +
      `2️⃣ В клиенте: «Добавить подписку» → вставь свою ссылку из «Мои ключи».\n\n` +
      `3️⃣ Жми Connect.`,
    {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().text('« Назад', 'menu:home'),
    },
  );
  await ctx.answerCallbackQuery();
});

// ─────────────────────────────────────────────────────────────
//  Промокоды: юзерская часть.
//  Жмёт «🎟 Промокод» → ставим awaitingPromo на 5 минут → следующий
//  обычный текст ловит handler ниже (см. bot.on('message:text')).
// ─────────────────────────────────────────────────────────────

bot.callbackQuery('menu:promo', async (ctx) => {
  if (!ctx.from) return;
  const tgId = BigInt(ctx.from.id);
  awaitingPromo.set(tgId, Date.now() + PROMO_INPUT_TIMEOUT_MS);
  await ctx.editMessageText(
    `🎟 *Введи промокод*\n\n` +
      `Отправь его сообщением (одной строкой). Если ты случайно сюда ` +
      `попал — нажми «« Назад».`,
    {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().text('« Назад', 'menu:home'),
    },
  );
  await ctx.answerCallbackQuery();
});

// ─────────────────────────────────────────────────────────────
//  Покупка: выбор тарифа → выбор провайдера → инвойс.
// ─────────────────────────────────────────────────────────────

bot.callbackQuery(/^plan:(.+)$/, async (ctx) => {
  const planId = ctx.match[1] as PlanId;
  const plan = PLANS[planId];
  if (!plan) return ctx.answerCallbackQuery('Неизвестный тариф');
  await ctx.editMessageText(
    `*${plan.title}* — ${formatRub(plan.priceRub)}\n\nВыбери способ оплаты:`,
    { parse_mode: 'Markdown', reply_markup: paymentMethodsKeyboard(planId) },
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^pay:(tg_stars|yookassa|oxapay|cryptobot):(.+)$/, async (ctx) => {
  const provider = ctx.match[1] as PaymentProvider;
  const planId = ctx.match[2] as PlanId;
  const plan = PLANS[planId];
  if (!plan || !ctx.from) return ctx.answerCallbackQuery('Ошибка');
  const user = await db.user.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
  if (!user) return ctx.answerCallbackQuery('Запусти /start заново.');

  let invoice;
  try {
    invoice = await createInvoice(user, plan, provider);
  } catch (e) {
    // Сетевая ошибка к платёжке (Crypto Pay timeout, YooKassa 5xx, и т.п.).
    // НЕ роняем бота — даём юзеру понятное сообщение.
    // eslint-disable-next-line no-console
    console.error(`[pay:${provider}] createInvoice failed`, e);
    await ctx.answerCallbackQuery({
      text: `⚠️ ${(e as Error).message || 'Не удалось создать счёт. Попробуй позже.'}`,
      show_alert: true,
    });
    return;
  }

  if (provider === 'tg_stars' && invoice.starsInvoice) {
    const i = invoice.starsInvoice;
    // Stars-инвойс: provider_token = '' (пустая строка) для XTR, см.
    // https://core.telegram.org/bots/payments-stars#sending-an-invoice
    await ctx.api.sendInvoice(
      ctx.chat!.id,
      i.title,
      i.description,
      i.payload,
      i.currency,
      i.prices,
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // YooKassa / OxaPay / CryptoBot: даём ссылку.
  if (invoice.paymentUrl) {
    await ctx.editMessageText(
      `Перейди по ссылке для оплаты *${plan.title}* (${formatRub(plan.priceRub)}):\n\n${invoice.paymentUrl}\n\n` +
        `После оплаты ключ выдастся автоматически.`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('« Назад', 'menu:home'),
      },
    );
  }
  await ctx.answerCallbackQuery();
});

// ─────────────────────────────────────────────────────────────
//  Broadcast: confirm-send / cancel callbacks.
//
//  Сама отправка — асинхронная, в фоне (мы не блокируем callback,
//  иначе TG крутил бы спиннер у админа всё время рассылки, что для
//  больших аудиторий = минуты). Колбек отвечаем сразу, рассылку
//  стартуем через void runBroadcast(...) и в конце шлём админу
//  отдельным сообщением «Готово: X из Y».
// ─────────────────────────────────────────────────────────────

/**
 * Тротлинг между сообщениями в рассылке. TG лимит для бота — порядка
 * 30 msg/sec на разные чаты. Берём 50ms = 20 msg/sec, чтобы оставить
 * запас под параллельный трафик (хендлеры для других юзеров,
 * webhook'и платежей). Если упереться в лимит — TG возвращает 429
 * с retry_after; мы и так это глотаем в catch, но лучше до него
 * не доходить.
 */
const BROADCAST_DELAY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runBroadcast(adminTgId: bigint, text: string): Promise<void> {
  const users = await db.user.findMany({
    where: { banned: false },
    select: { tgId: true },
  });

  let sent = 0;
  let failed = 0;
  for (const u of users) {
    try {
      await bot.api.sendMessage(Number(u.tgId), text, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
      sent++;
    } catch (e) {
      // 403 (юзер заблокировал бота), 400 chat not found, deactivated —
      // нормальные «уже неактуальные» юзеры. Не падаем, просто считаем.
      failed++;
    }
    await sleep(BROADCAST_DELAY_MS);
  }

  // Финальный отчёт админу — отдельным сообщением, чтобы было видно
  // в его чате (не editMessageText, исходный preview мог уже устареть).
  try {
    await bot.api.sendMessage(
      Number(adminTgId),
      `✅ Рассылка завершена.\n` +
        `Отправлено: *${sent}* из *${users.length}*.\n` +
        `Не доставлено: *${failed}*.`,
      { parse_mode: 'Markdown' },
    );
  } catch {
    // Админ заблокировал собственного бота? Ну и ладно.
  }
}

bot.callbackQuery('broadcast:send', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) {
    return ctx.answerCallbackQuery();
  }
  const tgId = BigInt(ctx.from.id);
  const draft = broadcastState.get(tgId);
  if (!draft || draft.stage !== 'confirming') {
    await ctx.answerCallbackQuery({
      text: 'Черновик не найден (видимо, бот перезагружался). Запусти /broadcast заново.',
      show_alert: true,
    });
    return;
  }
  // Снимаем state СРАЗУ — на случай двойного нажатия «Отправить».
  broadcastState.delete(tgId);

  const total = await db.user.count({ where: { banned: false } });
  // Грубая оценка: 50ms на сообщение → секунд = total / 20.
  const estSec = Math.max(1, Math.ceil(total / 20));

  await ctx.editMessageText(
    `📤 Отправляю...\n\n_Это может занять до ${estSec} сек._`,
    { parse_mode: 'Markdown' },
  );
  await ctx.answerCallbackQuery();

  // ВАЖНО: не await — рассылка идёт в фоне, callback закрыт.
  void runBroadcast(tgId, draft.text).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[broadcast] runBroadcast failed', e);
  });
});

bot.callbackQuery('broadcast:cancel', async (ctx) => {
  if (!ctx.from || !isAdmin(BigInt(ctx.from.id))) {
    return ctx.answerCallbackQuery();
  }
  broadcastState.delete(BigInt(ctx.from.id));
  await ctx.editMessageText('❌ Рассылка отменена.');
  await ctx.answerCallbackQuery();
});

// ─────────────────────────────────────────────────────────────
//  Свободный текст: ловим ввод промокода.
//
//  Этот handler должен быть ПОСЛЕ всех bot.command(...) и bot.hears(...) —
//  grammY обрабатывает их в порядке регистрации, и `bot.on('message:text')`
//  ловит ВСЁ что не отловили специфичные хендлеры. Если поставить выше
//  — съест и /команды, и нажатие «🏠 Меню».
//
//  Логика:
//   1. Юзер должен быть в state awaitingPromo (поставил callback menu:promo).
//   2. State не просрочен (5-минутное окно).
//   3. Текст — не команда (на случай если юзер в окне промо ввёл «/start»).
//   4. Текст — не «🏠 Меню» (race с bot.hears, мало вероятен но защищаемся).
//   5. State одноразовый — удаляем сразу, чтобы дальше юзер мог писать
//      обычные сообщения без побочных эффектов.
// ─────────────────────────────────────────────────────────────
bot.on('message:text', async (ctx) => {
  if (!ctx.from) return;
  const tgId = BigInt(ctx.from.id);

  // ─────────────────────────────────────
  //  1. Broadcast (admin only): ждём текст рассылки.
  //     Раньше промо-обработки специально — у админа может быть
  //     одновременно открыт и /broadcast, и «🎟 Промокод» (на
  //     практике — никогда, но в коде дешевле гарантировать порядок).
  // ─────────────────────────────────────
  const draft = broadcastState.get(tgId);
  if (draft && draft.stage === 'awaitingText' && isAdmin(tgId)) {
    const text = ctx.message.text;
    // /cancel здесь не сработает — попадёт в bot.command('cancel')
    // выше по цепочке, до этого хендлера. Поэтому если мы тут — это
    // именно текст рассылки.
    broadcastState.set(tgId, { stage: 'confirming', text });

    // Аудитория = все НЕ-баненые юзеры. (Триал-/без-подписки тоже
    // получают: рассылка может быть про скидку, и тригерить покупку.)
    const recipients = await db.user.count({ where: { banned: false } });

    // Склонение «человек/человека/человек» по правилам ru.
    const peopleWord = (n: number): string => {
      const abs = Math.abs(n);
      const mod10 = abs % 10;
      const mod100 = abs % 100;
      if (mod100 >= 11 && mod100 <= 14) return 'человек';
      if (mod10 === 1) return 'человек';
      if (mod10 >= 2 && mod10 <= 4) return 'человека';
      return 'человек';
    };

    const preview =
      `📢 *Превью рассылки:*\n\n` +
      `${text}\n\n` +
      `_Будет отправлено всем активным юзерам (~${recipients} ${peopleWord(recipients)})._`;

    await ctx.reply(preview, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text('✅ Отправить', 'broadcast:send')
        .text('❌ Отмена', 'broadcast:cancel'),
    });
    return;
  }

  // ─────────────────────────────────────
  //  2. Промокод: ждём ввод кода.
  // ─────────────────────────────────────
  const promoUntil = awaitingPromo.get(tgId);
  if (!promoUntil) return;
  if (promoUntil < Date.now()) {
    awaitingPromo.delete(tgId);
    return;
  }

  const raw = ctx.message.text.trim();
  // Игнорируем команды и нажатие «🏠 Меню» — они должны были отловиться
  // выше; если попали сюда (race / опечатка), не пытаемся редимить.
  if (raw.startsWith('/') || raw === '🏠 Меню') return;

  // State одноразовый.
  awaitingPromo.delete(tgId);

  const user = await db.user.findUnique({ where: { tgId } });
  if (!user) {
    await ctx.reply('Запусти /start заново.');
    return;
  }
  if (user.banned) return; // тихо игнорируем

  const result = await redeemPromoCode(user, raw);

  if (result.success) {
    const lines = [
      `🎟 *Промокод активирован!*`,
      ``,
      `Тебе начислено: *${pluralDays(result.daysGranted)}*`,
    ];
    if (result.expiresAt) {
      lines.push(`Действует до: *${fmtDate(result.expiresAt)}* (МСК)`);
    }
    lines.push('', 'Открой «🔑 Мои ключи».');
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
    });
  } else {
    await ctx.reply(`❌ ${result.error}`, {
      reply_markup: mainMenuKeyboard(),
    });
  }
});

// ─────────────────────────────────────────────────────────────
//  Telegram Stars: pre_checkout + successful_payment
// ─────────────────────────────────────────────────────────────

bot.on('pre_checkout_query', async (ctx) => {
  // Здесь проверяем что payload корректный и платёж ещё pending.
  const payload = ctx.preCheckoutQuery.invoice_payload;
  const m = payload.match(/^pay:(\d+)$/);
  if (!m) return ctx.answerPreCheckoutQuery(false, 'Bad payload');
  const paymentId = parseInt(m[1], 10);
  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.status !== 'pending') {
    return ctx.answerPreCheckoutQuery(false, 'Payment not found');
  }
  await ctx.answerPreCheckoutQuery(true);
});

bot.on(':successful_payment', async (ctx) => {
  const payload = ctx.message?.successful_payment?.invoice_payload ?? '';
  const m = payload.match(/^pay:(\d+)$/);
  if (!m) return;
  const paymentId = parseInt(m[1], 10);
  // Подробное уведомление с тарифом, сроком и датой шлёт onPaymentSuccess
  // через notify.paymentSuccess. Здесь — только меню для удобства.
  await onPaymentSuccess(paymentId, ctx.message!.successful_payment!.telegram_payment_charge_id);
  await ctx.reply('Главное меню:', { reply_markup: mainMenuKeyboard() });
});

/**
 * Универсальный хук "платёж прошёл" — вызывается из Stars-handler выше
 * и из webhook'ов YooKassa/OxaPay (см. web.ts).
 */
export async function onPaymentSuccess(paymentId: number, externalId?: string): Promise<void> {
  const payment = await markPaid(paymentId, externalId);
  if (!payment || payment.status !== 'paid') return;

  const user = await db.user.findUnique({ where: { id: payment.userId } });
  if (!user || user.banned) return;

  // 1. Продлеваем подписку
  const subs = await grantOrExtend(user, payment.planDays, false);
  const expiresAt = maxExpiresAt(subs);

  // 2. Уведомление юзеру с тарифом / сроком / датой окончания.
  if (expiresAt) {
    await notify.paymentSuccess(
      user.tgId,
      planTitleFromDays(payment.planDays),
      payment.planDays,
      expiresAt,
    );
  }

  // 3. Реферальный бонус — если у юзера есть referredBy и бонус ещё не выдан,
  //    и это его ПЕРВАЯ платная покупка (не trial).
  if (user.referredById && !payment.referrerBonusGranted && env.REFERRAL_BONUS_DAYS > 0) {
    const paidPayments = await db.payment.count({
      where: { userId: user.id, status: 'paid', provider: { not: 'trial' } },
    });
    if (paidPayments === 1) {
      const referrer = await db.user.findUnique({ where: { id: user.referredById } });
      if (referrer && !referrer.banned) {
        const refSubs = await grantOrExtend(referrer, env.REFERRAL_BONUS_DAYS, false);
        const refExpiresAt = maxExpiresAt(refSubs);
        if (refExpiresAt) {
          await notify.referralBonus(referrer.tgId, env.REFERRAL_BONUS_DAYS, refExpiresAt);
        }
      }
      await db.payment.update({
        where: { id: payment.id },
        data: { referrerBonusGranted: true },
      });
    }
  }
}
