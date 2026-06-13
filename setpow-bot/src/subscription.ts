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
import { env } from './config';
import { panel, type Kind } from './panel';

/** 16 символов base62 — короткий «чистый» токен в стиле sub.cryox.me/<token>. */
export function genSubToken(len = 16): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % 62];
  return out;
}

/**
 * Публичная ссылка-подписка для юзера.
 *   • SUB_BASE_URL задан → https://sub.cryox.me/<token> (чистый путь;
 *     reverse-proxy переписывает на внутренний /sub/<token>).
 *   • не задан → ${PUBLIC_URL}/sub/<token> (обратная совместимость).
 * Формат больше не указываем в query — он определяется по User-Agent клиента.
 */
export function subscriptionUrl(token: string): string {
  const root = (env.SUB_BASE_URL || env.PUBLIC_URL).replace(/\/$/, '');
  return env.SUB_BASE_URL ? `${root}/${token}` : `${root}/sub/${token}`;
}

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

// ─────────────────────────────────────────────────────────────
// Нормализованные узлы. Все форматы (sing-box/clash/v2ray) строятся из
// ОДНОГО списка Node — данные одинаковы, меняется только сериализация.
// ─────────────────────────────────────────────────────────────

export type SubFormat = 'singbox' | 'clash' | 'v2ray';

interface Hy2Node {
  kind: 'hy2';
  tag: string;
  server: string;
  port: number;
  /** auth-строка hysteria2: "<login>:<password>". */
  auth: string;
  obfsPassword?: string;
  sni: string;
}
interface RealityNode {
  kind: 'reality';
  tag: string;
  server: string;
  port: number;
  uuid: string;
  flow: string;
  sni: string;
  publicKey: string;
  shortId: string;
  fingerprint: string;
}
type Node = Hy2Node | RealityNode;

/** Собрать узлы по всем активным подпискам юзера (+ максимальная дата окончания). */
async function collectNodes(userId: number): Promise<{ nodes: Node[]; expiresAt: Date | null }> {
  const subs = await activeForUser(userId);
  const nodes: Node[] = [];
  let expiresAt: Date | null = null;

  const byServerId = new Map<number, typeof subs>();
  for (const s of subs) {
    if (!expiresAt || s.expiresAt > expiresAt) expiresAt = s.expiresAt;
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
        nodes.push({
          kind: 'hy2',
          tag: `${tagPrefix} · Hy2`,
          server: info.domain,
          port: info.hy2.port,
          auth: `${sub.panelUserKey}:${sub.password ?? ''}`,
          obfsPassword: info.hy2.obfsPassword,
          sni: info.domain,
        });
      } else if (sub.kind === 'reality' && info.reality.enabled) {
        nodes.push({
          kind: 'reality',
          tag: `${tagPrefix} · Reality`,
          server: info.domain,
          port: info.reality.port,
          uuid: sub.uuid ?? '',
          flow: info.reality.flow || '',
          sni: info.reality.sni,
          publicKey: info.reality.publicKey,
          shortId: info.reality.shortIds[0] ?? '',
          fingerprint: 'chrome',
        });
      }
    }
  }
  return { nodes, expiresAt };
}

// ── sing-box JSON (sing-box / Karing / Hiddify / Happ) ────────
function renderSingbox(nodes: Node[]): string {
  const outbounds: Record<string, unknown>[] = nodes.map((n) =>
    n.kind === 'hy2'
      ? {
          type: 'hysteria2',
          tag: n.tag,
          server: n.server,
          server_port: n.port,
          password: n.auth,
          ...(n.obfsPassword ? { obfs: { type: 'salamander', password: n.obfsPassword } } : {}),
          tls: { enabled: true, server_name: n.sni },
        }
      : {
          type: 'vless',
          tag: n.tag,
          server: n.server,
          server_port: n.port,
          uuid: n.uuid,
          flow: n.flow,
          tls: {
            enabled: true,
            server_name: n.sni,
            utls: { enabled: true, fingerprint: n.fingerprint },
            reality: { enabled: true, public_key: n.publicKey, short_id: n.shortId },
          },
          packet_encoding: 'xudp',
        },
  );
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
    route: { rules: [{ ip_is_private: true, outbound: 'direct' }], final: 'proxy' },
  };
  return JSON.stringify(config, null, 2);
}

