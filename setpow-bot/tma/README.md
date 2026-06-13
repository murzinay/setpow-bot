# setpow-tma

Telegram Mini App для бота `setpow-bot`. React + Vite + TypeScript.

После сборки попадает в `tma/dist/` и раздаётся бэкендом по пути
`${PUBLIC_URL}/app/`.

## Команды

```bash
cd tma
npm install        # один раз — поставит React, Vite, TS
npm run build      # → tma/dist/
npm run dev        # локальный dev-server :5173 (для разработки UI вне TMA)
```

## Как добавить TMA в боте

Уже сделано в коде — в главном меню бота появилась кнопка **«🚀 Открыть приложение»**, которая ведёт на `${PUBLIC_URL}/app/`.

Чтобы кнопка-«гамбургер» (она же `menu_button` в Telegram-клиенте) тоже открывала мини-апп, надо один раз настроить через **@BotFather**:

1. `/setmenubutton` → выбрать бота
2. Тип: `Web App`
3. Текст: `App` (или `Кабинет`, что больше нравится)
4. URL: `https://your-domain.com/app/` (тот же, что в `PUBLIC_URL` + `/app/`)

Так у юзеров появится постоянная кнопка-приложение слева от поля ввода в чате с ботом.

## Локальная разработка

Vite-dev-сервер не работает напрямую внутри Telegram (нужен HTTPS-домен).
Для разработки UI:

1. Запусти `npm run dev` — откроется `http://localhost:5173/`.
2. В обычном браузере увидишь экран «Открой через Telegram» — это нормально, `window.Telegram.WebApp` тут `undefined`.
3. Чтобы подебажить с реальной авторизацией — пробрось наружу через `cloudflared tunnel --url http://localhost:5173` и пропиши получившийся `https://*.trycloudflare.com/` в BotFather как тестовую TMA URL для отдельного **dev-бота** (НЕ продового).

## Деплой

`tma/dist/` собирается на стороне сервера при деплое. Минимальный шаг:

```bash
cd /opt/setpow-bot/tma
npm ci
npm run build
# рестартуем бэкенд чтобы fs.existsSync(tmaDistPath) прошёл
pm2 restart setpow-bot
```

Если `tma/dist/` отсутствует, бэкенд логирует warning, но запускается — кнопка приложения просто будет вести в 404. Это позволяет деплоить бота без TMA, если что-то сломалось в фронтенд-сборке.
