/**
 * Проверка Telegram WebApp initData.
 *
 * Это ЕДИНСТВЕННАЯ авторизация в TMA. Любой запрос к /api/tma/* должен прийти
 * с заголовком `Authorization: tma <initDataRaw>`. Если HMAC не сходится —
 * 401 без вариантов; иначе любой школьник подделает tgId через DevTools и
 * заберёт чужие подписки.
 *
 * Алгоритм (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *   1. Распарсить initData как application/x-www-form-urlencoded.
 *   2. Извлечь параметр `hash`. ВСЕ остальные поля (включая `signature`,
 *      если оно есть) входят в data_check_string.
 *   3. Оставшиеся пары отсортировать по ключу, склеить как "key=value\n…".
 *   4. secret = HMAC_SHA256("WebAppData", botToken).
 *   5. computed = HMAC_SHA256(secret, dataCheckString).hex.
 *   6. timing-safe сравнение computed === hash.
 *   7. Доп. проверка: auth_date не старше 24ч (защита от replay со старым
 *      initData; например, если злоумышленник украл его из логов).
 */
import crypto from 'node:crypto';

export interface TmaUser {
  /** Telegram user id как BigInt — совместимо с db.user.tgId. */
  id: bigint;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  /** ISO 639-1 ('ru', 'en', …). Пригодится когда добавим i18n. */
  languageCode: string | null;
  isPremium: boolean;
  /** True если юзер открыл TMA в боте, не в attachment-меню. */
  allowsWriteToPm: boolean;
}

/** Сколько initData считается свежим. После этого — заставляем переоткрыть TMA. */
const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;
/** Допуск для расхождения часов клиент/сервер (NTP может быть на 1-2 сек). */
const FUTURE_TOLERANCE_SECONDS = 5 * 60;

export class InitDataInvalid extends Error {
  constructor(reason: string) {
    super(`initData invalid: ${reason}`);
    this.name = 'InitDataInvalid';
  }
}

/**
 * Парсит initData в массив [key, value]-пар СОХРАНЯЯ ИСХОДНЫЙ ПОРЯДОК.
 *
 * ПОЧЕМУ НЕ URLSearchParams:
 *   URLSearchParams реализует WHATWG URL spec, а он трактует `+` как
 *   space (это для form-encoded данных из <form>). Telegram же кладёт
 *   в initData значения, которые могут содержать литеральный `+`
 *   (например, base64-encoded query_id вида "AAH+abc..."). После
 *   URLSearchParams `+` превратится в ` `, мы посчитаем HMAC от не той
 *   строки — и получим mismatch с тем, что Telegram подписал.
 *
 *   decodeURIComponent — RFC 3986, оставляет `+` как `+` и декодирует
 *   только %XX последовательности. Это и есть то, что Telegram использует
 *   при построении data_check_string.
 *
 * ПОЧЕМУ ВРУЧНУЮ:
 *   Стандартного парсера, который percent-decode'ит но НЕ съедает `+`,
 *   в Node нет. Так что split + decodeURIComponent.
 */
function parseInitData(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? '' : part.slice(eq + 1);
    try {
      out.push([decodeURIComponent(k), decodeURIComponent(v)]);
    } catch {
      // Битый percent-encoding — не должно случаться от Telegram, но если
      // прилетела порча → отдаём как есть, HMAC не сойдётся, юзер получит
      // 401 (это безопаснее, чем throw — нам не нужен 500 на пограничных
      // случаях).
      out.push([k, v]);
    }
  }
  return out;
}

