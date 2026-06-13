# setpow VPN — проектный контекст и решения

Документ-референс для всего что было решено по проекту: бизнес-модель,
архитектура, технологический стек, развёртывание, известные проблемы и
решения. Создан как «золотой лог» чтобы любой новый сеанс работы мог
быстро войти в контекст без чтения переписки.

Дата создания: 2026-05-21.
Последнее обновление: 2026-05-22 (после сессии: PR #5–#13).

---

## 1. Что строим

**Telegram-бот, который продаёт VPN автоматически.**

Юзер делает `/start`, получает триал, выбирает тариф, оплачивает,
получает универсальную подписку — она открывается в любом sing-box
клиенте (Karing, Happ, Hiddify) и работает.

Архитектурно — два независимых репозитория:

- **`baribalhvh-cloud/naivepanel`** — VPN-сервер (NaiveProxy, Hysteria2,
  Reality на одной VPS) + админ-панель. Уже существовал, в этом проекте
  получил новый internal-API для машинного доступа.
- **`baribalhvh-cloud/setpow-bot`** — Telegram-бот, отдельный сервис.
  Бот ходит к панели через REST по `X-API-Key`. Хранит свою БД
  (юзеры, подписки, платежи, промокоды). Раздаёт юзерам универсальные
  подписки.

```
[Telegram client]
        ↕
[setpow-bot (TS + grammY + Express + Prisma)]
        ↕  HTTP + X-API-Key
[naivepanel (Express, /api/internal/*)]
        ↓
   /etc/hysteria/config.yaml   (Hy2)
   /etc/xray/config.json       (Reality)
```

---

## 2. Бизнес-модель

### Тарифы

Скидка растёт с длительностью — стимулируем длинные планы.

| План | Дни | Цена в RUB | Цена в Stars (XTR) | Цена в USD-центах | Скидка |
|------|----:|-----------:|-------------------:|------------------:|-------:|
| Триал | 3   | 0          | 0                  | 0                 | —      |
| 1 мес | 30  | 200        | 130                | 220               | —      |
| 3 мес | 90  | 500        | 320                | 549               | −17%   |
| 6 мес | 180 | 900        | 580                | 999               | −25%   |
| 12 мес| 365 | 1600       | 1030               | 1799              | −33%   |

Цены — в `src/plans.ts`. RUB хранится в **копейках** (целое), Stars — в
целых звёздах, USD — в центах. Никаких float.

Курс Stars: 1 ⭐ ≈ 1.5 ₽ (актуально на 2025-Q4, перепроверить перед
запуском платных тарифов).

### Триал

3 дня бесплатно при первом `/start`. Флаг `User.trialUsed=true` ставится
**только если хотя бы одна подписка реально создалась** на панели —
иначе юзер сможет повторить /start когда серверы вернутся (защита от
кейса «панель временно лежала в момент регистрации»).

Управляется ENV-переменной `TRIAL_DAYS` (по умолчанию 3, 0 = выключить).

После /start с триалом юзеру приходит **отдельное подробное уведомление**
(не сваленное в приветствие): «🎁 Тебе выдан пробный доступ. Срок: 3 дня.
Действует до: DD.MM.YYYY HH:MM (МСК).» — добавлено в PR #5.

### Реферальная программа

- Каждому юзеру выдаётся `User.refCode` (8 url-safe символов) при
  регистрации.
- Реф-ссылка: `https://t.me/<bot_username>?start=ref_<refCode>`.
- При `/start ref_<code>` от нового юзера — фиксируем `referredById`,
  и **рефереру сразу падает уведомление**: «🎉 По твоей ссылке
  зарегистрировался новый пользователь. Когда он впервые оплатит
  подписку, ты получишь +N дней.» (PR #5).
- **Бонус выдаётся рефереру** (не приглашённому!) когда приглашённый
  делает **первую ПЛАТНУЮ** покупку. Триал-платёж не считается.
- Размер бонуса: `REFERRAL_BONUS_DAYS=7` (по умолчанию). Реферер получает
  +7 дней ко всем активным подпискам + уведомление с датой окончания.
- Защита от абуза:
  - Нельзя пригласить самого себя (проверка `referrer.tgId !== self.tgId`).
  - Нельзя получить бонус за триал (фильтр `provider != 'trial'`).
  - `Payment.referrerBonusGranted=true` после выдачи — повторно не
    начисляется.

### Промокоды (PR #11)

Маркетинговый/онбординговый инструмент. Админ создаёт код, юзер
активирует — получает N бесплатных дней.

- Команды админа:
  - `/promo_create CODE DAYS [maxUses=N] [expires=YYYY-MM-DD]`
  - `/promo_list` — топ-30 активных
  - `/promo_del CODE` — soft-delete (не уничтожает историю редемпций)
- Юзер: главное меню → «🎟 Промокод» → ввести код одной строкой → +N дней.
- Защита: `@@unique([userId, promoCodeId])` на DB-уровне — один юзер
  не активирует один и тот же промокод дважды даже на гонке.
- Каждая активация создаёт `Payment{provider:'promo', amount:0}` —
  для аудита в `/admin`.
- Регистр кода нечувствителен (`.trim().toUpperCase()` на входе).

### Лимит устройств

Юзер сказал "3 устройства на ключ". Сейчас **не enforce'им** — это TODO.
Hy2/Reality по протоколу не ограничивают одновременные коннекшны (одна
пара логин/пароль = одно "место" в auth-таблице), а sing-box подписку
можно скопировать на сколько угодно устройств. Жёсткий лимит надо делать
на стороне сервера (xray connection limit для Reality, кастомный
auth-плагин для Hy2).

### Поддержка

Юзер сказал "пока пропустим". В коде нет тикет-системы. Если что —
кнопка "Помощь" просто показывает FAQ как подключить.

---

## 3. Технологический стек

### Бот

| Компонент | Выбор | Почему |
|-----------|-------|--------|
| Язык | TypeScript | Тот же стек что в панели (Node), строгая типизация |
| Runtime | Node 20+ | Современный fetch встроенный, BigInt OK |
| Bot framework | [grammY](https://grammy.dev/) | Современнее Telegraf, лучше TS-типы, активный мейнтейнер |
| HTTP | Express 4 | Простой webhook-приёмник + админка + /sub агрегатор |
| ORM | Prisma 5 | Schema-first, типобезопасная генерация клиента |
| БД | SQLite (старт) → Postgres (рост) | Один файл `prisma/bot.db` — нулевая операционная нагрузка |
| Cron | node-cron | 1) Раз в час: уведомления + revoke. 2) В 04:00 UTC: бэкап БД |
| Validation | zod | Валидация .env при старте |
| Rate limit | Самописный sliding-window per-user | 5 апдейтов / 5 сек, админы без лимита (PR #9) |
| Logger | console (через pino опционально) | Минимум зависимостей |

### Платёжки

| Провайдер | Статус в коде | Комментарий |
|-----------|---------------|-------------|
| Telegram Stars (XTR) | ✅ работает end-to-end | `bot.api.sendInvoice` нативный, без внешнего provider_token |
| **CryptoBot (Crypto Pay API)** | ✅ работает end-to-end (PR #7) | TG-нативный, USDT/TON/BTC/ETH, цена в RUB с авто-конверсией. HMAC-SHA256 подпись webhook'а проверяется. |
| YooKassa (RUB) | ⚠️ заглушка / **намеренно не интегрируем** | См. подраздел «Юр-аспекты» в разделе 16 |
| OxaPay (USDT/TON) | ⚠️ заглушка | Не приоритет — CryptoBot покрывает крипто-кейс лучше для TG-аудитории |

В UI кнопки появляются только если в `.env` указаны соответствующие
ключи. Логика — `paymentsAvailable` в `src/config.ts`.

### Анти-краш и отказоустойчивость (PR #6)

Без этого бот падал на пустом месте: TG возвращает 400 «message is not
modified» при двойном тапе по той же inline-кнопке (UX вариант который
случается у каждого второго юзера), grammY без error-handler'а
print'ит «No error handler was set! Stopping bot» и кладёт процесс.
PM2 рестартует, юзер видит «бот лежит», в проде наблюдали 5 рестартов
за день.

Что добавлено:
- `bot.catch(...)` — глобальный handler grammY:
  - **Тихо игнорирует** «message is not modified», «query is too old»,
    «bot was blocked», «user is deactivated», «chat not found».
  - **Логирует, но не падает** на любых других GrammyError / HttpError.
- `process.on('unhandledRejection')` и `process.on('uncaughtException')`
  с логом, но БЕЗ `process.exit` — для ошибок в Express-роутах, cron'ах,
  prisma-блокировках.

### Панель

Не меняли стек. Уже было: Node + Express + WebSocket. Добавили только
один файл `panel/server/internal.js` (Router) и 32 строки в `index.js`
для регистрации роутера и генерации API-ключа.

---

## 4. БД-схема (Prisma → SQLite)

Файл `prisma/schema.prisma`. Денежные суммы — целые в минимальных
единицах (копейки/центы/звёзды).

### `User`
| Поле | Тип | Назначение |
|------|-----|------------|
| `id` | Int autoincrement | PK |
| `tgId` | BigInt unique | Telegram user.id (могут быть >2^31) |
| `username`, `firstName` | String? | Из Telegram, для отображения в админке |
| `refCode` | String unique | 8 url-safe — для `?start=ref_xxx` |
| `referredById` | Int? | FK на User, кто пригласил |
| `trialUsed` | Boolean default false | Защита от повторного триала |
| **`replyKbInstalled`** | Boolean default false | Был ли отправлен раз «👇 Меню снизу» (PR #9) |
| `banned` | Boolean default false | Бан → revoke + игнор |
| `subAggregatorToken` | String unique | 24 url-safe (~144 бита) — стабильный токен в URL подписки |
| `createdAt` | DateTime | |

Связи: `subscriptions`, `payments`, **`promoRedemptions`** (PR #11).

### `Server`
Мульти-серверная архитектура с самого начала. На старте 1 запись.
| Поле | Тип | Назначение |
|------|-----|------------|
| `id` | Int autoincrement | |
| `displayName` | String | "🇫🇮 Финляндия" — показываем юзеру |
| `panelUrl` | String | https://panel.example.com или http://127.0.0.1:3000 |
| `apiKey` | String | X-API-Key для этой панели |
| `active` | Boolean | Скрыть сервер от выдачи новых, оставив старых юзеров |
| `protocols` | String CSV | "hy2,reality" — какие выпускаем |
| `infoCache` | String? | JSON-кэш `panel.serverInfo()` (5 мин TTL) |

### `Subscription`
Один TG-юзер может иметь несколько Subscription = (server, kind).
| Поле | Тип | Назначение |
|------|-----|------------|
| `userId`, `serverId` | FK | |
| `kind` | String | "hy2" \| "reality" |
| `panelUserKey` | String | username (hy2) или name (reality) на стороне панели |
| `password` | String? | Hy2 only |
| `uuid` | String? | Reality only |
| `panelSubToken` | String | subToken на стороне панели (для отладки, не используется боту) |
| `expiresAt` | DateTime | Когда истекает |
| `status` | String | active \| trial \| expired \| revoked |
| `isTrial` | Boolean | Маркер триал-подписки |

### `Payment`
| Поле | Тип | Назначение |
|------|-----|------------|
| `userId` | FK | |
| `provider` | String | "tg_stars" \| "yookassa" \| "oxapay" \| **"cryptobot"** \| **"promo"** \| "trial" \| "manual" |
| `externalId` | String? | ID транзакции в платёжке (Stars: `telegram_payment_charge_id`, CryptoBot: `invoice_id`, promo: `promo:CODE`) |
| `amount` | Int | копейки/звёзды/центы |
| `currency` | String | "RUB" \| "XTR" \| "USDT" \| "TON" |
| `planDays` | Int | Сколько дней даёт этот платёж |
| `status` | String | pending \| paid \| failed \| expired |
| `referrerBonusGranted` | Boolean | Чтобы реф-бонус не выплатился дважды |
| `paidAt` | DateTime? | Когда подтверждена оплата |

Уникальность `(provider, externalId)` защищает от двойной обработки
одного и того же webhook'а.

### `PromoCode` (PR #11)
| Поле | Тип | Назначение |
|------|-----|------------|
| `id` | Int autoincrement | |
| `code` | String unique | UPPER-CASE; на входе нормализуется |
| `freeDays` | Int | Сколько дней начисляется при активации |
| `maxUses` | Int? | NULL = unlimited |
| `uses` | Int default 0 | Счётчик активаций |
| `expiresAt` | DateTime? | NULL = бессрочно |
| `active` | Boolean default true | Soft-delete: ставится false через /promo_del |
| `createdAt` | DateTime | |

### `PromoCodeRedemption` (PR #11)
| Поле | Тип | Назначение |
|------|-----|------------|
| `userId`, `promoCodeId` | FK | |
| `redeemedAt` | DateTime | |
| `daysGranted` | Int | Дублирует freeDays на момент активации (история) |

`@@unique([userId, promoCodeId])` — DB-level гарантия что один юзер не
активирует один промокод дважды (даже на гонке между двумя
одновременными сообщениями).

---

## 5. Структура репозитория `setpow-bot`

```
setpow-bot/
├── README.md
├── package.json
├── tsconfig.json
├── .env.example                  ← шаблон конфига
├── .gitignore                    ← /backups, prisma/*.db и пр.
├── prisma/
│   └── schema.prisma             ← User · Server · Subscription · Payment · PromoCode · PromoCodeRedemption
├── backups/                      ← локальные .db.gz, последние 7 дней (PR #13, в .gitignore)
├── src/
│   ├── index.ts                  ← bootstrap (web + cron + bot) + process.on handlers
│   ├── config.ts                 ← env + zod + paymentsAvailable
│   ├── db.ts                     ← Prisma client singleton
│   ├── plans.ts                  ← тарифы и формулы скидок
│   ├── panel.ts                  ← HTTP-клиент к /api/internal/*
│   ├── subscription.ts           ← grant / extend / revoke + sing-box builder
│   ├── payments.ts               ← Stars + CryptoBot ✅, YooKassa/OxaPay ⚠️
│   ├── bot.ts                    ← grammY: handlers, /admin команды, bot.catch
│   ├── notify.ts                 ← пользовательские уведомления (триал/ban/payment/...) (PR #5)
│   ├── promo.ts                  ← redeemPromoCode логика (PR #11)
│   ├── rateLimit.ts              ← sliding-window middleware (PR #9)
│   ├── backup.ts                 ← VACUUM INTO + gzip + cleanup (PR #13)
│   ├── web.ts                    ← express: /sub, /webhook/*, /admin
│   └── jobs.ts                   ← cron: notifyExpiring (раз в час) + dailyBackup (04:00 UTC)
└── docs/
    └── CONTEXT.md                ← этот документ
```

Минимум абстракций, без папок-обёрток на каждый файл — код помещается в
голову целиком. После сессии 2026-05-22 файлов чуть больше, но
организация по-прежнему плоская.

---

## 6. Internal API панели — контракт между ботом и панелью

(Без изменений с прошлой версии документа.)

Авторизация: HTTP-заголовок `X-API-Key: <PANEL_API_KEY>`. Всё что без
ключа — 401. Если ключ на сервере не задан — 503.

### Где живёт ключ

В панели приоритет такой:
1. `process.env.PANEL_API_KEY` (если задан в systemd-юните)
2. файл `panel/data/.panel_api_key` (mode 0600)
3. если ничего нет — генерится случайный (32 байта hex)

**Важно**: при `rm -rf /opt/panel-naive-hy2 && bash install.sh` ключ
**меняется**. Чтобы зафиксировать — пропиши в systemd-юнит:
```
sudo systemctl edit panel-naive-hy2
# [Service]
# Environment=PANEL_API_KEY=<твой_ключ>
```

### Endpoints

`POST /api/internal/users` — создать юзера на панели.
`GET /api/internal/server-info` — глобальные параметры сервера.
`POST /api/internal/users/:kind/:name/extend` — продлить.
`DELETE /api/internal/users/:kind/:name` — удалить (для бана).
`GET /api/internal/users/:kind/:name` — статус.

Реализация — `panel/server/internal.js`.

---

## 7. Универсальный агрегатор подписок

Юзеру **одна** ссылка `https://pop.idkselfhost.ru:8443/sub/<token>?format=singbox`,
которая работает на всех его серверах одновременно.

(Без изменений с прошлой версии — реализация `buildSingboxConfig(userId)`
в `src/subscription.ts`.)

---

## 8. Развёртывание

(Базовая инструкция без изменений; ниже — что добавилось после сессии.)

VPS: 1 шт. Ubuntu 24.04, IP `94.177.145.15`. На ней живут одновременно:
- **Панель `naivepanel`** в `/opt/panel-naive-hy2`
- **Бот `setpow-bot`** в `/opt/setpow-bot`
- **Hy2** на UDP/443
- **Reality (xray)** на TCP/443
- **Caddy** на 8443/tcp (для бота)

Домены:
- `vpn1.idkselfhost.ru` → IP — для Hy2 ACME, для пользовательских
  ссылок vless/hy2.
- `pop.idkselfhost.ru` → IP — для подписок и админки бота.

### КРИТИЧЕСКИЙ нюанс: Reality и Caddy не делят 443/tcp

Reality «крадёт» TLS-handshake целиком. xray принимает только запросы с
SNI = `realitySettings.sni`, всё остальное отбрасывает.

**Поэтому**:
- В режиме «Hy2 + Reality» Caddy **не устанавливается** установщиком
  панели.
- TCP/443 — у xray. UDP/443 — у Hy2.
- Для бота нужен **отдельный порт** — у нас 8443 + Caddy → 127.0.0.1:8080.

### Раскат обновлений после сессии 2026-05-22

После всех PR (#5–#13):

```bash
cd /opt/setpow-bot
git checkout main && git pull
npx prisma generate
npx prisma db push     # PR #9 добавил replyKbInstalled, PR #11 — PromoCode + PromoCodeRedemption
npm run build
pm2 reload setpow-bot
pm2 logs setpow-bot --lines 30 --nostream
```

Никаких новых обязательных env-переменных. Опционально для CryptoBot:
```env
CRYPTOPAY_API_TOKEN=12345:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CRYPTOPAY_TESTNET=false
```
Webhook URL для CryptoBot: `https://pop.idkselfhost.ru:8443/webhook/cryptobot`
(настраивается в @CryptoBot → My Apps → Webhooks).

### Минимальный `.env`

```env
DATABASE_URL="file:./prisma/bot.db"

BOT_TOKEN=<от @BotFather>
ADMIN_IDS=<твой telegram id>

PUBLIC_URL=https://pop.idkselfhost.ru:8443
HTTP_PORT=8080

PANEL_URL=http://127.0.0.1:3000
PANEL_API_KEY=<cat /opt/panel-naive-hy2/panel/data/.panel_api_key>

# Stars — без токена, нативный
TG_STARS_ENABLED=true

# CryptoBot — опционально
CRYPTOPAY_API_TOKEN=
CRYPTOPAY_TESTNET=false

# YooKassa / OxaPay — пусто, не интегрируем (см. п.16)
YOOKASSA_SHOP_ID=
YOOKASSA_SECRET_KEY=
OXAPAY_MERCHANT_KEY=

REFERRAL_BONUS_DAYS=7
TRIAL_DAYS=3

ADMIN_WEB_USER=admin
ADMIN_WEB_PASSWORD=<минимум 8 символов>

LOG_LEVEL=info
NODE_ENV=production
```

---

## 9. Известные проблемы и их решения

### Проблема 1: `xray x25519` не парсится

(Описано в прошлой версии. Зафикшено в PR #9 naivepanel и commit 03964f4.)

### Проблема 2: `/etc/caddy/` не существует

(By design. Бот ставит свой Caddy на 8443.)

### Проблема 3: бот не слушает 8080 в `ss`

(Foreground в SSH. Решение — `pm2 start dist/index.js --name setpow-bot`.)

### Проблема 4: ZodError "Invalid url" на PUBLIC_URL

(Должна быть схема `https://...`.)

### Проблема 5: PANEL_API_KEY меняется после переустановки панели

(Зафиксировать в systemd Environment.)

### Проблема 6: бот падает на «message is not modified» (PR #6)

**Симптом** (наблюдали в проде, 5 рестартов за день):
```
GrammyError: editMessageText failed! 400 Bad Request:
  message is not modified: specified new message content and reply
  markup are exactly the same as a current content and reply markup.
No error handler was set!
Stopping bot
```

**Триггер**: юзер дважды тапает одну и ту же inline-кнопку. Например,
открыл «🔑 Мои ключи», нажал «« Назад», ещё раз нажал «🔑 Мои ключи» —
бот пытается `editMessageText` с тем же контентом, TG возвращает 400.

**Причина**: grammY без `bot.catch(...)` считает любую API-ошибку
фатальной → `process.exit` → PM2 рестартует. Юзер видит «бот лежит».

**Решение**: `bot.catch` (PR #6) — тихо проглатывает «message is not
modified», «query is too old», «bot was blocked», «user is deactivated»,
«chat not found». Все остальные ошибки логируются, но процесс
продолжает работать. Плюс `process.on('unhandledRejection')` и
`uncaughtException` без `exit` — для ошибок вне grammY (Express, cron,
prisma).

### Проблема 7: при возврате в главное меню исчезало приветствие (PR #8)

**Симптом**: после `/start` юзер видел «Привет, X! Это setpow — VPN…
Выбирай:» с inline-меню. Жмёт на любую кнопку → жмёт «« Назад» → текст
становится просто «Главное меню:». Приветствие и описание пропадали.

**Причина**: callback `menu:home` редактировал сообщение жёстко прибитым
текстом «Главное меню:».

**Решение**: вынес `mainMenuText(firstName?, extra?)` в отдельную
функцию, использую её и в `/start`, и в `menu:home`. Теперь возврат
выглядит идентично исходному /start (без триал-инфы при последующих
возвратах — это правильно).

### Проблема 8: спам кнопкой «🏠 Меню» (потенциальный, PR #9)

**Контекст**: после добавления persistent ReplyKeyboard любой юзер
может зажать кнопку и долбить её. Без защиты:
1. Каждый тап = `findOrCreateUser` → SELECT по БД.
2. Превышение 30 msg/sec у TG Bot API → flood wait → бот не отвечает
   ВСЕМ юзерам.
3. Чат юзера завалится 50+ сообщениями главного меню.

**Решение**: rate-limiter middleware в `src/rateLimit.ts`. Sliding window
per-user, **5 апдейтов / 5 секунд**. При превышении — для callback
queries отвечаем «⏳ Подожди секунду» (чтобы «часики» исчезли), для
текстовых — молча игнорим (повторное «подожди» само станет спамом).
Админы (`env.ADMIN_IDS`) обходят лимит — `/backfill 200 юзеров` или
серия `/give` не должны блокироваться.

Map чистится setInterval'ом раз в 5 минут чтобы не расти бесконечно.
`cleanup.unref()` чтобы не блокировать graceful shutdown.

---

## 10. Безопасность

### Что защищено

- **`/sub/<token>`**: 24 url-safe = ~144 бита энтропии. Брутфорс
  невозможен.
- **`/admin`**: HTTP Basic-Auth, пароль из `ADMIN_WEB_PASSWORD`.
- **PANEL_API_KEY**: 32 байта hex, файл mode 0600, не возвращается
  ни одним endpoint'ом.
- **Reality privateKey**: хранится в `cfg.realitySettings.privateKey`
  и никогда не отдаётся через API.
- **CryptoBot webhook (PR #7)**: HMAC-SHA256, секрет = SHA-256(API_TOKEN),
  по сырому body. `crypto.timingSafeEqual` для сравнения подписи —
  защита от тайминг-атак. При невалидной подписи — 401, апдейт не
  обрабатывается.
- **Rate-limiter (PR #9)**: 5 апдейтов / 5 сек на юзера. Не даст
  одному злоумышленнику завалить TG Bot API rate-limit и сломать
  доступ для остальных.

### Что **НЕ** защищено (TODO до запуска платных провайдеров)

- **YooKassa/OxaPay webhook'и без HMAC**: оба endpoint'а пока заглушки.
  Если когда-нибудь будем подключать — добавить HMAC + IP-allowlist
  обязательно. (Для CryptoBot уже сделано.)
- **Brute-force `/admin`**: нет rate-limit на Express-уровне. С
  сильным паролем (16+ символов) практически нереально, но fail2ban
  или Caddy `rate_limit` — дёшевая страховка.

### Поддомен утечёт в Certificate Transparency Logs

Имя `pop.idkselfhost.ru` попадает в публичную базу
[crt.sh](https://crt.sh/) при выдаче LE-сертификата. Это палит факт
существования поддомена, но не его назначение. Выбран нейтральный
префикс `pop.`.

---

## 11. Текущий статус (на 2026-05-22)

### ✅ Работает end-to-end

#### VPN-инфраструктура (без изменений с предыдущей версии)
- Установщик панели в режиме Hy2 + Reality (после фикса x25519).
- Internal API панели + персистентный API-ключ.
- Универсальный агрегатор `/sub/<token>?format=singbox`.

#### Бот: пользовательский флоу
- `/start` → создание юзера → триал → подписка → импорт в Karing → VPN.
- Главное меню (5 кнопок, 3 ряда): 🔑 Мои ключи / 💳 Купить / 🎁 Реферальная
  / 🎟 Промокод / ℹ️ Как подключить.
- **Persistent кнопка «🏠 Меню»** снизу экрана (PR #9). Устанавливается
  один раз на жизнь юзера через флаг `replyKbInstalled`. Жмёшь — попадаешь
  в главное меню без `/start`.
- **Кнопка «🔄 Продлить»** на странице «🔑 Мои ключи» — если есть
  активные подписки, ведёт на тот же флоу что «💳 Купить» (PR #10).
- **«🎟 Промокод»** — ввод кода → если валиден, +N дней (PR #11).

#### Бот: оплата
- **Telegram Stars** — нативно, end-to-end.
- **CryptoBot (Crypto Pay)** — end-to-end (PR #7). Crypto Pay API,
  цена в RUB с авто-конверсией в USDT/TON/BTC/ETH. HMAC-проверка
  webhook'а. Нужно настроить в @CryptoBot → My Apps → Webhooks
  → URL: `<PUBLIC_URL>/webhook/cryptobot`.
- Реферальная программа — с уведомлениями реферера (PR #5).

#### Бот: уведомления юзеру (PR #5)
Все через единый модуль `src/notify.ts` с pluralize ('1 день / 2 дня /
5 дней') и форматом даты «DD.MM.YYYY HH:MM (МСК)»:
- Триал выдан (с датой окончания)
- Реферал зарегистрировался (рефереру)
- Платёж получен (с тарифом, сроком, датой)
- Реф-бонус начислен (с датой)
- Подписка истекает через 3 дня / 1 день
- Подписка только что истекла
- Админ выдал N дней (`/give`)
- Аккаунт забанен / разбанен

#### Бот: админ
- `/admin` — статистика (юзеры, активные подписки, выручка).
- `/give <tg_id> <days>` — выдать дни вручную (cap 1..3650 от
  Date-overflow). Юзер получает уведомление.
- `/ban <tg_id>` / `/unban <tg_id>` — оба с уведомлением юзеру.
- `/backfill [tg_id]` — достроить недостающие подписки (если в момент
  создания была сетевая ошибка с панелью).
- `/promo_create CODE DAYS [maxUses=N] [expires=YYYY-MM-DD]` (PR #11).
- `/promo_list` — топ-30 активных (PR #11).
- `/promo_del CODE` — soft-delete (PR #11).
- `/broadcast` (PR #12) — двухшаговый флоу: команда → ввод текста →
  preview с кол-вом получателей → 2 кнопки (Отправить / Отмена).
  Рассылает с throttle ~20 msg/sec, в конце шлёт админу отчёт.
- `/cancel` — снимает любой ожидающий state (промо, broadcast).
- `/backup` (PR #13) — мгновенный VACUUM INTO + gzip → файл в чат
  админа.

#### Веб-админка
- `https://pop.idkselfhost.ru:8443/admin` (Basic-Auth).
- Виджет с метриками + таблица активных подписок + таблица
  последних платежей.

#### Отказоустойчивость
- `bot.catch` ловит «message is not modified» и подобные benign-ошибки
  TG (PR #6).
- `process.on('unhandledRejection' / 'uncaughtException')` — без exit.
- Rate limiter 5/5sec per-user (PR #9).
- **Автобэкап БД** в 04:00 UTC (PR #13): `VACUUM INTO` → gzip → файл
  всем админам в личный чат с ботом. Локальная история 7 дней. На
  ошибку бэкапа — алерт первому админу.
- Идемпотентность платежей: `markPaid` ставит `status=paid` и игнорит
  повторы → дубль webhook'а не задвоит выдачу.

### ⚠️ Заглушки / TODO

- **YooKassa**: ⚠️ намеренно не интегрируем (см. п.16, юр-аспекты).
- **OxaPay**: заглушка. Не приоритет — CryptoBot покрывает крипто-кейс.
- **Лимит 3 устройства**: не enforce'ится.
- **i18n**: только русский.
- **Тикет-система**: пропущена.
- **Clash/v2ray** форматы: только sing-box.
- **Webhook-режим бота**: long polling. Webhook не нужен пока < 1000
  юзеров.

---

## 12. Дорожная карта

В порядке приоритета, после сессии 2026-05-22.

### Очередь 1 — повседневная страховка

- **Алерты админу о реальных ошибках** (B3 в обсуждении, ~30 минут).
  Сейчас `bot.catch` пишет в console.error. Если бот реально упадёт
  на чём-то неожиданном, админ узнает только из `pm2 logs`. Сделать:
  в `bot.catch` для критических ошибок (всё что не «benign» класс)
  слать первому админу `bot.api.sendMessage` со stack-trace. С
  rate-limit на эти сообщения (1 раз в N минут на одинаковую ошибку),
  иначе при шторме упадём в TG flood.
- **Cleanup старых pending-платежей** (~15 минут). Сейчас в БД
  накапливаются `Payment{status:'pending'}` от инвойсов которые юзер
  не оплатил. Безвредно, но через год их будет десятки тысяч. Cron
  раз в день: `WHERE status='pending' AND createdAt < NOW() - 24h`
  → ставим `status='expired'`.

### Очередь 2 — рост аудитории

- **Второй сервер** (например, Германия/Нидерланды). Архитектурно
  готово — добавить запись в `Server` через `/admin`. Юзеры
  автоматом начнут получать ключи на оба сервера через одну и ту
  же подписку.
- **Лимит устройств**: для Reality — connection-limit в xray на
  email клиента; для Hy2 — счётчик в БД либо кастомный auth-плагин.
  ~3 часа.
- **Webhook-режим бота** (когда юзеров > 1000). Уже есть Caddy на
  8443 — подключить `bot.api.setWebhook` + `webhookCallback(bot, 'express')`.
  ~1 час.

### Очередь 3 — UX / маркетинг

- **i18n EN/RU**. grammY-i18n с yaml. Все строки уже сосредоточены в
  `notify.ts` и `bot.ts`. ~2 часа.
- **QR-код подписки** в чате — некоторые юзеры любят отсканить.
- **Тикет-система** или просто пересылка к `@setpow_support`.
- **Stats** в `/admin`: график продаж (Chart.js).

### Очередь 4 — масштаб

- **Postgres** вместо SQLite (Prisma `migrate deploy` после смены
  provider).
- **Серьёзная админка**: AdminJS вместо самописного HTML. Если
  будет несколько админов — роли + аудит-лог.
- **Promo-коды со скидкой на покупку** (текущая реализация — только
  freeDays). Добавить поле `discountPercent`, применять на этапе
  выбора тарифа.

### Намеренно НЕ делаем (юридический риск)

- **YooKassa**: см. подраздел 16. До юр-консультации не подключаем.

---

## 13. Полезные команды

### Управление ботом

```bash
pm2 status
pm2 logs setpow-bot --lines 50
pm2 restart setpow-bot
pm2 stop setpow-bot
pm2 save
pm2 flush setpow-bot         # очистить логи
```

### Управление панелью

```bash
pm2 logs panel-naive-hy2 --lines 50
systemctl status caddy
systemctl status hysteria-server
systemctl status xray
journalctl -u xray -n 50 --no-pager
```

### Получить API-ключ панели

```bash
cat /opt/panel-naive-hy2/panel/data/.panel_api_key
```

### Проверить связь бот ↔ панель

```bash
curl -s http://127.0.0.1:3000/api/internal/server-info \
  -H "X-API-Key: $(cat /opt/panel-naive-hy2/panel/data/.panel_api_key)" \
  | jq
```

### Веб-админка

`https://pop.idkselfhost.ru:8443/admin` — логин/пароль из `.env`.

### Команды в Telegram (только для ADMIN_IDS)

| Команда | Что делает |
|---|---|
| `/admin` | Статистика |
| `/give <tg_id> <days>` | Выдать дни вручную (1..3650) |
| `/ban <tg_id>` | Забанить + revoke + уведомление |
| `/unban <tg_id>` | Разбанить + уведомление |
| `/backfill [tg_id]` | Достроить недостающие подписки |
| `/promo_create CODE DAYS [maxUses=N] [expires=YYYY-MM-DD]` | Создать промокод |
| `/promo_list` | Топ-30 активных промокодов |
| `/promo_del CODE` | Soft-delete промокода |
| `/broadcast` | Двухшаговая рассылка всем юзерам |
| `/cancel` | Отменить ожидание (промо/broadcast) |
| `/backup` | Мгновенный бэкап БД в чат |

### Backup БД бота

**Автоматически** (PR #13): cron в 04:00 UTC шлёт `.db.gz` всем админам.
Локальная копия в `/opt/setpow-bot/backups/`, последние 7 дней.

**Вручную**: `/backup` в чате с ботом.

**Восстановление**:
```bash
pm2 stop setpow-bot
gunzip -k setpow-2026-05-22T04-00-00.db.gz
mv setpow-2026-05-22T04-00-00.db /opt/setpow-bot/prisma/bot.db
pm2 start setpow-bot
pm2 logs setpow-bot --lines 30
```

### Restart всего стека

```bash
systemctl restart caddy
systemctl restart hysteria-server
systemctl restart xray
pm2 restart panel-naive-hy2
pm2 restart setpow-bot
```

---

## 14. Журнал сессий

### Сессия 2026-05-22 — фичи и стабилизация

13 мерджей в `main`, всё через workflow «ветка → PR → merge в main»
(solo-dev workflow без code-review).

| PR | Тема | Зачем |
|---:|---|---|
| #5 | User notifications | Юзер раньше при /give от админа не знал что ему накинули дни. При истечении — не знал что доступ остановлен. При оплате — видел только «✅ Оплата получена!» без деталей. Теперь все жизненные события покрыты подробными сообщениями с датами через единый `src/notify.ts`. |
| #6 | bot.catch + process handlers | Бот падал на «message is not modified» при двойном тапе по кнопке. PM2 рестартовал, юзер видел «бот лежит». 5 рестартов за день в проде. Теперь `bot.catch` глушит этот класс ошибок (плюс «query is too old», «bot was blocked»), процесс не падает. |
| #7 | CryptoBot интеграция | TG-нативная крипто-оплата (USDT/TON/BTC/ETH) с ценой в RUB и авто-конверсией. Без KYC, без юр-лица, нативный для TG-аудитории. HMAC-SHA256 проверка webhook'а по сырому body. |
| #8 | Fix: greeting in main menu | Маленький UX-баг: при возврате «« Назад» в главное меню текст становился «Главное меню:» вместо приветствия. Вынесена `mainMenuText()` функция, используется и в `/start`, и в callback `menu:home`. |
| #9 | Persistent «🏠 Меню» + rate limit | Постоянная кнопка снизу экрана — юзер может вернуться в меню одним тапом без `/start`. Добавлен флаг `User.replyKbInstalled` чтобы не спамить «👇 Меню снизу» при каждом /start. Параллельно — sliding-window rate limiter 5/5sec per-user (защита от спама зажатой кнопкой), админы без лимита. |
| #10 | Кнопка «🔄 Продлить» | На странице «🔑 Мои ключи» — кнопка ведёт на тот же флоу что «💳 Купить». `grantOrExtend` уже умеет продлевать существующую подписку, никаких изменений в payment-флоу. Чисто UX-сокращение: 3 тапа → 1. |
| #11 | Промокоды | Новые таблицы `PromoCode` + `PromoCodeRedemption` с `@@unique([userId, promoCodeId])` для DB-level race-guard. UPPER-CASE нормализация. Одноразово per-user. UI: кнопка «🎟 Промокод» в главном меню → ввод одной строкой. Админ: `/promo_create / list / del`. Каждая активация создаёт `Payment{provider:'promo'}` для аудита. |
| #12 | /broadcast | Двухшаговый флоу для рассылки: `/broadcast` → ввод текста → preview с числом получателей и 2 кнопками → отправка с throttle ~20 msg/sec в фоне. По окончанию — отчёт админу «X из Y, не доставлено Z». In-memory state с `/cancel` для отката. |
| #13 | Автобэкап БД | `VACUUM INTO` → gzip → cron в 04:00 UTC → `sendDocument` всем админам. Локальная папка `./backups/` — последние 7 дней с auto-cleanup. Команда `/backup` для админа — мгновенный бэкап. На ошибку бэкапа — fallback-алерт первому админу. |

### Что обсуждалось но НЕ делали

- **Юр-аспекты VPN в РФ** — см. подраздел 16. Резюме: до юр-консультации
  не интегрируем YooKassa, остаёмся на Stars + CryptoBot. Stars +
  крипта = минимальная видимость для российских регуляторов.
- **YooKassa-интеграция**: код-заглушка осталась, в UI кнопка скрыта
  через `paymentsAvailable.yookassa`. Включение требует одновременно
  `YOOKASSA_SHOP_ID` и `YOOKASSA_SECRET_KEY` в env — пока пусто, не
  показывается.
- **i18n EN/RU**: пока не нужно (нет EN-аудитории).
- **Webhook-режим бота**: пока polling, не критично < 1000 юзеров.

### Workflow обновился

Solo-dev: создаём ветку + PR (для diff/истории), но мерджим в main
немедленно (без ожидания review, других ревьюеров нет). На VPS
раскат через `git checkout main && git pull && npm run build && pm2 reload`.
Зафиксировано в learnings.

---

## 15. Что в репозиториях после сессии

### `baribalhvh-cloud/naivepanel`, ветка `main`

(Без изменений в этой сессии — фокус был на боте.)

Ранее слитые PR:
- **#8** `feat(internal-api): add X-API-Key auth + /api/internal/* for setpow-bot`
- **#9** `fix(reality): support xray-core 26.x x25519 output format`
- **commit `03964f4`** (без PR): то же для inline-копии в root установщике.

### `baribalhvh-cloud/setpow-bot`, ветка `main`

- **#1** `feat: bootstrap setpow-bot scaffold` — скелет (16 файлов, ~3800 строк).
- **PR с CONTEXT.md** (изначальный).
- **#5** `feat(bot): add user-facing notifications for lifecycle events`
- **#6** `fix: prevent bot crash on benign Telegram errors`
- **#7** `feat(payments): integrate Crypto Pay (@CryptoBot)`
- **#8** `fix(bot): keep greeting & description in main menu`
- **#9** `feat(bot): persistent reply-keyboard '🏠 Меню' + per-user rate limit`
- **#10** `feat(bot): add 'Продлить' button on My Keys screen`
- **#11** `feat: promo codes (one-shot day grants)`
- **#12** `feat: admin broadcast to all users`
- **#13** `feat: automatic daily DB backups to admin Telegram`

После этой документации — будет PR обновляющий `docs/CONTEXT.md`.

---

## 16. Юр-аспекты (важно прочитать перед YooKassa)

> ⚠️ **Это не юридический совет.** Я (автор кода) — разработчик,
> не юрист. Обсуждалось как контекст для технических решений.
> По любым реальным вопросам — к профильному юристу
> (например, [Roskomsvoboda](https://roskomsvoboda.org/) даёт платные
> консультации по IT-праву).

### Что регулируется в РФ

1. **276-ФЗ** (2017+, поправки 2024) — закон «о VPN». Запрещены
   средства обхода блокировок РКН. Под удар попадает не сам факт
   шифрованного туннеля, а **доступ к ресурсам в реестре РКН**
   через VPN.
2. **Статья 13.53 КоАП** (2024) — административка за рекламу/
   продвижение средств обхода блокировок. Штрафы до 80k для
   физлиц, до 1М для ИП/юрлиц.
3. **Налоги** — отдельная история. ФНС не оценивает легальность
   деятельности, только факт получения дохода. Декларирование —
   твоё решение, обсуждай с налоговым консультантом.

### Видимость для регуляторов по платёжным каналам

| Канал | Что видно регуляторам РФ | Видит ФНС |
|---|---|---|
| **YooKassa** | ИНН, паспорт, расчётный счёт, описание товара в инвойсе | Да, через банк/ОФД при запросе |
| **Telegram Stars** | Только TG-аккаунт. Выплата — на USDT/банковскую карту через Fragment с минимальным KYC | Только если юзер выводит крупные суммы в РФ-банк |
| **CryptoBot (Crypto Pay)** | Кошелёк, e-mail. Без KYC | Только при выводе крипты в РФ-банк |
| **OxaPay** | Похоже на CryptoBot | То же |

То есть **YooKassa = максимальная прозрачность** для российских
регуляторов. Если когда-нибудь подключать — только после консультации
с юристом и/или регистрации юр-лица в другой юрисдикции (Армения,
Грузия, Сербия, Казахстан, Кипр, Эстония-OÜ).

### Решение по проекту (на 2026-05-22)

- **Основные каналы**: Telegram Stars + CryptoBot. Этого достаточно
  для RU/CIS-аудитории.
- **YooKassa**: код-заглушка не удалена, в UI скрыта (нет ENV-ключей).
  Не интегрировать без юр-консультации.
- **OxaPay**: тоже заглушка, не приоритет.

### Что я как разработчик могу предложить технически

(Не юридическое — про архитектуру под разные юр-сценарии.)

1. **Оставить как есть**: Stars + CryptoBot. Минимальная видимость.
2. **Сменить юрисдикцию юр-лица**: тогда YooKassa автоматически
   отвалится (они работают только с РФ-резидентами).
3. **Сменить позиционирование**: «приватный туннель» / «блокировка
   трекеров» / «доступ к зарубежным сервисам» — другая риск-карта по
   276-ФЗ. Формулировка оферты — задача юриста.

---

## 17. Личные ноты автора

- **Stars-only-старт ушёл в прошлое**: теперь есть и CryptoBot, и
  можно работать с зарубежными юзерами.
- **CryptoBot — почти всегда лучше OxaPay** для TG-аудитории:
  нативная интеграция через TG, юзер не выходит из мессенджера,
  без KYC, мгновенно. OxaPay имеет смысл если хочешь принимать
  крипту вне Telegram.
- **Один сервер на старте — это нормально**: схема `Server[]`
  готова к росту, но не нужно сразу покупать пять VPS. Когда дойдём
  — добавляем запись через `/admin`, бот сам начнёт раздавать ключи
  на оба сервера через ту же универсальную подписку.
- **Подписка одна на юзера навсегда**: `subAggregatorToken`
  стабилен, никогда не меняется.
- **Reality + Caddy — два эксклюзивных хозяина 443/tcp**: запомни
  навсегда.
- **PANEL_API_KEY в systemd Environment**: настоятельно рекомендую
  сделать сразу как только закончатся переустановки панели.
- **bot.catch — must-have для grammY**: я бы добавлял его в каждый
  новый бот сразу с первого коммита. То что grammY кладёт процесс
  на любую API-ошибку без явного error-handler'а — спорное решение
  фреймворка.
- **VACUUM INTO для SQLite-бэкапов**: единственный безопасный
  способ. `cp` рискует получить corrupt-файл если попадёт между
  write-транзакциями.
- **Промокоды как DB-level гарантия**: `@@unique([userId, promoCodeId])`
  — не уповай на pre-check в JS, он отвалится на гонке. БД должна
  гарантировать инвариант.
- **Юр-вопросы — к юристу**: я как код-помощник могу собрать любую
  архитектуру под нужный юр-сценарий, но определение сценария —
  не моя зона.

---

**Конец документа**. Если что-то непонятно — открывайте конкретный код,
он покрыт комментариями. Если найдёте противоречие между этим
документом и кодом — кодом считается истинным, документ обновить.
