/**
 * Cron-задачи:
 *  - notifyExpiring: за 3 дня и за 1 день шлём напоминание в TG.
 *  - revokeExpired: помечаем истекшие как expired (на панели они всё равно
 *    блокируются по expiresAt в writeHysteriaConfig/writeXrayConfig) и
 *    уведомляем юзера ОДНИМ сообщением (даже если протоколов несколько).
 *
 * Запуск раз в час — этого достаточно для напоминаний (точность ±1ч ОК).
 */
import cron from 'node-cron';
import { InputFile } from 'grammy';
import { db } from './db';
import * as notify from './notify';
import { bot } from './bot';
import { env } from './config';
import { createBackup, cleanupOldBackups, formatBytes } from './backup';
import { notifyAdminError } from './adminAlerts';

async function notifyExpiring() {
  const now = Date.now();
  const ranges = [
    { label: '3 дня', from: now + 3 * 86400_000, to: now + 3 * 86400_000 + 3600_000 },
    { label: '1 день', from: now + 1 * 86400_000, to: now + 1 * 86400_000 + 3600_000 },
  ];

  for (const range of ranges) {
    const subs = await db.subscription.findMany({
      where: {
        status: { in: ['active', 'trial'] },
        expiresAt: { gte: new Date(range.from), lt: new Date(range.to) },
      },
      include: { user: true },
    });
    // Группируем по userId — один юзер с двумя протоколами на одном
    // сервере должен получить РОВНО одно напоминание (а не два).
    // Для каждого юзера берём максимальный expiresAt из его подписок
    // в этом окне, чтобы дата в сообщении была точной.
    const byUser = new Map<bigint, { expiresAt: Date }>();
    for (const sub of subs) {
      const cur = byUser.get(sub.user.tgId);
      if (!cur || sub.expiresAt > cur.expiresAt) {
        byUser.set(sub.user.tgId, { expiresAt: sub.expiresAt });
      }
    }
    for (const [tgId, { expiresAt }] of byUser) {
      await notify.expiringSoon(tgId, range.label, expiresAt);
    }
  }
}

async function markExpired() {
  const now = new Date();
  // Сначала находим всех, кто только что истёк, ПЕРЕД updateMany —
  // нам нужны их tgId для уведомления. Иначе после смены статуса
  // мы не отличим "истёкших только что" от "истёкших раньше".
  const expiringNow = await db.subscription.findMany({
    where: {
      status: { in: ['active', 'trial'] },
      expiresAt: { lt: now },
    },
    include: { user: true },
  });

  // Один юзер с N протоколами/серверами — одно сообщение.
  const notifiedUsers = new Set<bigint>();
  for (const sub of expiringNow) {
    if (notifiedUsers.has(sub.user.tgId)) continue;
    notifiedUsers.add(sub.user.tgId);
    await notify.expired(sub.user.tgId);
  }

  await db.subscription.updateMany({
    where: {
      status: { in: ['active', 'trial'] },
      expiresAt: { lt: now },
    },
    data: { status: 'expired' },
  });
}

/**
 * Чистка зависших pending-платежей.
 *
 * Зачем: юзер жмёт «💳 Купить → CryptoBot», бот создаёт Payment(pending)
 * и отдаёт ссылку на Crypto Pay. Если юзер не оплатил — Crypto Pay сам
 * через час переведёт invoice в 'expired' и webhook нам не пришлёт.
 * А наша запись в БД так и останется в pending навсегда. Для Stars
 * история похожая: юзер увидел инвойс и закрыл — pending-Payment висит.
 *
 * Это не сломает ничего технически (markPaid идемпотентен, активные
 * подписки считаются по subscriptionMs, не по платежам), но:
 *   1. /admin показывает «Оплаченных платежей: N» — для статистики
 *      по конверсии полезно видеть «pending: M» за последние сутки,
 *      а не за всё время.
 *   2. Таблица Payment растёт линейно по числу попыток. На SQLite это
 *      не проблема, на Postgres в перспективе — тоже. Но индексы по
 *      status пухнут.
 *   3. При экспорте в CSV (TODO) старые pending мусорят отчёт.
 *
 * Логика: всё что pending старше 24 часов → status=expired. 24 часа
 * выбраны с запасом: Crypto Pay даёт 1 час, у Stars нет лимита, у
 * YooKassa — до 7 дней (но в нашем сценарии юзер либо платит сразу,
 * либо забывает на сутки и идёт по новой).
 *
 * Idempotent: если запись уже expired/paid/failed — updateMany её
 * не тронет (фильтр status='pending' в where).
 */