export function verifyInitData(initDataRaw: string, botToken: string): TmaUser {
  if (!initDataRaw || typeof initDataRaw !== 'string') {
    throw new InitDataInvalid('empty');
  }

  const pairs = parseInitData(initDataRaw);

  // Извлекаем только `hash`, остальные поля идут в data_check_string.
  //
  // ВАЖНО про `signature`:
  //   Несколько устаревших гайдов (включая раннюю версию этого файла)
  //   утверждают, что `signature` нужно исключать из data_check_string,
  //   потому что это «отдельный механизм для third-party verification».
  //   Это НЕВЕРНО для нашего use-case.
  //
  //   Telegram Bot API 8.0 ввёл поле `signature` (Ed25519 подпись от
  //   серверов Telegram) специально для случая, когда сторонний сервис
  //   хочет верифицировать данные БЕЗ обмена с ботом. Но при этом
  //   `signature` — обычное полученное поле, и оно ВХОДИТ в
  //   data_check_string наряду со всеми остальными при обычной HMAC-
  //   проверке. Telegram гарантирует именно это: «chain of all received
  //   fields», без оговорок про signature.
  //
  //   Если исключать `signature` — HMAC не сходится никогда (production
  //   всегда возвращал 401 'bad hash'). Симптом: dcs включает только
  //   auth_date/query_id/user, а в исходном initData при этом есть
  //   ещё `signature` — этот разрыв и был источником бага.
  let hash: string | null = null;
  const filtered: Array<[string, string]> = [];
  for (const [k, v] of pairs) {
    if (k === 'hash') {
      hash = v;
      continue;
    }
    filtered.push([k, v]);
  }
  if (!hash) throw new InitDataInvalid('no hash');

  // Сортировка по ключу — обязательна. Telegram строит data_check_string
  // именно так. Любая другая сортировка → mismatch.
  const checkString = filtered
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  // timing-safe сравнение защищает от тайминг-атак (длины должны совпасть).
  let ok = false;
  try {
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(computed, 'hex');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    // Buffer.from('зэз', 'hex') кидать не должна, но защитимся.
    ok = false;
  }
  if (!ok) {
    // ── Диагностика ──────────────────────────────────────────────
    // Логируем подробно, потому что HMAC mismatch может быть от
    // десятка причин (битый токен, новое поле от TG, неправильный
    // парсинг, TLS-инспектор по дороге, и т.д.) — а иначе как искать.
    //
    // Что показываем:
    //   • fields/rawLen/dcsLen — структурные характеристики
    //   • valueLens — длина каждого поля. Если у `user` 0 байт —
    //     понятно что initData кривой
    //   • tokenLen + tokenChk — длина токена и контрольная сумма
    //     (HMAC от константной строки). Если tokenChk у двух деплоев
    //     одинаковый — env идентичен; если разный — кто-то поменял
    //     токен. tokenChk не раскрывает сам токен (HMAC однонаправлен).
    //   • expectStart/gotStart — первые 8 hex (32 бита) hash'ей. Этого
    //     достаточно чтобы понять "вообще похожи или совсем разные";
    //     32 бит энтропии слишком мало для атаки (а тут даже не та
    //     модель угроз — атакующему нужен ВЕСЬ valid hash для подмены)
    //
    // Не логируем: сам token, сами values, полный hash.
    const tokenChk = crypto
      .createHmac('sha256', 'tma-debug')
      .update(botToken)
      .digest('hex')
      .slice(0, 12);
    const valueLens = filtered
      .map(([k, v]) => `${k}:${v.length}`)
      .sort()
      .join(',');
    // eslint-disable-next-line no-console
    console.warn(
      `[tma:auth] HMAC mismatch. ` +
        `fields=[${filtered.map(([k]) => k).sort().join(',')}], ` +
        `rawLen=${initDataRaw.length}, ` +
        `dcsLen=${checkString.length}, ` +
        `valueLens=[${valueLens}], ` +
        `tokenLen=${botToken.length}, ` +
        `tokenChk=${tokenChk}, ` +
        `expectStart=${hash.slice(0, 8)}, ` +
        `gotStart=${computed.slice(0, 8)}`,
    );

    // ── Глубокая диагностика по флагу TMA_DEBUG=1 ─────────────────
    // Включается только когда админ явно ставит TMA_DEBUG=1 в .env
    // и рестартует бота. Не для постоянного использования — раскрывает
    // данные initData (которые содержат PII юзера: имя, username) и
    // полный hash, подписанный Telegram'ом.
    //
    // Безопасность:
    //   • initData приватен в течение 24ч, потом auth_date протухает
    //     и его нельзя использовать ни нашим, ни чужим бэкендом
    //   • bot token из логов не утечёт — мы его никогда не печатаем
    //   • diagnostic нужен чтобы воспроизвести проблему локально:
    //     зная dcs_hex и expected hash, мы можем перебирать варианты
    //     парсинга/нормализации и искать тот, который даёт совпадение
    //
    // Что логируем (только при TMA_DEBUG=1):
    //   • initData_raw — точная строка из Authorization-заголовка
    //   • dcs_hex — байты data_check_string в hex (показывает невидимые
    //     символы вроде BOM, NULL, \r — которые могли проникнуть и
    //     сломать HMAC)
    //   • expected_full / computed_full — полные hex'и для прямого
    //     сравнения и реверс-инжиниринга
    if (process.env.TMA_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.warn(
        `[tma:auth:DEBUG] initData_raw=${initDataRaw}\n` +
          `[tma:auth:DEBUG] dcs_hex=${Buffer.from(checkString, 'utf8').toString('hex')}\n` +
          `[tma:auth:DEBUG] expected_full=${hash}\n` +
          `[tma:auth:DEBUG] computed_full=${computed}`,
      );
    }
    throw new InitDataInvalid('bad hash');
  }

  // Свежесть auth_date. Telegram гарантирует, что значение секундное (Unix).
  // Берём из filtered (мы туда же сложили все пары кроме hash/signature).
  const authDateStr = filtered.find(([k]) => k === 'auth_date')?.[1];
  if (!authDateStr) throw new InitDataInvalid('no auth_date');
  const authDate = parseInt(authDateStr, 10);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new InitDataInvalid('bad auth_date');
  }
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > MAX_AUTH_AGE_SECONDS) throw new InitDataInvalid('expired');
  if (ageSec < -FUTURE_TOLERANCE_SECONDS) throw new InitDataInvalid('future');

  // user — JSON-encoded строка. Telegram её всегда шлёт, кроме редкого случая
  // когда мини-апп открыт через inline-кнопку без user-привязки. Для нашего
  // флоу (кнопка в боте) user всегда есть; иначе — не пускаем.
  const userRaw = filtered.find(([k]) => k === 'user')?.[1];
  if (!userRaw) throw new InitDataInvalid('no user');

  let parsed: unknown;
  try {
    parsed = JSON.parse(userRaw);
  } catch {
    throw new InitDataInvalid('bad user json');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new InitDataInvalid('bad user');
  }

  // Аккуратная нормализация — всё, что не той формы, → null/false. Это
  // защита от того, что Telegram однажды добавит новые поля или поменяет
  // тип (например, premium как строку 'true' в каком-то клиенте).
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== 'number' || !Number.isFinite(obj.id)) {
    throw new InitDataInvalid('bad user.id');
  }

  return {
    id: BigInt(obj.id),
    firstName: typeof obj.first_name === 'string' ? obj.first_name : null,
    lastName: typeof obj.last_name === 'string' ? obj.last_name : null,
    username: typeof obj.username === 'string' ? obj.username : null,
    languageCode: typeof obj.language_code === 'string' ? obj.language_code : null,
    isPremium: obj.is_premium === true,
    allowsWriteToPm: obj.allows_write_to_pm === true,
  };
}
