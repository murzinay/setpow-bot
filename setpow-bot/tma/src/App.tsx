import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { getWebApp, haptic, openPayLink, type InvoiceStatus } from './telegram';
import {
  fetchMe,
  redeemPromo,
  createPayment,
  rotateKey,
  ApiError,
  type MeResponse,
  type PlanInfo,
} from './api';
import {
  IcKey,
  IcSupport,
  IcProfile,
  IcEye,
  IcCopy,
  IcRefresh,
  IcStar,
  IcChevron,
  IcChevronDown,
  IcBack,
  IcGift,
  IcTag,
  IcHelp,
  IcTg,
  IcDoc,
  IcSun,
  IcCheck,
  IcShare,
} from './icons';
import './App.css';

// ─────────────────────────────────────────────────────────────
//  Типы и константы
// ─────────────────────────────────────────────────────────────

type Theme = 'light' | 'dark';
type Tab = 'home' | 'support' | 'profile';
type Sub = null | 'partner' | 'promo' | 'faq' | 'privacy';

type Status =
  | { kind: 'loading' }
  | { kind: 'noTelegram' }
  | { kind: 'error'; message: string }
  | { kind: 'unregistered'; firstName?: string | null }
  | { kind: 'ok'; data: MeResponse };

const BG_HEX: Record<Theme, string> = { light: '#bcc2cb', dark: '#0c0f13' };
const THEME_KEY = 'cryox-theme';

const FAQ_DATA = [
  {
    q: 'Не работает ключ — что делать?',
    a: 'Проверь, что подписка активна, и импортируй актуальную ссылку. Если ты менял ключ кнопкой «Сменить» — старая ссылка перестаёт работать, скопируй новую на главном экране.',
  },
  {
    q: 'Какой клиент установить?',
    a: 'Подходит почти любой: Happ, v2rayNG, NekoBox, Streisand (iOS), FlClash/KoalaClash (Clash), Hiddify, Karing, sing-box. Ключ один — формат подберётся под клиент автоматически. Добавляй через «Импорт из буфера».',
  },
  {
    q: 'Сколько устройств можно подключить?',
    a: 'Ссылка-подписка одна и универсальная — импортируй её на нескольких устройствах. Только не раздавай её посторонним.',
  },
  {
    q: 'Как продлить подписку?',
    a: 'На главном экране нажми «Продлить подписку» и выбери срок. Дни добавятся к текущей подписке, ключ менять не нужно.',
  },
  {
    q: 'Вы храните логи?',
    a: 'Нет. Мы не ведём логи трафика, DNS-запросов и IP-адресов. Подробнее — в разделе «Конфиденциальность».',
  },
];

const HOW_STEPS = [
  { n: '01', t: 'Установите клиент', d: 'Happ · v2rayNG · NekoBox · FlClash · Hiddify · Karing' },
  { n: '02', t: 'Скопируйте ключ', d: 'Одно нажатие — ссылка в буфере' },
  { n: '03', t: 'Импорт и подключение', d: '«Добавить подписку из буфера» в клиенте' },
];

const SUPPORT_TOPICS: Array<{ t: string; ic: string }> = [
  { t: 'Не работает ключ', ic: '⛔' },
  { t: 'Оплата и чек', ic: '₽' },
  { t: 'Низкая скорость', ic: '⚡' },
  { t: 'Сменить устройство', ic: '⇄' },
  { t: 'Возврат средств', ic: '↩' },
];

// ─────────────────────────────────────────────────────────────
//  Утилиты форматирования
// ─────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  }).format(new Date(iso));
}

function pluralDays(n: number): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  let w: string;
  if (a > 10 && a < 20) w = 'дней';
  else if (b > 1 && b < 5) w = 'дня';
  else if (b === 1) w = 'день';
  else w = 'дней';
  return `${n} ${w}`;
}

// ─────────────────────────────────────────────────────────────
//  Hero: частицы + парящий кристалл с тилтом
// ─────────────────────────────────────────────────────────────

