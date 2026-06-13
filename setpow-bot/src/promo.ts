/**
 * Промокоды — одноразовая выдача дней по коду.
 *
 * Бизнес-логика отделена от bot.ts (хендлеров) сознательно: тут
 * валидация / поиск / транзакция в БД / интеграция с grantOrExtend.
 * Хендлеры в bot.ts только парсят ввод юзера и форматируют ответ.
 *
 * Все ошибки возвращаем как { success: false, error } — это «ожидаемые»
 * пользовательские ошибки (плохой код, истёк, использован), их выводим
 * юзеру дословно. Реальные исключения (БД упала, панель недоступна)
 * пробрасываются наверх — их ловит общий bot.catch и логирует.
 */
import type { User } from '@prisma/client';
import { db } from './db';
import { grantOrExtend, activeForUser } from './subscription';

export interface RedeemSuccess {
  success: true;
  daysGranted: number;
  /** Максимальная expiresAt из активных подписок ПОСЛЕ начисления. */
  expiresAt: Date | null;
}
export interface RedeemFailure {
  success: false;
  error: string;
}
export type RedeemResult = RedeemSuccess | RedeemFailure;

/**
 * Активировать промокод от имени юзера.
 *
 * Шаги:
 *   1. Нормализуем код (trim + UPPER) — юзер может ввести в любом регистре.
 *   2. Ищем по уникальному code. Если нет — «не найден».
 *   3. Проверяем active / expiresAt / maxUses.
 *   4. Проверяем что этот юзер ещё не активировал этот код.
 *   5. grantOrExtend(user, freeDays) — реальное продление подписок.
 *   6. В одной транзакции: создаём Redemption, инкрементим uses,
 *      создаём Payment{provider:'promo', amount:0, planDays} —
 *      чтобы /admin показывал промо-активации в логе платежей.
 *   7. Возвращаем daysGranted + новую максимальную expiresAt
 *      (для строки "Действует до: ..." в ответе юзеру).
 */
export async function redeemPromoCode(
  user: User,
  codeStr: string,
): Promise<RedeemResult> {
  const code = codeStr.trim().toUpperCase();
  if (!code) {
    return { success: false, error: 'Промокод не найден' };
  }

  const promo = await db.promoCode.findUnique({ where: { code } });
  if (!promo) {
    return { success: false, error: 'Промокод не найден' };
  }
  if (!promo.active) {
    return { success: false, error: 'Промокод деактивирован' };
  }
  if (promo.expiresAt && promo.expiresAt.getTime() < Date.now()) {
    return { success: false, error: 'Промокод истёк' };
  }
  if (promo.maxUses !== null && promo.uses >= promo.maxUses) {
    return { success: false, error: 'Промокод использован полностью' };
  }

  // Pre-check: уже активировал ранее? Это soft-проверка ради красивого
  // сообщения. На race-условиях гарантирует @@unique([userId, promoCodeId])
  // в схеме — даже если два сообщения придут одновременно, второе упадёт
  // на unique constraint и попадёт в catch ниже.
  const existing = await db.promoCodeRedemption.findUnique({
    where: { userId_promoCodeId: { userId: user.id, promoCodeId: promo.id } },
  });
  if (existing) {
    return { success: false, error: 'Ты уже использовал этот промокод' };
  }

  // Сначала продлеваем (или создаём) подписки на панели и в БД.
  // Если упадёт — пробросится исключение, никакого Redemption/Payment
  // не создастся. Это правильное поведение: «деньги не списали».
  await grantOrExtend(user, promo.freeDays, false);

  // Транзакция: redemption + uses++ + Payment запись для /admin.
  // Если хотя бы одна часть упадёт (например, race на unique), —
  // откатимся и юзер получит ошибку. Подписка останется продлённой
  // (это «лишний» бонус для юзера и единственно безопасный путь:
  // отзывать продление мы технически можем, но на практике это лишь
  // создаёт ещё одну точку отказа). Учитывая что race — это
  // почти-невозможный случай (один и тот же юзер дважды нажал ввод),
  // допустимо.
  try {
    await db.$transaction([
      db.promoCodeRedemption.create({
        data: {
          userId: user.id,
          promoCodeId: promo.id,
          daysGranted: promo.freeDays,
        },
      }),
      db.promoCode.update({
        where: { id: promo.id },
        data: { uses: { increment: 1 } },
      }),
      db.payment.create({
        data: {
          userId: user.id,
          provider: 'promo',
          amount: 0,
          currency: 'RUB',
          planDays: promo.freeDays,
          status: 'paid',
          paidAt: new Date(),
          externalId: `promo:${code}`,
        },
      }),
    ]);
  } catch (e) {
    // Самый вероятный сценарий: P2002 unique violation на повторной
    // активации (race). Считаем как «уже использовал».
    const msg = (e as Error).message || '';
    if (msg.includes('Unique constraint') || msg.includes('UNIQUE')) {
      return { success: false, error: 'Ты уже использовал этот промокод' };
    }
    throw e;
  }

  // После grantOrExtend подписки уже обновлены — берём их максимальную
  // дату окончания, чтобы показать юзеру «действует до X».
  const subs = await activeForUser(user.id);
  let maxExpiresAt: Date | null = null;
  for (const s of subs) {
    if (!maxExpiresAt || s.expiresAt > maxExpiresAt) maxExpiresAt = s.expiresAt;
  }

  return {
    success: true,
    daysGranted: promo.freeDays,
    expiresAt: maxExpiresAt,
  };
}
