/**
 * Бизнес-логика подписок: выдача, продление, аннулирование.
 * Здесь же — генерация финальной подписки (sing-box / clash / plain) для
 * агрегатора /sub/<subAggregatorToken>.
 *
 * Принцип: для одного TG-юзера в одном сервере может быть до 2 Subscription
 * (hy2 и reality). При покупке мы продлеваем ВСЕ существующие активные
 * Subscription юзера на этом сервере. При первой покупке/триале — создаём
 * по одной на каждый доступный протокол.
 */
import crypto from 'node:crypto';
import type { Subscription, User, Server, Prisma } from '@prisma/client';
import { db } from './db';
import { panel, type Kind } from './panel';

function addDaysIso(base: Date | null | undefined, days: number): Date {
  // Если у юзера ещё активна подписка — продлеваем от текущего expiresAt.
  // Если истекла или нет — от now.
  const now = new Date();
  const start = base && base > now ? base : now;
  return new Date(start.getTime() + days * 86400_000);
}

function genHy2Username(tgId: bigint): string {
  // Префикс "tg" + tgId + 4 hex для уникальности (на случай, если юзер
  // забанен/пересоздан и нужен новый аккаунт на панели).
  return `tg${tgId}_${crypto.randomBytes(2).toString('hex')}`;
}
function genHy2Password(): string {
  // 16 url-safe символов = достаточно энтропии и читаемо.
  return crypto.randomBytes(12).toString('base64url');
}
function genRealityName(tgId: bigint): string {
  return `tg${tgId}_${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Выдать или продлить подписки юзеру на ВСЕХ активных серверах.
 * Если у юзера ещё нет подписки на сервере — создаёт по одной на каждый
 * включённый протокол. Если есть — продлевает.
 *
 * @param days сколько дней добавить (для триала — TRIAL_DAYS, для платежа
 *             — PLANS[id].days, для реферал-бонуса — REFERRAL_BONUS_DAYS).
 * @param isTrial помечаем подписку чтобы триал не давался дважды.
 */
export async function grantOrExtend(
  user: User,
  days: number,
  isTrial = false,
): Promise<Subscription[]> {
  if (days <= 0) return [];

  // Defense in depth: даже если кто-то обойдёт валидацию в /give или
  // прокинет dirty значение через onPaymentSuccess (Payment.planDays),
  // здесь ловим overflow ДО того как `new Date(huge_value)` даст
  // Invalid Date и Prisma уйдёт в краш. 3650 дней (10 лет) — потолок
  // совпадает с CAP в команде /give и в панели (extendExpiresAt).
  const MAX_DAYS = 3650;
  if (!Number.isFinite(days) || days > MAX_DAYS) {
    throw new Error(
      `grantOrExtend: invalid days=${days}, expected 1..${MAX_DAYS}`,
    );
  }

  const servers = await db.server.findMany({ where: { active: true } });
  const result: Subscription[] = [];

  for (const server of servers) {
    const protocols = server.protocols.split(',').map((p) => p.trim()).filter(Boolean) as Kind[];

    for (const kind of protocols) {
      const existing = await db.subscription.findFirst({
        where: {
          userId: user.id,
          serverId: server.id,
          kind,
          status: { in: ['active', 'trial', 'expired'] },
        },
      });

      if (existing) {
        // Продлеваем на панели и в нашей БД.
        const { expiresAt } = await panel.extendUser(server, {
          kind,
          name: existing.panelUserKey,
          addDays: days,
        });
        const updated = await db.subscription.update({
          where: { id: existing.id },
          data: {
            expiresAt: new Date(expiresAt),
            status: 'active',
            isTrial: existing.isTrial && isTrial, // снимаем trial-флаг при первой оплате
          },
        });
        result.push(updated);
      } else {
        // Создаём нового на панели.
        const name = kind === 'hy2' ? genHy2Username(user.tgId) : genRealityName(user.tgId);
        const password = kind === 'hy2' ? genHy2Password() : undefined;
        const created = await panel.createUser(server, {
          kind,
          name,
          password,
          expireDays: days,
        });
        const sub = await db.subscription.create({
          data: {
            userId: user.id,
            serverId: server.id,
            kind,
            panelUserKey: created.name,
            password: created.password ?? null,
            uuid: created.uuid ?? null,
            panelSubToken: created.subToken,
            expiresAt: new Date(created.expiresAt),
            status: isTrial ? 'trial' : 'active',
            isTrial,
          },
        });
        result.push(sub);
      }
    }
  }

  return result;
}

/**
 * Аннулировать (revoke) все подписки юзера. Используется при бане.
 * На панели юзер удаляется → сразу обрывается на сервере.
 */
export async function revokeAll(userId: number): Promise<void> {
  const subs = await db.subscription.findMany({
    where: { userId, status: { in: ['active', 'trial'] } },
    include: { server: true },
  });
  for (const sub of subs) {
    try {
      await panel.deleteUser(sub.server, sub.kind as Kind, sub.panelUserKey);
    } catch (e) {
      // Логируем но продолжаем — главное проставить статус локально.
      // eslint-disable-next-line no-console
      console.warn('[revoke] panel.deleteUser failed', sub.id, e);
    }
    await db.subscription.update({
      where: { id: sub.id },
      data: { status: 'revoked' },
    });
  }
}

/**
 * Получить активные подписки юзера, сгруппированные по серверу. Используется
 * в /sub-агрегаторе (web.ts) и в "Мои ключи" в боте.
 */
export async function activeForUser(
  userId: number,
): Promise<Array<Subscription & { server: Server }>> {
  const now = new Date();
  return db.subscription.findMany({
    where: {
      userId,
      status: { in: ['active', 'trial'] },
      expiresAt: { gt: now },
    },
    include: { server: true },
    orderBy: { createdAt: 'asc' },
  });
}

// ─────────────────────────────────────────────────────────────
// Сбор подписки для клиентов (sing-box / clash / plain).
// Логика основана на том, что строит наивпанель в panel/server/index.js,
// но мы строим сами — без обращения к /sub/<token>, чтобы агрегировать
// несколько серверов в один файл.
// ─────────────────────────────────────────────────────────────

interface ServerInfo {
  domain: string;
  hy2: { enabled: boolean; port: number; obfsPassword?: string };
  reality: {
    enabled: boolean; port: number;
    publicKey: string; sni: string; dest: string;
    flow: string; shortIds: string[];
  };
}

/**
 * Берём server-info из кэша (Server.infoCache), если кэш свежий (< 5 мин).
 * Иначе тянем из панели и обновляем кэш. Это снижает RPS к панели когда
 * подписка дёргается часто (Karing/Hiddify обновляют каждые N минут).
 */
async function getServerInfoCached(server: Server): Promise<ServerInfo> {
  const stale =
    !server.infoCache ||
    !server.infoCachedAt ||
    Date.now() - server.infoCachedAt.getTime() > 5 * 60 * 1000;

  if (!stale && server.infoCache) {
    return JSON.parse(server.infoCache) as ServerInfo;
  }
  const fresh = await panel.serverInfo(server);
  await db.server.update({
    where: { id: server.id },
    data: {
      infoCache: JSON.stringify(fresh),
      infoCachedAt: new Date(),
    },
  });
  return fresh;
}

/**
 * Сгенерировать sing-box JSON для всех активных подписок юзера.
 * Возвращает строку (JSON-форматированную). Для clash/plain — отдельные
 * билдеры будут добавлены при необходимости (Karing/Happ умеют sing-box,
 * этого достаточно для MVP).
 */
export async function buildSingboxConfig(userId: number): Promise<string> {
  const subs = await activeForUser(userId);
  if (subs.length === 0) {
    return JSON.stringify({ outbounds: [], note: 'No active subscriptions' }, null, 2);
  }

  const outbounds: Record<string, unknown>[] = [];

  // Группируем по серверу чтобы один раз получить serverInfo.
  const byServerId = new Map<number, typeof subs>();
  for (const s of subs) {
    const list = byServerId.get(s.serverId) ?? [];
    list.push(s);
    byServerId.set(s.serverId, list);
  }

  for (const [, group] of byServerId) {
    const server = group[0].server;
    const info = await getServerInfoCached(server);
    const tagPrefix = server.displayName;

    for (const sub of group) {
      if (sub.kind === 'hy2' && info.hy2.enabled) {
        outbounds.push({
          type: 'hysteria2',
          tag: `${tagPrefix} · Hy2`,
          server: info.domain,
          server_port: info.hy2.port,
          // username/password идут как `auth` в hysteria2-outbound sing-box
          password: `${sub.panelUserKey}:${sub.password ?? ''}`,
          ...(info.hy2.obfsPassword
            ? { obfs: { type: 'salamander', password: info.hy2.obfsPassword } }
            : {}),
          tls: { enabled: true, server_name: info.domain },
        });
      } else if (sub.kind === 'reality' && info.reality.enabled) {
        outbounds.push({
          type: 'vless',
          tag: `${tagPrefix} · Reality`,
          server: info.domain,
          server_port: info.reality.port,
          uuid: sub.uuid,
          flow: info.reality.flow || '',
          tls: {
            enabled: true,
            server_name: info.reality.sni,
            utls: { enabled: true, fingerprint: 'chrome' },
            reality: {
              enabled: true,
              public_key: info.reality.publicKey,
              short_id: info.reality.shortIds[0] ?? '',
            },
          },
          packet_encoding: 'xudp',
        });
      }
    }
  }

  // Минимальный playable конфиг для sing-box: outbounds + один selector.
  const tags = outbounds.map((o) => o.tag as string);
  const config = {
    log: { level: 'warn' },
    dns: { servers: [{ tag: 'cf', address: '1.1.1.1' }] },
    outbounds: [
      { type: 'selector', tag: 'proxy', outbounds: ['auto', ...tags], default: 'auto' },
      { type: 'urltest', tag: 'auto', outbounds: tags, url: 'https://www.gstatic.com/generate_204', interval: '3m' },
      ...outbounds,
      { type: 'direct', tag: 'direct' },
    ],
    route: {
      rules: [
        { protocol: 'dns', outbound: 'dns-out' },
        { ip_is_private: true, outbound: 'direct' },
      ],
      final: 'proxy',
    },
  };
  return JSON.stringify(config, null, 2);
}

export type { ServerInfo };
