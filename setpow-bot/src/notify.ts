/**
 * Пользовательские уведомления — единое место для всех системных
 * сообщений бота юзерам. Каждая функция:
 *   - не бросает наружу (юзер мог заблочить бота — это нормально),
 *   - логирует неуспех в console.warn для отладки,
 *   - использует Markdown.
 *
 * Когда добавим i18n (TODO в CONTEXT.md), локализованные строки
 * переедут сюда же — точка входа уже единая.
 *
 * Циклический import с bot.ts:
 *   bot.ts импортирует notify, notify импортирует bot.
 *   На top-level notify.ts мы НЕ используем `bot` — только внутри
 *   функций. ESM это разруливает: к моменту первого вызова
 *   notify.* модуль bot.ts уже инициализирован.
 */
import { InlineKeyboard } from 'grammy';
import { bot } from './bot';

// ─────────────────────────────────────────────────────────────
// Хелперы
// ─────────────────────────────────────────────────────────────

/** Корректное склонение: 1 день / 2 дня / 5 дней / 21 день / 11..14 дней. */
export function pluralDays(n: number): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 14) return `${n} дней`;
  if (mod10 === 1) return `${n} день`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} дня`;
  return `${n} дней`;
}

/**
 * Формат "DD.MM.YYYY HH:MM" по Москве. VPS живёт в UTC, основная
 * аудитория — РФ, удобнее показать локальное время.
 */
export function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  }).format(d);
}

/**
 * Безопасная отправка: ловим всё, что бросит TG (юзер заблочил бота,
 * деактивированный аккаунт, рейт-лимит), не роняем вызывающий код.
 * Возвращает true/false для возможной аналитики позже.
 *
 * @param extra произвольные опции grammY поверх дефолтных (Markdown +
 *              отключённое превью). Типично — reply_markup для inline
 *              кнопок прямо в уведомлении.
 */
async function send(
  tgId: bigint,
  text: string,
  extra?: { reply_markup?: InlineKeyboard },
): Promise<boolean> {
  try {
    await bot.api.sendMessage(Number(tgId), text, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[notify] send failed', tgId.toString(), (e as Error).message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Уведомления по событиям
// ─────────────────────────────────────────────────────────────

/**
 * Пробный доступ (триал) — вызывается из /start при создании юзера,
 * если TRIAL_DAYS > 0 и триал ещё не использовался.
 */
export async function trialGranted(
  tgId: bigint,
  days: number,
  expiresAt: Date,
): Promise<boolean> {
  return send(
    tgId,
    `🎁 *Тебе выдан пробный доступ*\n\n` +
      `Срок: *${pluralDays(days)}*\n` +
      `Действует до: *${fmtDate(expiresAt)}* (МСК)\n\n` +
      `Открой «🔑 Мои ключи» в главном меню — там твоя подписка.\n` +
      `Импортируй её в Karing / Hiddify / Happ и подключайся.`,
  );
}

/** Админ выдал дни через /give. */
export async function adminGranted(
  tgId: bigint,
  days: number,
  expiresAt: Date,
): Promise<boolean> {
  return send(
    tgId,
    `🎁 *Админ выдал тебе ${pluralDays(days)}*\n\n` +
      `Подписка действует до: *${fmtDate(expiresAt)}* (МСК)\n\n` +
      `Открой «🔑 Мои ключи» чтобы увидеть актуальный срок.`,
  );
}

/** Подтверждение успешной оплаты (Stars / YooKassa / OxaPay). */
export async function paymentSuccess(
  tgId: bigint,
  planTitle: string,
  days: number,
  expiresAt: Date,
): Promise<boolean> {
  return send(
    tgId,
    `✅ *Оплата получена*\n\n` +
      `Тариф: *${planTitle}*\n` +
      `Добавлено: *${pluralDays(days)}*\n` +
      `Действует до: *${fmtDate(expiresAt)}* (МСК)\n\n` +
      `Подписка автоматически обновится в твоём клиенте — никаких ` +
      `действий не нужно.`,
  );
}

/** Реферер получил бонус за оплатившего реферала. */
export async function referralBonus(
  referrerTgId: bigint,
  days: number,
  expiresAt: Date,
): Promise<boolean> {
  return send(
    referrerTgId,
    `🎁 *Тебе начислено ${pluralDays(days)}* — твой реферал оплатил подписку.\n\n` +
      `Подписка действует до: *${fmtDate(expiresAt)}* (МСК)`,
  );
}

/**
 * По ссылке реферера зарегистрировался новый пользователь.
 * Бонус выдадим только после первой ОПЛАТЫ — это уведомление
 * предупреждает реферера, чтобы не было неожиданности.
 */
export async function referralRegistered(
  referrerTgId: bigint,
  bonusDays: number,
): Promise<boolean> {
  return send(
    referrerTgId,
    `🎉 По твоей ссылке зарегистрировался новый пользователь.\n\n` +
      `Когда он впервые оплатит подписку, ты получишь *+${pluralDays(bonusDays)}*.`,
  );
}

/** Cron: за 3 дня и за 1 день до истечения. */
export async function expiringSoon(
  tgId: bigint,
  label: string,
  expiresAt: Date,
): Promise<boolean> {
  // Кнопка «🔄 Продлить» ведёт на тот же callback, что главное меню «💳 Купить» —
  // показывает выбор тарифа с дальнейшим выбором способа оплаты. Это экономит
  // юзеру 2 тапа («/start → 💳 Купить») и заметно поднимает конверсию из
  // напоминания в продление: чем меньше шагов между «вижу что подписка
  // заканчивается» и «оплачиваю» — тем выше rate.
  //
  // Дополнительная кнопка «🔑 Мои ключи» — на случай если юзер сначала
  // хочет глянуть текущий срок и протоколы, а потом решать.
  return send(
    tgId,
    `⏰ *Подписка истекает через ${label}*\n\n` +
      `Дата окончания: *${fmtDate(expiresAt)}* (МСК)\n\n` +
      `Продли заранее — нажми кнопку ниже:`,
    {
      reply_markup: new InlineKeyboard()
        .text('🔄 Продлить', 'menu:buy').row()
        .text('🔑 Мои ключи', 'menu:keys'),
    },
  );
}

/** Cron: подписка только что истекла (статус active/trial → expired). */
export async function expired(tgId: bigint): Promise<boolean> {
  // Та же логика что в expiringSoon: даём прямой доступ к выбору
  // тарифа одной кнопкой. Юзер только что увидел «доступ остановлен»,
  // и шансы на возврат максимальны именно в этот момент.
  return send(
    tgId,
    `🔴 *Подписка истекла*\n\n` +
      `Доступ к VPN остановлен. Жми кнопку чтобы возобновить:`,
    {
      reply_markup: new InlineKeyboard().text('💳 Возобновить', 'menu:buy'),
    },
  );
}

/** Юзер забанен админом, активные подписки отозваны. */
export async function banned(tgId: bigint): Promise<boolean> {
  return send(
    tgId,
    `🚫 *Доступ заблокирован*\n\n` +
      `Твои активные подписки отозваны администратором.\n\n` +
      `Если считаешь это ошибкой — напиши в поддержку.`,
  );
}

/** Юзера разбанили. */
export async function unbanned(tgId: bigint): Promise<boolean> {
  return send(
    tgId,
    `✅ *Аккаунт разблокирован*\n\n` +
      `Запусти /start чтобы продолжить пользоваться ботом.`,
  );
}
