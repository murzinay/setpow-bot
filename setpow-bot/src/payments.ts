/**
 * Платёжки. На MVP — только Telegram Stars реализован реально (он не требует
 * внешних аккаунтов и работает через native sendInvoice). YooKassa и OxaPay —
 * заглушки с TODO; интерфейс единый, реализация подключается по env-флагам
 * (см. paymentsAvailable в config.ts).
 *
 * Контракт:
 *   - createInvoice(...) → возвращает либо payload для отправки в Telegram
 *     (Stars), либо URL для оплаты (YooKassa/OxaPay).
 *   - webhook(...) → обработчик колбэка от платёжки. Вызывается из web.ts.
 */
import type { Plan } from './plans';
import type { User } from '@prisma/client';
import { db } from './db';
import { env } from './config';

export type PaymentProvider = 'tg_stars' | 'yookassa' | 'oxapay' | 'cryptobot';

export interface InvoiceResult {
  provider: PaymentProvider;
  // payment.id из БД — мы используем его как payload для callback'ов.
  paymentId: number;
  // Для YooKassa/OxaPay — URL для редиректа юзера в браузер.
  // Для Stars — null (платёж происходит через bot.api.sendInvoice).
  paymentUrl: string | null;
  // Опциональные данные для Stars (передаются в sendInvoice).
  starsInvoice?: {
    title: string;
    description: string;
    payload: string;
    currency: 'XTR';
    prices: Array<{ label: string; amount: number }>;
  };
}

/**
 * Создать запись Payment(pending) и вернуть данные для оплаты.
 */
export async function createInvoice(
  user: User,
  plan: Plan,
  provider: PaymentProvider,
): Promise<InvoiceResult> {
  if (provider === 'tg_stars') {
    const payment = await db.payment.create({
      data: {
        userId: user.id,
        provider: 'tg_stars',
        amount: plan.priceStars,
        currency: 'XTR',
        planDays: plan.days,
        status: 'pending',
      },
    });
    return {
      provider,
      paymentId: payment.id,
      paymentUrl: null,
      starsInvoice: {
        title: `Cryox VPN — ${plan.title}`,
        description: `Доступ к VPN на ${plan.days} дней.`,
        // Используем строковый paymentId для связки на колбэке.
        payload: `pay:${payment.id}`,
        currency: 'XTR',
        prices: [{ label: plan.title, amount: plan.priceStars }],
      },
    };
  }

  if (provider === 'yookassa') {
    // TODO: реальная YooKassa-интеграция (REST POST /v3/payments).
    // Док: https://yookassa.ru/developers/api#create_payment
    const payment = await db.payment.create({
      data: {
        userId: user.id,
        provider: 'yookassa',
        amount: plan.priceRub,
        currency: 'RUB',
        planDays: plan.days,
        status: 'pending',
      },
    });
    return {
      provider,
      paymentId: payment.id,
      // Заглушка: возвращаем псевдо-URL чтобы UI мог показать.
      paymentUrl: `https://yookassa.example/pay/${payment.id}`,
    };
  }

  if (provider === 'oxapay') {
    // TODO: реальная OxaPay-интеграция (POST /merchants/request).
    // Док: https://docs.oxapay.com/api-reference/payment
    const payment = await db.payment.create({
      data: {
        userId: user.id,
        provider: 'oxapay',
        amount: plan.priceUsdCents,
        currency: 'USDT',
        planDays: plan.days,
        status: 'pending',
      },
    });
    return {
      provider,
      paymentId: payment.id,
      paymentUrl: `https://oxapay.example/pay/${payment.id}`,
    };
  }

  if (provider === 'cryptobot') {
    // Создаём pending-платёж ДО запроса в Crypto Pay — нужен payment.id
    // как payload, чтобы webhook нашёл свой Payment в БД.
    const payment = await db.payment.create({
      data: {
        userId: user.id,
        provider: 'cryptobot',
        // Crypto Pay поддерживает RUB как fiat-валюту с авто-конверсией
        // в USDT/TON/BTC. Хранить будем как RUB-копейки — тот же формат
        // что у YooKassa, чтобы агрегаты выручки в /admin не зависели от
        // провайдера. amount в API передаём в рублях с дробной частью.
        amount: plan.priceRub,
        currency: 'RUB',
        planDays: plan.days,
        status: 'pending',
      },
    });

    // Crypto Pay docs: https://help.crypt.bot/crypto-pay-api
    // Mainnet vs testnet — выбираем по env-флагу. Тестнет работает с
    // @CryptoTestnetBot и с тестовыми токенами, на проде нужен mainnet.
    const baseUrl = env.CRYPTOPAY_TESTNET
      ? 'https://testnet-pay.crypt.bot/api'
      : 'https://pay.crypt.bot/api';

    let payUrl: string;
    let invoiceId: string;
    try {
      const res = await fetch(`${baseUrl}/createInvoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Crypto-Pay-API-Token': env.CRYPTOPAY_API_TOKEN,
        },
        body: JSON.stringify({
          currency_type: 'fiat',
          fiat: 'RUB',
          // amount в Crypto Pay API — строка, две знака после запятой ОК.
          amount: (plan.priceRub / 100).toFixed(2),
          // Какие крипты принимать. Если не указать — все доступные.
          // Ограничиваем до самых популярных у TG-аудитории чтобы не
          // путать UX обилием ассетов.
          accepted_assets: 'USDT,TON,BTC,ETH',
          description: `Cryox VPN — ${plan.title} (${plan.days} дней)`,
          // payload вернётся в webhook, по нему ищем Payment.
          payload: String(payment.id),
          // 1 час на оплату. Если истечёт — Crypto Pay автоматически
          // переведёт invoice в "expired", webhook не придёт. Юзер
          // просто создаст новый инвойс кнопкой "Купить".
          expires_in: 3600,
          allow_comments: false,
          allow_anonymous: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as
        | { ok: true; result: { invoice_id: number; pay_url: string } }
        | { ok: false; error: { code: number; name: string } };
      if (!data.ok) {
        throw new Error(`Crypto Pay error: ${data.error.code} ${data.error.name}`);
      }
      payUrl = data.result.pay_url;
      invoiceId = String(data.result.invoice_id);
    } catch (e) {
      // Платёж останется pending, юзер просто увидит ошибку. Это OK —
      // pending-записи никому не мешают, наполняют статистику честно.
      // eslint-disable-next-line no-console
      console.error('[cryptobot] createInvoice failed', e);
      throw new Error('Не удалось создать счёт в Crypto Pay. Попробуй позже.');
    }

    // Сохраняем invoice_id как externalId — пригодится в webhook
    // (двойная проверка) и для аудита в /admin.
    await db.payment.update({
      where: { id: payment.id },
      data: { externalId: invoiceId },
    });

    return {
      provider,
      paymentId: payment.id,
      paymentUrl: payUrl,
    };
  }

  throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Пометить платёж как оплаченный. Должен вызываться из:
 *   - PreCheckoutQuery + SuccessfulPayment handler (для Stars)
 *   - Webhook YooKassa
 *   - Webhook OxaPay
 *
 * Возвращает Payment с status=paid или null если уже был обработан (idempotent).
 */
export async function markPaid(paymentId: number, externalId?: string) {
  const existing = await db.payment.findUnique({ where: { id: paymentId } });
  if (!existing) return null;
  if (existing.status === 'paid') return existing; // idempotent
  return db.payment.update({
    where: { id: paymentId },
    data: {
      status: 'paid',
      paidAt: new Date(),
      externalId: externalId ?? existing.externalId,
    },
  });
}
