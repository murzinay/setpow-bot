/**
 * Тарифы и ценообразование. Цены в КОПЕЙКАХ для RUB, в ЗВЁЗДАХ для XTR.
 * 1 ₽ = 100 коп. 1 XTR ≈ 1.5 ₽ (актуально на 2025-Q4, сверь перед запуском).
 *
 * Дискаунт: чем длиннее план, тем сильнее off от цены за месяц (200 ₽).
 *   1 мес  → 200 ₽
 *   3 мес  → 500 ₽   (-17% от 600)
 *   6 мес  → 900 ₽   (-25% от 1200)
 *  12 мес  → 1600 ₽  (-33% от 2400)
 */

export type PlanId = '1m' | '3m' | '6m' | '12m';

export interface Plan {
  id: PlanId;
  // Сколько дней даём за этот платёж.
  days: number;
  // Заголовок для кнопки.
  title: string;
  // Цена в RUB-копейках.
  priceRub: number;
  // Цена в Telegram Stars (XTR) — целое число звёзд.
  priceStars: number;
  // Цена в USD-центах для крипты (OxaPay).
  priceUsdCents: number;
  // Размер скидки (%) по сравнению с ценой 1м * количество_месяцев. Для UI.
  discountPct: number;
}

export const PLANS: Record<PlanId, Plan> = {
  '1m': {
    id: '1m',
    days: 30,
    title: '1 месяц',
    priceRub: 200_00,
    priceStars: 130,
    priceUsdCents: 220,
    discountPct: 0,
  },
  '3m': {
    id: '3m',
    days: 90,
    title: '3 месяца',
    priceRub: 500_00,
    priceStars: 320,
    priceUsdCents: 549,
    discountPct: 17,
  },
  '6m': {
    id: '6m',
    days: 180,
    title: '6 месяцев',
    priceRub: 900_00,
    priceStars: 580,
    priceUsdCents: 999,
    discountPct: 25,
  },
  '12m': {
    id: '12m',
    days: 365,
    title: '12 месяцев',
    priceRub: 1600_00,
    priceStars: 1030,
    priceUsdCents: 1799,
    discountPct: 33,
  },
};

export const PLAN_ORDER: PlanId[] = ['1m', '3m', '6m', '12m'];

export function formatRub(kopecks: number): string {
  return (kopecks / 100).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
}
