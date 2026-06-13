/**
 * Тонкая обёртка над window.Telegram.WebApp.
 *
 * Покрывает то, что реально используем в мини-аппе Cryox: инициализация,
 * тема, нативное окно оплаты (openInvoice), внешние/телеграм-ссылки и
 * хаптика. SDK @telegram-apps не тянем — для этого набора хватает
 * нативного API.
 *
 * См. https://core.telegram.org/bots/webapps#initializing-mini-apps
 */

export type InvoiceStatus = 'paid' | 'cancelled' | 'failed' | 'pending';

interface TelegramWebAppMinimal {
  initData: string;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  ready(): void;
  expand(): void;
  close(): void;
  /** Нативное окно оплаты по ссылке t.me/$... из createInvoiceLink. */
  openInvoice(url: string, callback?: (status: InvoiceStatus) => void): void;
  /** Внешняя http(s)-ссылка (откроется во внешнем браузере/IV). */
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  /** Ссылка t.me/... — откроется внутри Telegram. */
  openTelegramLink(url: string): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  onEvent?(event: string, handler: () => void): void;
  offEvent?(event: string, handler: () => void): void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebAppMinimal };
  }
}

/**
 * Получить инстанс WebApp или null, если страница открыта вне Telegram
 * (например, юзер скопировал URL и открыл в обычном браузере).
 *
 * Возвращаем null, а не throw — фронт сам решит, что показать.
 */
export function getWebApp(): TelegramWebAppMinimal | null {
  return window.Telegram?.WebApp ?? null;
}

/** Лёгкая хаптика на тапах — безопасно no-op вне Telegram. */
export function haptic(kind: 'light' | 'medium' | 'success' | 'error' = 'light'): void {
  const wa = getWebApp();
  if (!wa?.HapticFeedback) return;
  try {
    if (kind === 'success' || kind === 'error') {
      wa.HapticFeedback.notificationOccurred(kind);
    } else {
      wa.HapticFeedback.impactOccurred(kind);
    }
  } catch {
    /* старые клиенты без HapticFeedback — игнорируем */
  }
}

/** Открыть произвольную ссылку оплаты: t.me/... — внутри TG, иначе внешне. */
export function openPayLink(url: string): void {
  const wa = getWebApp();
  if (!wa) {
    window.open(url, '_blank');
    return;
  }
  if (/^https?:\/\/t\.me\//i.test(url)) {
    wa.openTelegramLink(url);
  } else {
    wa.openLink(url);
  }
}
