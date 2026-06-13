/**
 * Алерты админу о критических ошибках через Telegram.
 *
 * Зачем нужно отдельным модулем (а не inline в bot.catch):
 *   1. Дедупликация. Если ошибка валится на каждом апдейте (например,
 *      Prisma потеряла соединение), без дедупа бот зашлёт 100 одинаковых
 *      алертов за минуту и сам себе устроит flood wait → перестанет
 *      отвечать вообще.
 *   2. Защита от рекурсии. Если сам алерт упадёт (например, у админа
 *      заблокирован чат или TG ответил 5xx), мы НЕ должны вызывать
 *      bot.catch ещё раз — иначе бесконечный цикл. Все ошибки внутри
 *      notifyAdminError глотаются молча.
 *   3. Точка для будущих расширений: разные приоритеты (warn/error),
 *      алерты в Sentry/PagerDuty, и т.п.
 *
 * Реализация:
 *   - Хэш фингерпринт = source + первая строка стека + message. Так
 *     одна и та же ошибка из одного и того же места считается одним
 *     событием, даже если message слегка отличается (например, разные
 *     id юзеров в строке).
 *   - Cooldown 30 минут на фингерпринт. После 30 минут — пришлём ещё
 *     один алерт с пометкой «продолжается».
 *   - Шлём только первому админу (env.ADMIN_IDS[0]) — алерты это его
 *     личная боль, не нужно спамить остальных.
 *
 * Память: Map с фингерпринтами растёт со временем. На практике
 * уникальных ошибок мало (десятки), процесс перезапускается с pm2,
 * поэтому cleanup не делаем — это сэкономит код.
 */
import crypto from 'node:crypto';
import { bot } from './bot';
import { env } from './config';

interface AlertState {
  /** Время последней отправки этого фингерпринта (ms). */
  lastSentAt: number;
  /** Сколько раз ошибка повторилась с прошлой отправки. */
  suppressedCount: number;
}

const COOLDOWN_MS = 30 * 60_000;
const seen = new Map<string, AlertState>();

/**
 * Фингерпринт = SHA1(source + ':' + первая строка стека + ':' + message).
 *
 * Берём первую строку стека (а не весь стек) чтобы:
 *   - one-liner ошибки (без стека) тоже имели стабильный fp,
 *   - разные пути из одного места (разные юзеры → разные tgId в message)
 *     не плодили разные fp.
 */
function fingerprint(source: string, error: unknown): string {
  const e = error as Error;
  const msg = (e?.message || String(error)).slice(0, 200);
  const firstStackLine = (e?.stack || '').split('\n')[1] || '';
  const h = crypto.createHash('sha1');
  h.update(source);
  h.update('\x00');
  h.update(firstStackLine);
  h.update('\x00');
  h.update(msg);
  return h.digest('hex').slice(0, 12);
}

/**
 * Усечь стек до первых N строк — TG лимит на сообщение 4096 символов,
 * а сам стек может быть на десятки килобайт (особенно у Prisma).
 * 8 строк хватает чтобы понять место ошибки в нашем коде.
 */
function shortStack(error: unknown, lines = 8): string {
  const e = error as Error;
  if (!e?.stack) return '';
  return e.stack.split('\n').slice(0, lines).join('\n');
}

function escapeMd(s: string): string {
  // Telegram Markdown v1 экранирование. Нам важно чтобы сообщение
  // не упало с 400 BAD_REQUEST из-за случайного `_` в стеке.
  return s.replace(/[_*`\[]/g, (m) => '\\' + m);
}

/**
 * Отправить админу алерт об ошибке. Никогда не бросает наружу —
 * вызвавший код может её игнорировать.
 *
 * @param source короткий тег места ошибки: 'bot.catch', 'cron/notify',
 *               'unhandledRejection', и т.п. Идёт в фингерпринт и в
 *               заголовок сообщения.
 * @param error  объект ошибки (Error или что угодно).
 */
export async function notifyAdminError(source: string, error: unknown): Promise<void> {
  const adminId = env.ADMIN_IDS[0];
  if (!adminId) return; // нет админов = некому слать

  const fp = fingerprint(source, error);
  const now = Date.now();
  const prev = seen.get(fp);

  // Cooldown: если эту же ошибку уже слали недавно — копим счётчик,
  // молчим. Когда таймер истечёт, в следующем алерте укажем сколько
  // раз ошибка повторилась.
  if (prev && now - prev.lastSentAt < COOLDOWN_MS) {
    prev.suppressedCount++;
    return;
  }

  const suppressedNote = prev && prev.suppressedCount > 0
    ? `\n_За последние 30 мин повторилась ${prev.suppressedCount} раз._`
    : '';

  seen.set(fp, { lastSentAt: now, suppressedCount: 0 });

  const e = error as Error;
  const msg = e?.message || String(error);
  const stack = shortStack(error);

  const text =
    `🚨 *${escapeMd(source)}* \\[${fp}]\n\n` +
    '`' + escapeMd(msg.slice(0, 500)) + '`' +
    (stack ? '\n\n```\n' + stack.slice(0, 2000) + '\n```' : '') +
    suppressedNote;

  try {
    await bot.api.sendMessage(Number(adminId), text, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  } catch (sendErr) {
    // Если сам алерт не отправился — ничего не делаем. Падать в catch
    // bot'a ещё раз = риск рекурсии. Логируем в console и идём дальше.
    // eslint-disable-next-line no-console
    console.warn(
      '[adminAlerts] failed to notify admin',
      adminId.toString(),
      (sendErr as Error).message,
    );
  }
}