function CrystalSvg() {
  return (
    <svg
      width="150"
      height="196"
      viewBox="0 0 200 260"
      style={{ filter: 'drop-shadow(0 0 20px var(--glow)) drop-shadow(0 16px 26px rgba(40,55,85,.5))' }}
    >
      <defs>
        <linearGradient id="i1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#d3e0f1" />
        </linearGradient>
        <linearGradient id="i2" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e9f0f9" />
          <stop offset="1" stopColor="#aabdd6" />
        </linearGradient>
        <linearGradient id="i3" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#cedcee" />
          <stop offset="1" stopColor="#8a9fbd" />
        </linearGradient>
        <linearGradient id="i4" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b4c5dd" />
          <stop offset="1" stopColor="#76889f" />
        </linearGradient>
        <radialGradient id="core" cx="50%" cy="46%" r="42%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g stroke="rgba(255,255,255,.7)" strokeWidth=".7" strokeLinejoin="round">
        <polygon points="100,8 62,70 100,120" fill="url(#i2)" />
        <polygon points="100,8 140,66 100,120" fill="url(#i1)" />
        <polygon points="62,70 50,150 100,120" fill="url(#i3)" />
        <polygon points="140,66 152,150 100,120" fill="url(#i2)" />
        <polygon points="50,150 78,238 100,120" fill="url(#i4)" />
        <polygon points="152,150 128,236 100,120" fill="url(#i3)" />
        <polygon points="78,238 100,252 100,120" fill="url(#i2)" />
        <polygon points="128,236 100,252 100,120" fill="url(#i1)" />
      </g>
      <ellipse cx="100" cy="118" rx="44" ry="52" fill="url(#core)" opacity=".9" />
      <polygon
        points="100,8 62,70 50,150 78,238 100,252 128,236 152,150 140,66"
        fill="none"
        stroke="rgba(255,255,255,.85)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Hero({ theme, statusLabel }: { theme: Theme; statusLabel: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tiltRef = useRef<HTMLDivElement | null>(null);
  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let W = 0;
    let H = 0;
    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const r = cv.getBoundingClientRect();
      W = r.width;
      H = r.height;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    window.addEventListener('resize', resize);
    resize();
    const N = 80;
    const ps = Array.from({ length: N }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.6 + 0.4,
      sp: Math.random() * 0.25 + 0.06,
      ph: Math.random() * Math.PI * 2,
      am: Math.random() * 0.5 + 0.2,
      o: Math.random() * 0.5 + 0.15,
    }));
    const draw = () => {
      if (W === 0) resize();
      ctx.clearRect(0, 0, W, H);
      const dark = themeRef.current === 'dark';
      const cx = W / 2;
      const cy = H / 2;
      for (const p of ps) {
        p.y -= p.sp;
        p.ph += 0.01;
        const x = p.x + Math.sin(p.ph) * p.am;
        if (p.y < -4) {
          p.y = H + 4;
          p.x = Math.random() * W;
        }
        const dx = x - cx;
        const dy = p.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const glow = Math.max(0, 1 - dist / 150);
        ctx.beginPath();
        ctx.arc(x, p.y, p.r + glow * 0.8, 0, Math.PI * 2);
        const a = p.o * (0.5 + glow * 0.7);
        ctx.fillStyle = dark ? `rgba(220,235,255,${a})` : `rgba(255,255,255,${a * 0.95})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  const onTilt = (e: RPointerEvent<HTMLDivElement>) => {
    const el = tiltRef.current;
    if (!el) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * 2 - 1;
    const py = ((e.clientY - r.top) / r.height) * 2 - 1;
    el.style.setProperty('--ry', (px * 14).toFixed(1) + 'deg');
    el.style.setProperty('--rx', (-py * 10).toFixed(1) + 'deg');
  };
  const offTilt = () => {
    const el = tiltRef.current;
    if (el) {
      el.style.setProperty('--ry', '0deg');
      el.style.setProperty('--rx', '0deg');
    }
  };

  return (
    <div className="cx-hero" onPointerMove={onTilt} onPointerLeave={offTilt}>
      <canvas ref={canvasRef} />
      <div className="cx-hero-glow" />
      <div className="cx-tilt" ref={tiltRef}>
        <div className="cx-float">
          <CrystalSvg />
        </div>
      </div>
      <div
        className="mono"
        style={{
          position: 'absolute',
          right: 8,
          bottom: 10,
          zIndex: 4,
          textAlign: 'right',
          fontSize: 9,
          letterSpacing: 1,
          lineHeight: 1.6,
          opacity: 0.5,
        }}
      >
        STATUS // {statusLabel}
        <br />
        TAP · COPY KEY
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  Главный компонент
// ─────────────────────────────────────────────────────────────

export function App() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme) || 'dark',
  );
  const [tab, setTab] = useState<Tab>('home');
  const [sub, setSub] = useState<Sub>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [keyUrl, setKeyUrl] = useState('');
  const [faqOpen, setFaqOpen] = useState(0);
  const [promoInput, setPromoInput] = useState('');
  const [promoMsg, setPromoMsg] = useState('');
  const [promoBusy, setPromoBusy] = useState(false);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [selPlan, setSelPlan] = useState<string | null>(null);
  const [payBusy, setPayBusy] = useState(false);

  const initDataRef = useRef('');
  const toastTimer = useRef<number | undefined>(undefined);
  const themedRef = useRef(false); // юзер явно выбрал тему?

  // ── Загрузка ──────────────────────────────────────────────
  useEffect(() => {
    const wa = getWebApp();
    if (!wa) {
      setStatus({ kind: 'noTelegram' });
      return;
    }
    wa.ready();
    wa.expand();
    // Тема: если юзер раньше не выбирал — берём из клиента Telegram.
    if (!localStorage.getItem(THEME_KEY)) {
      setTheme(wa.colorScheme === 'light' ? 'light' : 'dark');
    } else {
      themedRef.current = true;
    }
    initDataRef.current = wa.initData;

    let cancelled = false;
    fetchMe(wa.initData)
      .then((data) => {
        if (cancelled) return;
        if (data.notRegistered) {
          setStatus({ kind: 'unregistered', firstName: data.firstName });
        } else {
          setKeyUrl(data.keyUrl ?? '');
          setStatus({ kind: 'ok', data });
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message =
          e instanceof ApiError
            ? `Ошибка ${e.status}: ${e.message}`
            : e instanceof Error
              ? e.message
              : 'Неизвестная ошибка';
        setStatus({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Тема → клиент Telegram + localStorage ─────────────────
  useEffect(() => {
    const wa = getWebApp();
    try {
      wa?.setBackgroundColor?.(BG_HEX[theme]);
      wa?.setHeaderColor?.(BG_HEX[theme]);
    } catch {
      /* старые клиенты */
    }
    if (themedRef.current) localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // ── Хелперы ───────────────────────────────────────────────
  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1900);
  };
  const copy = (text: string, msg = 'Скопировано в буфер') => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard может быть недоступен */
    }
    haptic('success');
    showToast(msg);
  };
  const refetch = async () => {
    try {
      const data = await fetchMe(initDataRef.current);
      if (!data.notRegistered) {
        setKeyUrl(data.keyUrl ?? '');
        setStatus({ kind: 'ok', data });
      }
    } catch {
      /* тихо — это фоновое обновление */
    }
  };
  const pickTheme = (t: Theme) => {
    themedRef.current = true;
    setTheme(t);
    haptic('light');
  };

  // ── Действия ──────────────────────────────────────────────
  const doRotate = async () => {
    if (rotateBusy) return;
    setRotateBusy(true);
    try {
      const res = await rotateKey(initDataRef.current);
      if (res.ok && res.keyUrl) {
        setKeyUrl(res.keyUrl);
        setRevealed(true);
        showToast('Ключ обновлён · старая ссылка отозвана');
        haptic('success');
      }
    } catch {
      showToast('Не удалось обновить ключ');
      haptic('error');
    } finally {
      setRotateBusy(false);
    }
  };

  const doPromo = async () => {
    const code = promoInput.trim();
    if (!code) {
      setPromoMsg('Введите код');
      return;
    }
    setPromoBusy(true);
    setPromoMsg('');
    try {
      const res = await redeemPromo(initDataRef.current, code);
      if (res.ok) {
        setPromoMsg(`✓ +${pluralDays(res.daysGranted ?? 0)} начислено`);
        setPromoInput('');
        haptic('success');
        await refetch();
      } else {
        setPromoMsg(res.error ?? 'Код недействителен');
        haptic('error');
      }
    } catch (e) {
      setPromoMsg(e instanceof ApiError ? e.message : 'Ошибка, попробуйте позже');
      haptic('error');
    } finally {
      setPromoBusy(false);
    }
  };

  const pay = async (planId: string, provider: 'tg_stars' | 'cryptobot') => {
    if (payBusy) return;
    setPayBusy(true);
    try {
      const res = await createPayment(initDataRef.current, planId, provider);
      if (res.kind === 'stars' && res.invoiceLink) {
        const wa = getWebApp();
        wa?.openInvoice(res.invoiceLink, (st: InvoiceStatus) => {
          if (st === 'paid') {
            showToast('Оплата прошла ✓');
            haptic('success');
            setRenewOpen(false);
            setSelPlan(null);
            void refetch();
          }
        });
      } else if (res.payUrl) {
        openPayLink(res.payUrl);
        showToast('Открываю оплату…');
        setRenewOpen(false);
        setSelPlan(null);
      }
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'Не удалось создать счёт');
      haptic('error');
    } finally {
      setPayBusy(false);
    }
  };

  // ── Простые состояния ─────────────────────────────────────
  if (status.kind === 'loading') {
    return (
      <div className="cx" data-theme={theme}>
        <div className="cx-center">
          <div className="cx-spinner" aria-label="Загрузка" />
        </div>
      </div>
    );
  }
  if (status.kind === 'noTelegram') {
    return (
      <div className="cx" data-theme={theme}>
        <div className="cx-center">
          <div className="glass cx-msg">
            <h2>Откройте через Telegram</h2>
            <p>Это приложение работает только внутри Telegram. Откройте его кнопкой «🚀 Открыть приложение» в боте.</p>
          </div>
        </div>
      </div>
    );
  }
  if (status.kind === 'error') {
    return (
      <div className="cx" data-theme={theme}>
        <div className="cx-center">
          <div className="glass cx-msg">
            <h2>Что-то пошло не так</h2>
            <p>{status.message}</p>
            <button className="btn" onClick={() => window.location.reload()}>
              Перезапустить
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (status.kind === 'unregistered') {
    return (
      <div className="cx" data-theme={theme}>
        <div className="cx-center">
          <div className="glass cx-msg">
            <h2>Привет{status.firstName ? `, ${status.firstName}` : ''}!</h2>
            <p>Чтобы зайти в личный кабинет — запустите бота командой /start. Получите пробный доступ и все функции.</p>
            <button className="btn" onClick={() => getWebApp()?.close()}>
              Закрыть
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── status.kind === 'ok' ──────────────────────────────────
  const me = status.data;
  const cfg = me.config;
  const sb = me.subscription!;
  const ref = me.referral!;
  const brandUpper = cfg.brand.toUpperCase();
  const active = sb.active;
  const planLabel = !active ? '—' : sb.isTrial ? 'TRIAL' : 'PRO';
  const minPrice = cfg.plans.reduce(
    (m, p) => (p.priceRub < m.priceRub ? p : m),
    cfg.plans[0],
  );
  const ringFrac = Math.max(0, Math.min(1, sb.daysLeft / 365));
  const ringOffset = 163 * (1 - ringFrac);
  const maskedKey = '••••••••••••••••••••••••••••••\n••••••••••••••••••••••••••••••••';

  const goTab = (t: Tab) => {
    setTab(t);
    setSub(null);
    window.scrollTo(0, 0);
    haptic('light');
  };
  const goSub = (s: Sub) => {
    setSub(s);
    window.scrollTo(0, 0);
    haptic('light');
  };

  const labelCss = 'label';

  return (
    <div className="cx" data-theme={theme}>
      <div className="cx-scroll">
        {/* HEADER */}
        <div className="cx-head">
          <div className="cx-logo">
            <svg width="22" height="26" viewBox="0 0 22 26" style={{ filter: 'drop-shadow(0 0 6px var(--glow))' }}>
              <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#ffffff" />
                  <stop offset="1" stopColor="#9fb3cf" />
                </linearGradient>
              </defs>
              <path d="M11 1l9 6v12l-9 6-9-6V7z" fill="url(#lg)" stroke="rgba(255,255,255,.7)" strokeWidth=".7" />
              <path d="M11 1v24M2 7l9 6 9-6M2 19l9-6 9 6" stroke="rgba(255,255,255,.45)" strokeWidth=".6" fill="none" />
            </svg>
            <div className="cx-logo-name">{brandUpper}</div>
          </div>
          <div className="cx-head-meta">
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="cx-dot" />
              {active ? 'ПОДКЛЮЧЕНИЕ ГОТОВО' : 'НЕТ ПОДПИСКИ'}
            </div>
            <div>{brandUpper} · SECURE</div>
          </div>
        </div>

        {/* TICKER */}
        <div className="cx-ticker">
          <div>
            <span>SECURE TUNNEL // REALITY-TLS // HYSTERIA2 // ENCRYPTED // ZERO LOGS // 2026 //&nbsp;</span>
            <span>SECURE TUNNEL // REALITY-TLS // HYSTERIA2 // ENCRYPTED // ZERO LOGS // 2026 //&nbsp;</span>
          </div>
        </div>

        {/* ============ HOME ============ */}
        {tab === 'home' && (
          <div className="cx-anim-in" style={{ marginTop: 4 }}>
            <Hero theme={theme} statusLabel={active ? 'ACTIVE' : 'OFFLINE'} />

            {/* SUBSCRIPTION STATUS */}
            <div className="glass" style={{ padding: '18px 20px', marginBottom: 13 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div className={labelCss} style={{ marginBottom: 6 }}>
                    SUBSCRIPTION
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: 0.3 }}>{planLabel}</span>
                    {active && (
                      <span className="chip mono" style={{ fontSize: 10, padding: '3px 8px', borderRadius: 20 }}>
                        ∞ трафик
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 6 }}>
                    {active && sb.expiresAt
                      ? `активна до ${fmtDate(sb.expiresAt)} · осталось ${pluralDays(sb.daysLeft)}`
                      : 'подписка не активна'}
                  </div>
                </div>
                <div style={{ position: 'relative', width: 62, height: 62, flexShrink: 0 }}>
                  <svg width="62" height="62" viewBox="0 0 62 62" style={{ transform: 'rotate(-90deg)' }}>
                    <circle cx="31" cy="31" r="26" fill="none" stroke="var(--glassbds)" strokeWidth="5" />
                    <circle
                      cx="31"
                      cy="31"
                      r="26"
                      fill="none"
                      stroke="url(#i1b)"
                      strokeWidth="5"
                      strokeLinecap="round"
                      strokeDasharray="163"
                      strokeDashoffset={ringOffset}
                      style={{ filter: 'drop-shadow(0 0 5px var(--glow))', transition: 'stroke-dashoffset .6s ease' }}
                    />
                    <defs>
                      <linearGradient id="i1b" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor="#ffffff" />
                        <stop offset="1" stopColor="#a9bdd8" />
                      </linearGradient>
                    </defs>
                  </svg>
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <span style={{ fontSize: 17, fontWeight: 700, lineHeight: 1 }}>{sb.daysLeft}</span>
                    <span className="mono" style={{ fontSize: 8, opacity: 0.55 }}>
                      {sb.daysLeft === 1 ? 'день' : 'дн.'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* KEY CARD */}
            <div className="glass" style={{ padding: '18px 20px 20px', marginBottom: 13 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 12,
                }}
              >
                <div className={labelCss}>ПОДПИСКА · УНИВЕРСАЛЬНЫЙ КЛЮЧ</div>
                <button
                  onClick={() => setRevealed((v) => !v)}
                  className="mono"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--ink)',
                    opacity: 0.6,
                    fontSize: 10,
                    padding: 0,
                  }}
                >
                  <IcEye />
                  {revealed ? 'Скрыть' : 'Показать'}
                </button>
              </div>
              <div
                className="mono chip"
                style={{
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  wordBreak: 'break-all',
                  whiteSpace: 'pre-wrap',
                  color: 'var(--ink)',
                  borderRadius: 16,
                  padding: '12px 14px',
                  minHeight: 64,
                }}
              >
                {revealed ? keyUrl : maskedKey}
              </div>
              <button className="btn" style={{ marginTop: 13 }} onClick={() => copy(keyUrl, 'Ключ скопирован')}>
                <IcCopy />
                Скопировать ключ
              </button>
              <button className="btn-ghost" style={{ marginTop: 9 }} disabled={rotateBusy} onClick={doRotate}>
                <IcRefresh />
                {rotateBusy ? 'Обновляю…' : 'Сменить ключ'}
              </button>
            </div>

            {/* RENEW */}
            <button
              onClick={() => {
                setRenewOpen(true);
                setSelPlan(null);
                haptic('light');
              }}
              className="glass"
              style={{
                width: '100%',
                border: '1px solid var(--glassbd)',
                cursor: 'pointer',
                padding: 17,
                marginBottom: 13,
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: 15.5,
                fontWeight: 600,
                color: 'var(--ink)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <IcStar />
                {active ? 'Продлить подписку' : 'Оформить подписку'}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="mono" style={{ fontSize: 11, opacity: 0.55 }}>
                  от {minPrice.priceLabel}
                </span>
                <IcChevron size={18} />
              </span>
            </button>

            {/* HOW TO */}
            <div className={labelCss} style={{ margin: '6px 4px 9px', opacity: 0.45 }}>
              КАК ПОДКЛЮЧИТЬСЯ
            </div>
            {HOW_STEPS.map((st) => (
              <div
                key={st.n}
                className="glass-soft"
                style={{ display: 'flex', alignItems: 'flex-start', gap: 13, padding: '14px 16px', marginBottom: 9 }}
              >
                <div className="mono" style={{ fontSize: 15, fontWeight: 700, opacity: 0.4, lineHeight: 1.1, flexShrink: 0 }}>
                  {st.n}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{st.t}</div>
                  <div style={{ fontSize: 12, opacity: 0.55, marginTop: 2 }}>{st.d}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ============ SUPPORT ============ */}
        {tab === 'support' && (
          <div className="cx-anim-in" style={{ marginTop: 8 }}>
            <div className={labelCss} style={{ margin: '6px 4px 14px', letterSpacing: 2, fontSize: 10 }}>
              SUPPORT // ONLINE
            </div>

            <div className="glass" style={{ padding: '22px 20px', marginBottom: 13, textAlign: 'center' }}>
              <div style={{ position: 'relative', width: 74, height: 74, margin: '0 auto 14px' }}>
                <div
                  style={{
                    position: 'absolute',
                    inset: -6,
                    borderRadius: '50%',
                    background: 'radial-gradient(circle,var(--glow),transparent 70%)',
                    filter: 'blur(4px)',
                    animation: 'cx-glowpulse 4s ease-in-out infinite',
                  }}
                />
                <div
                  style={{
                    position: 'relative',
                    width: 74,
                    height: 74,
                    borderRadius: '50%',
                    background: 'linear-gradient(150deg,#eef4fc,#9db1cd)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: 'inset 0 2px 2px rgba(255,255,255,.8),0 8px 20px -8px rgba(70,95,140,.6)',
                  }}
                >
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#2a3340" strokeWidth="1.6">
                    <path d="M4 12a8 8 0 0116 0v5a2 2 0 01-2 2h-1v-6h3M4 12v5a2 2 0 002 2h1v-6H4" />
                  </svg>
                </div>
              </div>
              <div style={{ fontSize: 19, fontWeight: 700 }}>Поддержка {brandUpper}</div>
              <div style={{ fontSize: 13, opacity: 0.6, marginTop: 4 }}>
                {cfg.supportUrl ? 'Обычно отвечаем быстро' : 'Контакт скоро появится'}
              </div>
              {cfg.supportUrl && (
                <button className="btn" style={{ marginTop: 16 }} onClick={() => openPayLink(cfg.supportUrl)}>
                  <IcTg />
                  Написать в Telegram
                </button>
              )}
            </div>

            <div className={labelCss} style={{ margin: '14px 4px 9px', opacity: 0.45 }}>
              ЧАСТЫЕ ТЕМЫ
            </div>
            {SUPPORT_TOPICS.map((tp) => (
              <button
                key={tp.t}
                className="glass-soft"
                onClick={() => (cfg.supportUrl ? openPayLink(cfg.supportUrl) : showToast('Поддержка скоро появится'))}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '15px 17px',
                  marginBottom: 9,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontSize: 14,
                  color: 'var(--ink)',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                  <span style={{ opacity: 0.5 }}>{tp.ic}</span>
                  {tp.t}
                </span>
                <span style={{ opacity: 0.4, display: 'flex' }}>
                  <IcChevron />
                </span>
              </button>
            ))}

            <div
              className="glass-soft"
              style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 17px', marginTop: 5 }}
            >
              <span className="cx-dot" style={{ width: 9, height: 9, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Сервис работает в штатном режиме</div>
                <div className="mono" style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>
                  REALITY · HYSTERIA2 · ZERO LOGS
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ============ PROFILE ============ */}
        {tab === 'profile' && (
          <div style={{ marginTop: 8 }}>
            {sub === null && (
              <div className="cx-anim-in">
                {/* ACCOUNT */}
                <div className="glass" style={{ padding: '18px 20px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 15 }}>
                  <div
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: 'linear-gradient(150deg,#eef4fc,#9db1cd)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: 'inset 0 2px 2px rgba(255,255,255,.8),0 6px 16px -6px rgba(70,95,140,.5)',
                    }}
                  >
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2a3340" strokeWidth="1.7">
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
                    </svg>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 17, fontWeight: 700 }}>
                      {me.user?.username ? `@${me.user.username}` : me.user?.firstName || 'Аккаунт'}
                    </div>
                    <div className="mono" style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>
                      ID {me.user?.tgId}
                    </div>
                  </div>
                  {active && (
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '5px 11px',
                        borderRadius: 20,
                        color: '#11151b',
                        background: 'linear-gradient(180deg,#fff,#cfdcef)',
                        boxShadow: '0 4px 10px -4px rgba(120,150,200,.6)',
                      }}
                    >
                      {planLabel}
                    </span>
                  )}
                </div>

                <div className={labelCss} style={{ margin: '4px 4px 9px', opacity: 0.45 }}>
                  АККАУНТ
                </div>
                <div className="glass" style={{ marginBottom: 16 }}>
                  <button className="row" onClick={() => goSub('partner')}>
                    <span className="row-ic">
                      <IcGift />
                    </span>
                    <span className="row-t">Партнёрская программа</span>
                    <span className="row-v">{ref.invited > 0 ? `${ref.invited} 👤` : ''}</span>
                    <span className="chev">
                      <IcChevron />
                    </span>
                  </button>
                  <button className="row" onClick={() => goSub('promo')}>
                    <span className="row-ic">
                      <IcTag />
                    </span>
                    <span className="row-t">Промокоды</span>
                    <span className="row-v">ввести</span>
                    <span className="chev">
                      <IcChevron />
                    </span>
                  </button>
                </div>

                <div className={labelCss} style={{ margin: '4px 4px 9px', opacity: 0.45 }}>
                  ПОДДЕРЖКА И ИНФО
                </div>
                <div className="glass" style={{ marginBottom: 16 }}>
                  <button className="row" onClick={() => goSub('faq')}>
                    <span className="row-ic">
                      <IcHelp />
                    </span>
                    <span className="row-t">Вопрос–ответ</span>
                    <span className="chev">
                      <IcChevron />
                    </span>
                  </button>
                  {cfg.channelUrl && (
                    <button className="row" onClick={() => openPayLink(cfg.channelUrl)}>
                      <span className="row-ic">
                        <IcTg />
                      </span>
                      <span className="row-t">Telegram-канал</span>
                      <span className="chev">
                        <IcChevron />
                      </span>
                    </button>
                  )}
                  <button className="row" onClick={() => goSub('privacy')}>
                    <span className="row-ic">
                      <IcDoc />
                    </span>
                    <span className="row-t">Конфиденциальность</span>
                    <span className="chev">
                      <IcChevron />
                    </span>
                  </button>
                </div>

                {/* THEME */}
                <div className={labelCss} style={{ margin: '4px 4px 9px', opacity: 0.45 }}>
                  ОФОРМЛЕНИЕ
                </div>
                <div className="glass" style={{ padding: '15px 17px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 13 }}>
                  <span className="row-ic">
                    <IcSun />
                  </span>
                  <span style={{ flex: 1, fontSize: 14.5 }}>Тема</span>
                  <div className="chip" style={{ display: 'flex', borderRadius: 14, padding: 3, gap: 2 }}>
                    <button
                      onClick={() => pickTheme('light')}
                      style={{
                        border: 'none',
                        cursor: 'pointer',
                        borderRadius: 11,
                        padding: '7px 13px',
                        fontFamily: "'Space Grotesk', sans-serif",
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: theme === 'light' ? '#11151b' : 'var(--ink)',
                        background: theme === 'light' ? 'linear-gradient(180deg,#fff,#cfdcef)' : 'transparent',
                      }}
                    >
                      Лёд
                    </button>
                    <button
                      onClick={() => pickTheme('dark')}
                      style={{
                        border: 'none',
                        cursor: 'pointer',
                        borderRadius: 11,
                        padding: '7px 13px',
                        fontFamily: "'Space Grotesk', sans-serif",
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: theme === 'dark' ? '#11151b' : 'var(--ink)',
                        background: theme === 'dark' ? 'linear-gradient(180deg,#fff,#cfdcef)' : 'transparent',
                      }}
                    >
                      Ночь
                    </button>
                  </div>
                </div>

                <div className="mono" style={{ textAlign: 'center', fontSize: 10, letterSpacing: 1, opacity: 0.35, paddingBottom: 8 }}>
                  {brandUpper} · мини-апп
                </div>
              </div>
            )}

            {sub !== null && (
              <div className="cx-anim-sub">
                <button
                  onClick={() => goSub(null)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--ink)',
                    fontFamily: "'Space Grotesk', sans-serif",
                    fontSize: 14,
                    fontWeight: 600,
                    padding: '4px 0 14px',
                    opacity: 0.8,
                  }}
                >
                  <IcBack />
                  {sub === 'partner'
                    ? 'Партнёрская программа'
                    : sub === 'promo'
                      ? 'Промокоды'
                      : sub === 'faq'
                        ? 'Вопрос–ответ'
                        : 'Конфиденциальность'}
                </button>

                {/* PARTNER (реальный реферал: +N дней за оплатившего друга) */}
                {sub === 'partner' && (
                  <div>
                    <div className="glass" style={{ padding: 20, marginBottom: 13, textAlign: 'center' }}>
                      <div className={labelCss}>ВАШ БОНУС</div>
                      <div style={{ fontSize: 34, fontWeight: 700, margin: '6px 0 2px', letterSpacing: -0.5 }}>
                        +{pluralDays(ref.bonusDays)}
                      </div>
                      <div style={{ fontSize: 12.5, opacity: 0.55 }}>
                        за каждого друга, который оплатит подписку
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 9, marginBottom: 13 }}>
                      <div className="glass-soft" style={{ flex: 1, padding: 15, textAlign: 'center' }}>
                        <div style={{ fontSize: 22, fontWeight: 700 }}>{ref.invited}</div>
                        <div className="mono" style={{ fontSize: 9.5, opacity: 0.5, marginTop: 2 }}>
                          ПРИГЛАШЕНО
                        </div>
                      </div>
                      <div className="glass-soft" style={{ flex: 1, padding: 15, textAlign: 'center' }}>
                        <div style={{ fontSize: 22, fontWeight: 700 }}>+{ref.bonusDays}</div>
                        <div className="mono" style={{ fontSize: 9.5, opacity: 0.5, marginTop: 2 }}>
                          ДНЕЙ ЗА ДРУГА
                        </div>
                      </div>
                    </div>
                    <div className={labelCss} style={{ margin: '4px 4px 8px', opacity: 0.45 }}>
                      ВАША ССЫЛКА
                    </div>
                    <div className="chip" style={{ display: 'flex', alignItems: 'center', gap: 10, borderRadius: 16, padding: '13px 15px' }}>
                      <span className="mono" style={{ flex: 1, fontSize: 12, wordBreak: 'break-all' }}>
                        {ref.link}
                      </span>
                      <button
                        onClick={() => copy(ref.link, 'Ссылка скопирована')}
                        style={{ border: 'none', cursor: 'pointer', background: 'none', color: 'var(--ink)', opacity: 0.7, display: 'flex' }}
                      >
                        <IcCopy />
                      </button>
                    </div>
                    <button
                      className="btn"
                      style={{ marginTop: 11 }}
                      onClick={() =>
                        getWebApp()?.openTelegramLink(
                          `https://t.me/share/url?url=${encodeURIComponent(ref.link)}&text=${encodeURIComponent(
                            `Подключайся к ${cfg.brand} VPN`,
                          )}`,
                        )
                      }
                    >
                      <IcShare />
                      Поделиться ссылкой
                    </button>
                  </div>
                )}

                {/* PROMO */}
                {sub === 'promo' && (
                  <div className="glass" style={{ padding: 20 }}>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>Активировать промокод</div>
                    <div style={{ fontSize: 12.5, opacity: 0.55, marginTop: 4, marginBottom: 14 }}>
                      Бонусные дни по коду
                    </div>
                    <input
                      className="cx-input"
                      value={promoInput}
                      onChange={(e) => setPromoInput(e.target.value)}
                      placeholder="НАПРИМЕР: ICE2026"
                      autoCapitalize="characters"
                    />
                    <button className="btn" style={{ marginTop: 11 }} disabled={promoBusy} onClick={doPromo}>
                      {promoBusy ? 'Проверяю…' : 'Применить'}
                    </button>
                    <div className="mono" style={{ fontSize: 11, textAlign: 'center', opacity: 0.7, marginTop: 12, minHeight: 14 }}>
                      {promoMsg}
                    </div>
                  </div>
                )}

                {/* FAQ */}
                {sub === 'faq' && (
                  <div>
                    {FAQ_DATA.map((f, i) => (
                      <div key={i} className="glass" style={{ borderRadius: 18, marginBottom: 9 }}>
                        <button
                          onClick={() => setFaqOpen(faqOpen === i ? -1 : i)}
                          style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                            padding: '15px 17px',
                            cursor: 'pointer',
                            textAlign: 'left',
                            background: 'none',
                            border: 'none',
                            fontFamily: "'Space Grotesk', sans-serif",
                            fontSize: 14,
                            fontWeight: 500,
                            color: 'var(--ink)',
                          }}
                        >
                          {f.q}
                          <span
                            style={{
                              opacity: 0.5,
                              flexShrink: 0,
                              transform: faqOpen === i ? 'rotate(180deg)' : 'rotate(0deg)',
                              transition: 'transform .25s',
                              display: 'flex',
                            }}
                          >
                            <IcChevronDown />
                          </span>
                        </button>
                        {faqOpen === i && (
                          <div style={{ padding: '0 17px 16px', fontSize: 13, lineHeight: 1.55, opacity: 0.65 }}>{f.a}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* PRIVACY */}
                {sub === 'privacy' && (
                  <div className="glass" style={{ padding: 20 }}>
                    <div className={labelCss} style={{ marginBottom: 12 }}>
                      ZERO-LOGS POLICY
                    </div>
                    <p style={{ fontSize: 13.5, lineHeight: 1.65, opacity: 0.72, margin: '0 0 12px' }}>
                      Мы не ведём логи вашего трафика, посещённых сайтов, DNS-запросов и IP-адресов. Сервис хранит только
                      данные, необходимые для работы подписки: идентификатор Telegram и срок действия ключа.
                    </p>
                    <p style={{ fontSize: 13.5, lineHeight: 1.65, opacity: 0.72, margin: '0 0 12px' }}>
                      Платёжные данные обрабатываются провайдером оплаты и не сохраняются на наших серверах. Ссылку-ключ
                      можно сменить в любой момент — старая мгновенно отзывается.
                    </p>
                    <p style={{ fontSize: 13.5, lineHeight: 1.65, opacity: 0.72, margin: 0 }}>
                      Используя {cfg.brand}, вы соглашаетесь с условиями использования и политикой конфиденциальности.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* TAB BAR */}
      <div className="cx-tabbar">
        <button className={`cx-tab${tab === 'home' ? ' active' : ''}`} onClick={() => goTab('home')}>
          <IcKey />
          <span>Ключ</span>
        </button>
        <button className={`cx-tab${tab === 'support' ? ' active' : ''}`} onClick={() => goTab('support')}>
          <IcSupport />
          <span>Поддержка</span>
        </button>
        <button className={`cx-tab${tab === 'profile' ? ' active' : ''}`} onClick={() => goTab('profile')}>
          <IcProfile />
          <span>Профиль</span>
        </button>
      </div>

      {/* TOAST */}
      {toast && (
        <div className="cx-toast">
          <span style={{ color: '#7fe0a6', display: 'flex' }}>
            <IcCheck />
          </span>
          {toast}
        </div>
      )}

      {/* RENEW SHEET */}
      {renewOpen && (
        <div
          className="cx-sheet-backdrop"
          onClick={() => {
            setRenewOpen(false);
            setSelPlan(null);
          }}
        >
          <div className="cx-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="cx-sheet-grip" />
            <div style={{ fontSize: 18, fontWeight: 700, padding: '0 2px 4px' }}>
              {active ? 'Продлить подписку' : 'Оформить подписку'}
            </div>
            <div style={{ fontSize: 12.5, opacity: 0.55, padding: '0 2px 14px' }}>
              {selPlan ? 'Выбери способ оплаты' : 'Чем длиннее срок — тем выгоднее'}
            </div>

            {!selPlan &&
              cfg.plans.map((p: PlanInfo) => (
                <button key={p.id} className="cx-plan" onClick={() => { setSelPlan(p.id); haptic('light'); }}>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 15, fontWeight: 600 }}>{p.title}</span>
                    <span className="mono" style={{ fontSize: 11, opacity: 0.55 }}>
                      {pluralDays(p.days)}
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    {p.discountPct > 0 && (
                      <span className="cx-badge" style={{ color: '#7fe0a6', borderColor: 'rgba(127,224,166,.4)' }}>
                        −{p.discountPct}%
                      </span>
                    )}
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{p.priceLabel}</span>
                  </span>
                </button>
              ))}

            {selPlan &&
              (() => {
                const p = cfg.plans.find((x) => x.id === selPlan)!;
                return (
                  <div>
                    <div className="glass-soft" style={{ padding: '15px 17px', marginBottom: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>{p.title}</span>
                      <span style={{ fontSize: 15, fontWeight: 700 }}>{p.priceLabel}</span>
                    </div>
                    {cfg.providers.tgStars && (
                      <button className="btn" style={{ marginBottom: 9 }} disabled={payBusy} onClick={() => pay(p.id, 'tg_stars')}>
                        <IcStar size={18} />
                        {payBusy ? 'Создаю счёт…' : `Telegram Stars · ${p.priceStars} ⭐`}
                      </button>
                    )}
                    {cfg.providers.cryptobot && (
                      <button className="btn-ghost" style={{ padding: 15, fontSize: 15 }} disabled={payBusy} onClick={() => pay(p.id, 'cryptobot')}>
                        🪙 Криптой (CryptoBot) · {p.priceLabel}
                      </button>
                    )}
                    {!cfg.providers.tgStars && !cfg.providers.cryptobot && (
                      <div style={{ textAlign: 'center', opacity: 0.6, fontSize: 13, padding: 12 }}>
                        Оплата временно недоступна
                      </div>
                    )}
                    <button
                      className="btn-ghost"
                      style={{ marginTop: 9, background: 'transparent', border: 'none', opacity: 0.6 }}
                      onClick={() => setSelPlan(null)}
                    >
                      ← Другой срок
                    </button>
                  </div>
                );
              })()}
          </div>
        </div>
      )}
    </div>
  );
}