async function cleanupStalePayments() {
  const cutoff = new Date(Date.now() - 24 * 3600_000);
  const result = await db.payment.updateMany({
    where: {
      status: 'pending',
      createdAt: { lt: cutoff },
    },
    data: { status: 'expired' },
  });
  if (result.count > 0) {
    // eslint-disable-next-line no-console
    console.log(`[cron/cleanup] expired ${result.count} stale pending payments`);
  }
}

export function startJobs() {
  // Каждый час, в :05 — чтобы не совпадать с другими крон-джобами.
  cron.schedule('5 * * * *', async () => {
    try {
      await notifyExpiring();
      await markExpired();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[cron]', e);
      void notifyAdminError('cron/notify+markExpired', e);
    }
  });

  // ─────────────────────────────────────────────────────────────
  //  Ежедневная чистка зависших pending-платежей — 03:30 UTC.
  //  За 30 минут до бэкапа (04:00), чтобы бэкап ехал уже с чистой
  //  таблицей Payment без вечно-висящих pending от месячных юзеров.
  // ─────────────────────────────────────────────────────────────
  cron.schedule('30 3 * * *', async () => {
    try {
      await cleanupStalePayments();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[cron/cleanup]', e);
      void notifyAdminError('cron/cleanupStalePayments', e);
    }
  });

  // ─────────────────────────────────────────────────────────────
  //  Ежедневный бэкап БД — 04:00 UTC.
  //  Время выбрано: на VPS в Москве это 07:00 (минимум юзеров),
  //  и не совпадает с :05 первого крона чтобы не нагружать
  //  процесс одновременно VACUUM-ом и SELECT-ами по подпискам.
  // ─────────────────────────────────────────────────────────────
  cron.schedule('0 4 * * *', async () => {
    try {
      const { gzPath, size, fileName } = await createBackup();
      const deleted = await cleanupOldBackups();

      // Шлём ВСЕМ админам — каждый из них теперь имеет файл в личном
      // чате с ботом, можно восстановить с любого устройства.
      for (const adminId of env.ADMIN_IDS) {
        try {
          await bot.api.sendDocument(
            Number(adminId),
            new InputFile(gzPath, fileName),
            {
              caption:
                `💾 *Ежедневный бэкап БД*\n\n` +
                `Размер: ${formatBytes(size)}\n` +
                `Удалено старых: ${deleted}\n` +
                `\n_Восстановление: см. README или /opt/setpow-bot/backup-restore.md_`,
              parse_mode: 'Markdown',
            },
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(
            '[backup] send to admin failed',
            adminId.toString(),
            (e as Error).message,
          );
          // Один админ заблочил бота — не повод останавливаться,
          // другим всё равно отправим.
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[cron/backup]', e);
      // Попытаемся хотя бы уведомить первого админа что бэкап упал —
      // молчаливый провал критичной задачи это худший сценарий.
      const firstAdmin = env.ADMIN_IDS[0];
      if (firstAdmin) {
        try {
          await bot.api.sendMessage(
            Number(firstAdmin),
            `🚨 *Автобэкап БД упал!*\n\n\`${(e as Error).message}\`\n\nПроверь /opt/setpow-bot/backups/ и логи.`,
            { parse_mode: 'Markdown' },
          );
        } catch {
          // ничего не поделать
        }
      }
    }
  });
}
