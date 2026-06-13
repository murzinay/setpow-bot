/**
 * Загрузка и валидация ENV. Единственное место, где мы читаем process.env.
 * Если что-то невалидное — падаем СРАЗУ при старте, не в рантайме.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  BOT_TOKEN: z.string().min(20, 'BOT_TOKEN must be set (get one from @BotFather)'),
  // CSV → array<bigint>
  ADMIN_IDS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => BigInt(x)),
    ),

  PUBLIC_URL: z.string().url(),
  HTTP_PORT: z.coerce.number().int().positive().default(8080),

  // Отдельный домен для ссылок-подписок: https://sub.cryox.me
  // Если задан — ссылка отдаётся «чистой» (sub.cryox.me/<token>, без
  // /sub/ и без ?format), а reverse-proxy переписывает путь на внутренний
  // /sub/<token>. Пусто → обратная совместимость: ${PUBLIC_URL}/sub/<token>.
  SUB_BASE_URL: z.string().optional().default(''),

  DATABASE_URL: z.string().min(1),

  PANEL_URL: z.string().url(),
  PANEL_API_KEY: z.string().min(8),

  YOOKASSA_SHOP_ID: z.string().optional().default(''),
  YOOKASSA_SECRET_KEY: z.string().optional().default(''),
  TG_STARS_ENABLED: z
    .string()
    .default('true')
    .transform((s) => s.toLowerCase() === 'true'),
  OXAPAY_MERCHANT_KEY: z.string().optional().default(''),
  // Crypto Pay API token from @CryptoBot → /pay → Crypto Pay → Create App.
  // Format like "12345:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".
  CRYPTOPAY_API_TOKEN: z.string().optional().default(''),
  // true → use @CryptoTestnetBot (testnet-pay.crypt.bot). For dev only.
  CRYPTOPAY_TESTNET: z
    .string()
    .default('false')
    .transform((s) => s.toLowerCase() === 'true'),

  REFERRAL_BONUS_DAYS: z.coerce.number().int().nonnegative().default(7),
  TRIAL_DAYS: z.coerce.number().int().nonnegative().default(3),

  ADMIN_WEB_USER: z.string().default('admin'),
  ADMIN_WEB_PASSWORD: z.string().min(4),

  // ───── Мини-апп: внешние ссылки ─────
  // Контакт поддержки и Telegram-канал, которые показываются в TMA.
  // Пусто → соответствующая кнопка во фронте скрывается. Заполняются
  // вручную в .env (любая https:// или t.me ссылка).
  SUPPORT_URL: z.string().optional().default(''),
  CHANNEL_URL: z.string().optional().default(''),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌  Invalid ENV:\n', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

// Алиасы провайдеров — какие реально активны.
export const paymentsAvailable = {
  yookassa: !!(env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY),
  tgStars: env.TG_STARS_ENABLED,
  oxapay: !!env.OXAPAY_MERCHANT_KEY,
  cryptobot: !!env.CRYPTOPAY_API_TOKEN,
};

export function isAdmin(tgId: bigint | number): boolean {
  const id = typeof tgId === 'number' ? BigInt(tgId) : tgId;
  return env.ADMIN_IDS.some((x) => x === id);
}