// ── v2ray base64 (v2rayNG / NekoBox / Streisand / Shadowrocket / Happ) ──
function nodeToUri(n: Node): string {
  if (n.kind === 'hy2') {
    const p = new URLSearchParams({ sni: n.sni });
    if (n.obfsPassword) {
      p.set('obfs', 'salamander');
      p.set('obfs-password', n.obfsPassword);
    }
    return `hysteria2://${encodeURIComponent(n.auth)}@${n.server}:${n.port}/?${p.toString()}#${encodeURIComponent(n.tag)}`;
  }
  const p = new URLSearchParams({
    type: 'tcp',
    security: 'reality',
    encryption: 'none',
    pbk: n.publicKey,
    fp: n.fingerprint,
    sni: n.sni,
  });
  if (n.shortId) p.set('sid', n.shortId);
  if (n.flow) p.set('flow', n.flow);
  return `vless://${n.uuid}@${n.server}:${n.port}?${p.toString()}#${encodeURIComponent(n.tag)}`;
}
function renderV2ray(nodes: Node[]): string {
  return Buffer.from(nodes.map(nodeToUri).join('\n'), 'utf8').toString('base64');
}

// ── Clash Meta / Mihomo YAML (FlClash / KoalaClash / Clash Meta / Stash) ──
function yamlStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function nodeToClash(n: Node): string {
  if (n.kind === 'hy2') {
    const parts = [
      `name: ${yamlStr(n.tag)}`,
      'type: hysteria2',
      `server: ${n.server}`,
      `port: ${n.port}`,
      `password: ${yamlStr(n.auth)}`,
      `sni: ${yamlStr(n.sni)}`,
      'skip-cert-verify: false',
    ];
    if (n.obfsPassword) parts.push('obfs: salamander', `obfs-password: ${yamlStr(n.obfsPassword)}`);
    return `  - {${parts.join(', ')}}`;
  }
  const parts = [
    `name: ${yamlStr(n.tag)}`,
    'type: vless',
    `server: ${n.server}`,
    `port: ${n.port}`,
    `uuid: ${yamlStr(n.uuid)}`,
    'network: tcp',
    'udp: true',
    'tls: true',
    `servername: ${yamlStr(n.sni)}`,
    `reality-opts: {public-key: ${yamlStr(n.publicKey)}, short-id: ${yamlStr(n.shortId)}}`,
    `client-fingerprint: ${n.fingerprint}`,
  ];
  if (n.flow) parts.push(`flow: ${n.flow}`);
  return `  - {${parts.join(', ')}}`;
}
function renderClash(nodes: Node[]): string {
  const head = ['mixed-port: 7890', 'allow-lan: false', 'mode: rule', 'log-level: warn'];
  if (nodes.length === 0) {
    return [
      ...head,
      'proxies: []',
      'proxy-groups:',
      '  - {name: PROXY, type: select, proxies: [DIRECT]}',
      'rules:',
      '  - MATCH,PROXY',
    ].join('\n');
  }
  const names = nodes.map((n) => yamlStr(n.tag)).join(', ');
  return [
    ...head,
    'proxies:',
    nodes.map(nodeToClash).join('\n'),
    'proxy-groups:',
    `  - {name: PROXY, type: select, proxies: [auto, ${names}]}`,
    `  - {name: auto, type: url-test, url: "https://www.gstatic.com/generate_204", interval: 300, proxies: [${names}]}`,
    'rules:',
    '  - MATCH,PROXY',
  ].join('\n');
}

/**
 * Построить подписку в нужном формате. Возвращает тело, Content-Type и
 * максимальную дату окончания (для заголовка Subscription-Userinfo).
 */
export async function buildSubscription(
  userId: number,
  format: SubFormat,
): Promise<{ body: string; contentType: string; expiresAt: Date | null }> {
  const { nodes, expiresAt } = await collectNodes(userId);
  if (format === 'clash') {
    return { body: renderClash(nodes), contentType: 'text/yaml; charset=utf-8', expiresAt };
  }
  if (format === 'v2ray') {
    return { body: renderV2ray(nodes), contentType: 'text/plain; charset=utf-8', expiresAt };
  }
  return { body: renderSingbox(nodes), contentType: 'application/json; charset=utf-8', expiresAt };
}

export type { ServerInfo };
