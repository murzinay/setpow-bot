/**
 * Простой in-memory rate limiter для grammY-бота.
 *
 * Зачем нужен: появилась persistent ReplyKeyboard с кнопкой "🏠 Меню"
 * снизу экрана. Юзер может зажать её и спамить — каждый тап шлёт
 * текстовое сообщение боту, бот делает запрос в TG API на reply.
 * Без лимитов это:
 *   1. Грузит наш Express + Prisma (каждый /start читает БД)
 *   2. Превышает рейт TG Bot API (30 msg/sec на чат → flood wait)
 *   3. Заваливает чат юзера 50+ сообщениями главного меню
 *
 * Алгоритм — sliding window per user:
 *   - На каждый апдейт берём timestamps последних запросов юзера
 *   - Отбрасываем те что старше windowMs
 *   - Если оставшихся ≥ max → блокируем (не вызываем next())
 *   - Иначе добавляем текущий timestamp и пропускаем дальше
 *
 * Админы (ADMIN_IDS из env) обходят лимит — им может потребоваться
 * /backfill 200 юзеров подряд или быстрое /give нескольким сразу.
 *
 * Память: Map хранит до 100 timestamps на юзера. При 10k активных
 * юзеров это ~16 MB — норм. Раз в 5 минут проходим cleanup и удаляем
 * пустые корзины.
 */
import type { MiddlewareFn, Context } from 'grammy';
import { isAdmin } from './config';

interface RateLimitOptions {
  /** Максимум запросов в окне. */
  max: number;
  /** Длина окна в миллисекундах. */
  windowMs: number;
  /** Сообщение которое показываем юзеру при превышении. null → молча. */
  blockedMessage?: string;
}

const DEFAULTS: RateLimitOptions = {
  max: 5,
  windowMs: 5_000,
  blockedMessage: '⏳ Подожди секунду — слишком быстро.',
};

/**
 * Создать rate-limit middleware.
 *
 * Применять ОДИН раз через `bot.use(...)` сразу после `bot.catch`.
 * Раньше bot.catch ставить нельзя (если middleware кинет — некому
 * ловить); позже хендлеров — тоже нельзя (сами хендлеры выполнятся
 * до проверки лимита).
 */
export function createRateLimiter(opts: Partial<RateLimitOptions> = {}): MiddlewareFn<Context> {
  const cfg = { ...DEFAULTS, ...opts };
  const buckets = new Map<bigint, number[]>();

  // Периодическая очистка от мёртвых корзин чтобы Map не рос вечно.
  // unref() — чтобы интервал не блокировал graceful shutdown процесса.
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - cfg.windowMs;
    for (const [id, times] of buckets) {
      const fresh = times.filter((t) => t > cutoff);
      if (fresh.length === 0) buckets.delete(id);
      else buckets.set(id, fresh);
    }
  }, 5 * 60_000);
  cleanup.unref();

  return async (ctx, next) => {
    if (!ctx.from) return next();
    const tgId = BigInt(ctx.from.id);

    // Админам — зелёный свет. /backfill и серии /give не должны
    // блокироваться лимитом для обычных юзеров.
    if (isAdmin(tgId)) return next();

    const now = Date.now();
    const cutoff = now - cfg.windowMs;
    const times = (buckets.get(tgId) ?? []).filter((t) => t > cutoff);

    if (times.length >= cfg.max) {
      // Юзер превысил лимит. Тихо отбрасываем — НЕ вызываем next().
      // Для callback-кнопок отвечаем show_alert чтобы крутящиеся
      // "часики" исчезли + юзер получил фидбек что бот его слышит,
      // но просит подождать. Для текстовых сообщений — просто молчим
      // (если каждое сообщение спама порождает ещё одно "подожди" —
      // это удваивает спам).
      if (ctx.callbackQuery && cfg.blockedMessage) {
        try {
          await ctx.answerCallbackQuery({
            text: cfg.blockedMessage,
            show_alert: false,
          });
        } catch {
          // ignore
        }
      }
      return;
    }

    times.push(now);
    buckets.set(tgId, times);
    return next();
  };
}
