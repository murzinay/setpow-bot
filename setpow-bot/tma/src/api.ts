/**
 * Клиент для /api/tma/*.
 *
 * Каждый запрос обязан пробросить initData в Authorization-заголовке —
 * это наша единственная авторизация. Подробности — в src/tma/auth.ts на
 * бэкенде.
 */

const BASE = '/api/tma';

export interface PlanInfo {
  id: string;
  title: string;
  days: number;
  /** Цена в копейках. */
  priceRub: number;
  /** Готовая строка вида "500 ₽". */
  priceLabel: string;
  priceStars: number;
  discountPct: number;
}

export interface AppConfig {
  brand: string;
  botUsername: string;
  supportUrl: string;
  channelUrl: string;
  providers: { tgStars: boolean; cryptobot: boolean };
  plans: PlanInfo[];
}

export interface MeResponse {
  notRegistered: boolean;
  /** Заполняется только при notRegistered=true. */
  firstName?: string | null;
  user?: {
    tgId: string;
    firstName: string | null;
    username: string | null;
    isPremium: boolean;
  };
  subscription?: {
    active: boolean;
    isTrial: boolean;
    daysLeft: number;
    expiresAt: string | null;
    count: number;
  };
  keyUrl?: string;
  referral?: {
    code: string;
    link: string;
    invited: number;
    bonusDays: number;
  };
  config: AppConfig;
}

export interface PromoResult {
  ok: boolean;
  error?: string;
  daysGranted?: number;
  expiresAt?: string | null;
}

export interface PayResult {
  ok: boolean;
  kind?: 'stars' | 'url';
  invoiceLink?: string;
  payUrl?: string | null;
  error?: string;
}

export interface RotateResult {
  ok: boolean;
  keyUrl?: string;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, initData: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `tma ${initData}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Бэкенд старается возвращать { error: '...' }; если не JSON — фоллбек
    // на статус-код, чтобы юзер хотя бы понял, что 401 vs 500.
    let msg = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export function fetchMe(initData: string): Promise<MeResponse> {
  return request<MeResponse>('/me', initData);
}

export function redeemPromo(initData: string, code: string): Promise<PromoResult> {
  return request<PromoResult>('/promo', initData, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export function createPayment(
  initData: string,
  planId: string,
  provider: 'tg_stars' | 'cryptobot',
): Promise<PayResult> {
  return request<PayResult>('/pay/create', initData, {
    method: 'POST',
    body: JSON.stringify({ planId, provider }),
  });
}

export function rotateKey(initData: string): Promise<RotateResult> {
  return request<RotateResult>('/key/rotate', initData, { method: 'POST' });
}

export { ApiError };
