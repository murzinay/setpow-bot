/**
 * HTTP-клиент к панели через /api/internal/* (X-API-Key auth).
 * Каждый Server в БД может иметь свой URL и свой apiKey, поэтому функции
 * принимают `server: Server` явно, а не используют глобальные ENV.
 *
 * Глобальный ENV PANEL_URL/PANEL_API_KEY используется ТОЛЬКО для bootstrap-сидинга
 * первой записи в Server при первом запуске.
 */
import type { Server } from '@prisma/client';

export type Kind = 'hy2' | 'reality';

export interface PanelUserCreated {
  kind: Kind;
  // Для hy2: логин. Для reality: name.
  name: string;
  password?: string; // hy2
  uuid?: string;     // reality
  subToken: string;
  expiresAt: string; // ISO
}

export interface PanelServerInfo {
  domain: string;
  hy2: {
    enabled: boolean;
    port: number;
    obfsPassword?: string;
  };
  reality: {
    enabled: boolean;
    port: number;
    publicKey: string;
    sni: string;
    dest: string;
    flow: string;
    shortIds: string[];
  };
}

class PanelError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'PanelError';
  }
}

async function call<T>(
  server: Pick<Server, 'panelUrl' | 'apiKey'>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${server.panelUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': server.apiKey,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // Защита от зависших запросов — 10 секунд макс.
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    throw new PanelError(`Panel ${method} ${path} → ${res.status}`, res.status, parsed ?? text);
  }
  return parsed as T;
}

export const panel = {
  async serverInfo(server: Server): Promise<PanelServerInfo> {
    return call<PanelServerInfo>(server, 'GET', '/api/internal/server-info');
  },

  /**
   * Создать юзера на панели.
   * Для kind=hy2: можно передать password или дать панели сгенерить.
   * Для kind=reality: передаём name; uuid сгенерит панель.
   */
  async createUser(
    server: Server,
    args: { kind: Kind; name: string; password?: string; expireDays: number },
  ): Promise<PanelUserCreated> {
    const res = await call<{ success: boolean; message?: string; user?: PanelUserCreated }>(
      server,
      'POST',
      '/api/internal/users',
      args,
    );
    if (!res.success || !res.user) {
      throw new PanelError(res.message || 'createUser failed', 500, res);
    }
    return res.user;
  },

  /**
   * Продление: продлеваем относительно текущего expiresAt (если не истёк),
   * иначе — от now. Логика на стороне панели — мы передаём addDays.
   */
  async extendUser(
    server: Server,
    args: { kind: Kind; name: string; addDays: number },
  ): Promise<{ expiresAt: string }> {
    const res = await call<{ success: boolean; expiresAt?: string; message?: string }>(
      server,
      'POST',
      `/api/internal/users/${args.kind}/${encodeURIComponent(args.name)}/extend`,
      { addDays: args.addDays },
    );
    if (!res.success || !res.expiresAt) {
      throw new PanelError(res.message || 'extendUser failed', 500, res);
    }
    return { expiresAt: res.expiresAt };
  },

  async deleteUser(server: Server, kind: Kind, name: string): Promise<void> {
    await call<{ success: boolean }>(
      server,
      'DELETE',
      `/api/internal/users/${kind}/${encodeURIComponent(name)}`,
    );
  },
};

export { PanelError };
