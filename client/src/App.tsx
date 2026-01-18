import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { AlertTriangle, CheckCircle, HeartCrack } from 'lucide-react';
import { Helmet } from 'react-helmet-async';
import { initMetrika, reachGoal } from './utils/analytics';

type ScanResponse = {
  id: string;
  text: string;
  result: unknown;
  createdAt: string;
};

type ToastState = {
  id: string;
  tone: 'danger' | 'success';
  title: string;
  message?: string;
} | null;

type AiVerdict = {
  rating: number;
  short_verdict: string;
  teaser: string;
  full_analysis: string;
  advice: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function extractAiText(result: unknown) {
  type PathKey = string | number;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  function getPathValue(value: unknown, path: PathKey[]): unknown {
    let current: unknown = value;
    for (const key of path) {
      if (typeof key === 'number') {
        if (!Array.isArray(current)) return undefined;
        current = current[key];
        continue;
      }

      if (!isRecord(current)) return undefined;
      current = current[key];
    }
    return current;
  }

  const candidates: unknown[] = [
    getPathValue(result, ['result', 'alternatives', 0, 'message', 'text']),
    getPathValue(result, ['alternatives', 0, 'message', 'text']),
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }

  return '';
}

function parseAiVerdict(result: unknown): AiVerdict | null {
  function normalize(parsed: unknown): AiVerdict | null {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;

    const rating = Number(p.rating ?? p.score);
    const shortVerdict = p.short_verdict ?? p.verdict;
    const teaser = p.teaser;
    const fullAnalysis = p.full_analysis ?? p.analysis;
    const advice = p.advice;

    if (!Number.isFinite(rating)) return null;
    if (
      typeof shortVerdict !== 'string' ||
      typeof fullAnalysis !== 'string' ||
      typeof advice !== 'string'
    ) {
      return null;
    }

    const normalizedFull = fullAnalysis.trim();

    const derivedTeaser = (() => {
      const text = normalizedFull.replace(/\s+/g, ' ').trim();
      if (!text) return 'Есть проблема. И она только начинается…';
      const sentences = text
        .split(/(?<=[.!?…])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const firstTwo = sentences.slice(0, 2).join(' ');
      const clipped = firstTwo.length > 260 ? `${firstTwo.slice(0, 259).trim()}…` : firstTwo;
      if (/[.…]$/.test(clipped)) return clipped;
      return `${clipped}…`;
    })();

    return {
      rating: clamp(Math.round(rating), 0, 100),
      short_verdict: shortVerdict.trim(),
      teaser: (typeof teaser === 'string' ? teaser : derivedTeaser).trim(),
      full_analysis: normalizedFull,
      advice: advice.trim(),
    };
  }

  const directObject = normalize(result);
  if (directObject) return directObject;

  const raw = extractAiText(result);
  const trimmed = raw.trim();
  if (!trimmed) return null;

  function tryParse(value: string) {
    try {
      return normalize(JSON.parse(value));
    } catch {
      return null;
    }
  }

  const direct = tryParse(trimmed);
  if (direct) return direct;

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;

  return tryParse(trimmed.slice(first, last + 1));
}


function getLevelColor(level: number) {
  if (level >= 81) return { stroke: 'stroke-red-500', glow: 'shadow-[0_0_28px_rgba(239,68,68,0.30)]' };
  if (level <= 29) return { stroke: 'stroke-emerald-400', glow: 'shadow-[0_0_28px_rgba(52,211,153,0.22)]' };
  return { stroke: 'stroke-fuchsia-400', glow: 'shadow-[0_0_28px_rgba(217,70,239,0.20)]' };
}

function computeRatingStyle(rating: number) {
  const p = clamp(rating, 0, 100);
  const hue = clamp((100 - p) * 1.3, 0, 130);
  const stroke = `hsl(${hue} 92% 56%)`;
  const glow = `0 0 0 1px hsla(${hue}, 92%, 56%, 0.22), 0 0 34px hsla(${hue}, 92%, 56%, 0.25), 0 0 90px hsla(${hue}, 92%, 56%, 0.10)`;
  return { stroke, glow };
}

function LevelIcon({ level }: { level: number }) {
  if (level >= 81) return <AlertTriangle className="h-5 w-5 text-red-500" />;
  if (level <= 29) return <CheckCircle className="h-5 w-5 text-emerald-400" />;
  return <HeartCrack className="h-5 w-5 text-fuchsia-400" />;
}

function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={[
        'inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white',
        className ?? '',
      ].join(' ')}
      aria-hidden="true"
    />
  );
}


function RatingCircle({ rating }: { rating: number }) {
  const size = 240;
  const strokeWidth = 18;
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const p = clamp(Math.round(rating), 0, 100);
  const offset = c - (p / 100) * c;
  const style = computeRatingStyle(p);

  return (
    <div className="grid place-items-center rounded-full" style={{ boxShadow: style.glow }}>
      <div className="relative grid place-items-center">
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={strokeWidth}
            className="stroke-white/10"
            fill="transparent"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={strokeWidth}
            style={{ stroke: style.stroke }}
            className="transition-[stroke-dashoffset] duration-700 ease-out"
            fill="transparent"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <div className="grid gap-1 text-center">
            <div className="text-6xl font-black tracking-tight text-white">{p}</div>
            <div className="text-[12px] font-extrabold uppercase tracking-[0.28em] text-white/60">
              рейтинг
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultsCard({ ai, isPaid, onPay }: { ai: AiVerdict; isPaid: boolean; onPay: () => void }) {
  const ratingLabel = ai.rating >= 80 ? 'срочно беги' : ai.rating >= 50 ? 'осторожно' : 'похоже норм';
  const badge = getLevelColor(ai.rating);

  return (
    <div className="grid gap-6 rounded-3xl border border-white/10 bg-card-bg/60 p-6 backdrop-blur sm:p-8">
      <div className="grid justify-items-center gap-4">
        <RatingCircle rating={ai.rating} />
        <div className={['inline-flex items-center gap-2 rounded-full border border-white/10 bg-deep-bg/40 px-4 py-2', badge.glow].join(' ')}>
          <LevelIcon level={ai.rating} />
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/80">{ratingLabel}</div>
        </div>
      </div>

      <div className="grid gap-4 text-center">
        <div className="text-balance text-3xl font-black uppercase tracking-wide text-white sm:text-5xl">
          {ai.short_verdict}
        </div>
        <div className="mx-auto max-w-2xl text-base leading-relaxed text-white/85 sm:text-lg">
          {ai.teaser}
        </div>
      </div>

      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-deep-bg/55 p-6">
        <div className={[!isPaid ? 'blur-md select-none' : '', 'transition'].join(' ')}>
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">Полный разбор</div>
          <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-white/90 sm:text-base">
            {ai.full_analysis}
          </div>
        </div>

        {!isPaid ? (
          <div className="absolute inset-0 grid place-items-center bg-deep-bg/30 p-6">
            <div className="grid w-full max-w-md justify-items-center gap-3 text-center">
              <button
                type="button"
                onClick={() => {
                  reachGoal('click_paywall');
                  onPay();
                }}
                className="neon-shadow w-full rounded-2xl bg-neon-red px-6 py-4 text-sm font-black uppercase tracking-wide text-white transition hover:brightness-110 active:brightness-95 sm:text-base"
              >
                🔓 ОТКРЫТЬ ВСЮ ПРАВДУ ЗА 149₽
              </button>
              <div className="text-xs leading-relaxed text-white/70">Узнай, что он на самом деле имел в виду</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Toast({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  if (!toast) return null;

  const palette =
    toast.tone === 'success'
      ? {
          border: 'border-emerald-400/35',
          bg: 'bg-emerald-500/10',
          title: 'text-emerald-100',
          msg: 'text-emerald-100/80',
          icon: <CheckCircle className="h-5 w-5 text-emerald-400" />,
        }
      : {
          border: 'border-red-500/35',
          bg: 'bg-red-500/10',
          title: 'text-red-100',
          msg: 'text-red-100/80',
          icon: <AlertTriangle className="h-5 w-5 text-red-500" />,
        };

  return (
    <div className="fixed right-4 top-4 z-50 w-[min(420px,calc(100vw-2rem))]">
      <div
        className={[
          'relative overflow-hidden rounded-2xl border px-4 py-3 shadow-[0_0_50px_rgba(2,6,23,0.55)] backdrop-blur',
          palette.border,
          palette.bg,
        ].join(' ')}
        role="status"
        aria-live="polite"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-200 hover:bg-white/10"
        >
          Закрыть
        </button>

        <div className="flex items-start gap-3">
          <div className="mt-0.5">{palette.icon}</div>
          <div className="grid gap-1">
            <div className={['text-sm font-extrabold tracking-wide', palette.title].join(' ')}>
              {toast.title}
            </div>
            {toast.message ? (
              <div className={['text-sm leading-relaxed', palette.msg].join(' ')}>{toast.message}</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ThankYouModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4">
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/70 backdrop-blur"
      />
      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 bg-deep-bg/90 p-6 shadow-[0_0_80px_rgba(0,0,0,0.55)] backdrop-blur sm:p-8">
        <div className="grid gap-4">
          <div className="text-2xl font-black tracking-tight text-white">Спасибо!</div>
          <div className="text-sm leading-relaxed text-white/80">
            Оплата прошла успешно. Открываем отчёт — он доступен ниже.
          </div>
          <button
            type="button"
            onClick={onClose}
            className="neon-shadow w-full rounded-2xl bg-white/10 px-6 py-4 text-sm font-black uppercase tracking-wide text-white transition hover:bg-white/15 active:bg-white/10"
          >
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [text, setText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [isOcrLoading, setIsOcrLoading] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [loadingLabelIndex, setLoadingLabelIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [scanResult, setScanResult] = useState<ScanResponse | null>(null);
  const [isPaid, setIsPaid] = useState(false);
  const [thankYouOpen, setThankYouOpen] = useState(false);

  const screenshotInputRef = useRef<HTMLInputElement | null>(null);
  const ocrWorkerRef = useRef<unknown>(null);

  const ai = useMemo(() => parseAiVerdict(scanResult?.result), [scanResult]);
  const loadingLabels = useMemo(
    () => ['Анализируем токсичность...', 'Ищем красные флаги...', 'Связываемся с базой бывших...'],
    [],
  );

  useEffect(() => {
    initMetrika();
  }, []);

  useEffect(() => {
    if (!isLoading) return;

    setLoadingLabelIndex(0);
    const id = window.setInterval(() => {
      setLoadingLabelIndex((i) => (i + 1) % loadingLabels.length);
    }, 1200);

    return () => {
      window.clearInterval(id);
    };
  }, [isLoading, loadingLabels.length]);

  const showToast = useCallback((next: Exclude<ToastState, null>) => {
    setToast(next);
    window.setTimeout(() => {
      setToast((current) => (current?.id === next.id ? null : current));
    }, 5000);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const paymentStatus = url.searchParams.get('payment');
    if (paymentStatus !== 'success') return;

    showToast({
      id: crypto.randomUUID(),
      tone: 'success',
      title: 'Оплата прошла успешно! Открываем отчет...',
    });

    setIsPaid(true);
    setThankYouOpen(true);

    const scanId = url.searchParams.get('scanId');
    if (scanId) {
      axios
        .get<ScanResponse>(`/api/scan/${encodeURIComponent(scanId)}`)
        .then((response) => {
          setScanResult(response.data);
        })
        .catch(() => {
          showToast({
            id: crypto.randomUUID(),
            tone: 'danger',
            title: 'Не удалось загрузить отчёт. Попробуй обновить страницу.',
          });
        });
    }

    url.searchParams.delete('payment');
    url.searchParams.delete('scanId');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [showToast]);

  useEffect(() => {
    return () => {
      const current = ocrWorkerRef.current as { terminate?: () => Promise<void> } | null;
      current?.terminate?.();
    };
  }, []);

  async function ensureOcrWorker() {
    if (ocrWorkerRef.current) return ocrWorkerRef.current as { recognize: (image: File) => Promise<{ data?: { text?: string } }> };

    const mod = await import('tesseract.js');
    const worker = await mod.createWorker(['rus', 'eng']);
    ocrWorkerRef.current = worker;
    return worker as { recognize: (image: File) => Promise<{ data?: { text?: string } }> };
  }

  async function scanText(input: string) {
    const trimmed = input.trim();
    const shortTextToastTitle = 'Слишком мало данных. Напиши подробнее!';

    if (!consentAccepted) {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Нужно согласие на обработку данных',
        message: 'Поставь галочку под полем ввода, чтобы запустить анализ.',
      });
      return;
    }

    if (!trimmed) {
      setError('Вставь переписку в поле, иначе сканировать нечего.');
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Нечего сканировать',
        message: 'Вставь переписку в поле и попробуй ещё раз.',
      });
      return;
    }

    if (trimmed.length < 80) {
      setError(shortTextToastTitle);
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: shortTextToastTitle,
      });
      return;
    }

    setIsLoading(true);
    setError(null);
    setToast(null);
    setScanResult(null);
    setIsPaid(false);

    try {
      const response = await axios.post<ScanResponse>('/api/scan', { text: trimmed, consent: true });
      setScanResult(response.data);
      reachGoal('scan_success');
      showToast({
        id: crypto.randomUUID(),
        tone: 'success',
        title: 'Скан готов',
      });
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const status = Number(e.response?.status ?? 0);
        if (status >= 500) {
          setError(shortTextToastTitle);
          showToast({
            id: crypto.randomUUID(),
            tone: 'danger',
            title: shortTextToastTitle,
          });
          return;
        }

        const serverError = e.response?.data as unknown;
        if (
          typeof serverError === 'object' &&
          serverError !== null &&
          'error' in serverError &&
          typeof (serverError as { error?: unknown }).error === 'string'
        ) {
          const msg = (serverError as { error: string }).error;
          setError(msg);
          showToast({
            id: crypto.randomUUID(),
            tone: 'danger',
            title: 'Ошибка сканирования',
            message: msg,
          });
          return;
        }
      }
      const msg = 'Не удалось получить результат. Проверь сервер и попробуй ещё раз.';
      setError(msg);
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Ошибка сканирования',
        message: msg,
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleScan() {
    await scanText(text);
  }

  async function handleScreenshotFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Нужен файл-картинка',
        message: 'Перетащи скриншот (PNG/JPG) или выбери файл через кнопку.',
      });
      return;
    }

    if (isOcrLoading || isLoading) return;

    if (!consentAccepted) {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Нужно согласие на обработку данных',
        message: 'Поставь галочку под полем ввода, чтобы распознать и проанализировать скриншот.',
      });
      return;
    }

    try {
      setIsOcrLoading(true);
      setError(null);

      const worker = await ensureOcrWorker();
      const parts: string[] = [];

      for (const file of images) {
        const result = await worker.recognize(file);
        const extracted = typeof result?.data?.text === 'string' ? result.data.text.trim() : '';
        if (extracted) parts.push(extracted);
      }

      const extractedText = parts.join('\n\n');
      if (!extractedText) {
        showToast({
          id: crypto.randomUUID(),
          tone: 'danger',
          title: 'Не удалось распознать текст',
          message: 'Попробуй другой скриншот или вставь переписку текстом.',
        });
        return;
      }

      const nextText = [text.trim(), extractedText].filter(Boolean).join('\n\n');
      setText(nextText);
      showToast({
        id: crypto.randomUUID(),
        tone: 'success',
        title: 'Скриншот распознан',
      });

      await scanText(nextText);
    } catch {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Ошибка распознавания',
        message: 'Попробуй позже или вставь переписку текстом.',
      });
    } finally {
      setIsOcrLoading(false);
    }
  }

  async function handlePayment() {
    if (isPaying) return;

    try {
      setIsPaying(true);
      const response = await axios.post<{ confirmation_url: string }>('/api/pay', {
        scanId: scanResult?.id ?? undefined,
      });

      const confirmationUrl = response.data?.confirmation_url;
      if (typeof confirmationUrl !== 'string' || !confirmationUrl) {
        showToast({
          id: crypto.randomUUID(),
          tone: 'danger',
          title: 'Ошибка оплаты, попробуй позже',
        });
        return;
      }

      window.location.href = confirmationUrl;
    } catch {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Ошибка оплаты, попробуй позже',
      });
    } finally {
      setIsPaying(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Helmet>
        <title>RedFlag Scanner — Проверь переписку на токсичность</title>
        <meta
          name="description"
          content="Нейросеть ищет красные флаги, манипуляции и газлайтинг в твоих чатах. Узнай правду о бывшем."
        />
        <meta property="og:title" content="Твой бывший — абьюзер? Проверь нейросетью." />
        <meta
          property="og:description"
          content="Загрузи скрин переписки и получи честный психоразбор."
        />
        <meta
          property="og:image"
          content="https://placehold.co/1200x630/1a1a40/FF2A6D?text=RED+FLAG+SCANNER"
        />
        <meta property="og:type" content="website" />
      </Helmet>
      <Toast toast={toast} onClose={() => setToast(null)} />
      <ThankYouModal open={thankYouOpen} onClose={() => setThankYouOpen(false)} />
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_10%_10%,rgba(244,63,94,0.22),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_90%_18%,rgba(217,70,239,0.18),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(700px_520px_at_50%_85%,rgba(2,6,23,0.95),transparent_70%)]" />
      </div>

      <div className="relative mx-auto w-full max-w-5xl px-4 py-10 sm:py-14">
        <section className="grid gap-6">
          <div className="inline-flex items-center gap-2 self-start rounded-full border border-white/10 bg-white/5 px-4 py-2 backdrop-blur">
            <div className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_18px_rgba(239,68,68,0.55)]" />
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-200">
              RedFlag Scanner
            </div>
          </div>

          <div className="grid gap-3">
            <h1 className="text-balance text-4xl font-black tracking-tight text-slate-50 sm:text-6xl">
              ТВОЙ БЫВШИЙ — ТОКСИК?
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-slate-300 sm:text-lg">
              Нейросеть проанализирует переписку и скажет правду
            </p>
          </div>
        </section>

        <section className="mt-10 grid gap-6">
          <div
            className="relative rounded-3xl border border-white/10 bg-white/5 p-5 shadow-[0_0_48px_rgba(244,63,94,0.10)] backdrop-blur sm:p-8"
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragActive(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragActive(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragActive(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragActive(false);
              void handleScreenshotFiles(Array.from(e.dataTransfer.files));
            }}
          >
            <input
              ref={screenshotInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : [];
                e.target.value = '';
                void handleScreenshotFiles(files);
              }}
            />
            <div className="grid gap-4">
              <div className="relative">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Вставь переписку сюда..."
                  className="h-56 w-full resize-none rounded-2xl border border-white/10 bg-slate-950/75 p-4 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-red-500/60 focus:ring-4 focus:ring-red-500/10 sm:h-64 sm:p-5 sm:text-base"
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 rounded-b-2xl bg-gradient-to-t from-slate-950/85 to-transparent" />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => screenshotInputRef.current?.click()}
                  disabled={isOcrLoading || isLoading}
                  className="inline-flex w-full items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-6 py-5 text-sm font-black uppercase tracking-[0.18em] text-white/90 transition hover:bg-white/10 active:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60 sm:text-base"
                >
                  {isOcrLoading ? <Spinner className="h-5 w-5" /> : null}
                  <span>ЗАГРУЗИТЬ СКРИНШОТ</span>
                </button>

                <button
                  type="button"
                  onClick={handleScan}
                  disabled={isLoading || isOcrLoading}
                  className="pulse-slow neon-shadow inline-flex w-full items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-red-500 via-rose-500 to-fuchsia-500 px-6 py-5 text-sm font-black uppercase tracking-[0.18em] text-white shadow-[0_0_45px_rgba(244,63,94,0.25)] transition hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 sm:text-base"
                >
                  {isLoading ? <Spinner /> : null}
                  <span>ПРОВЕРИТЬ НА RED FLAGS</span>
                </button>
              </div>

              <label className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/85">
                <input
                  type="checkbox"
                  checked={consentAccepted}
                  onChange={(e) => setConsentAccepted(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-white/20 bg-slate-950/60"
                />
                <span className="leading-relaxed">
                  Я согласен(на) с{' '}
                  <a className="underline" href="/privacy.html" target="_blank" rel="noreferrer">
                    политикой обработки персональных данных
                  </a>
                  {' '}и даю согласие на обработку персональных данных для анализа переписки.
                </span>
              </label>

              <div className="text-center text-xs font-semibold uppercase tracking-[0.22em] text-white/55">
                Можно просто перетащить скриншот сюда (drag & drop)
              </div>

              {isLoading ? (
                <div className="text-center text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                  {loadingLabels[loadingLabelIndex]}
                </div>
              ) : null}

              {error ? (
                <div className="flex items-start gap-3 rounded-2xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                  <AlertTriangle className="mt-0.5 h-5 w-5 text-red-500" />
                  <div className="leading-relaxed">{error}</div>
                </div>
              ) : null}
            </div>

            {isDragActive ? (
              <div className="absolute inset-0 grid place-items-center rounded-3xl border border-white/10 bg-slate-950/70 p-6 backdrop-blur">
                <div className="grid justify-items-center gap-2 text-center">
                  <div className="text-sm font-black uppercase tracking-[0.18em] text-white">Отпусти скриншот сюда</div>
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">PNG / JPG / WEBP</div>
                </div>
              </div>
            ) : null}
          </div>

          {scanResult && ai ? <ResultsCard ai={ai} isPaid={isPaid} onPay={handlePayment} /> : null}
        </section>
      </div>

      <footer className="relative mx-auto w-full max-w-5xl px-4 pb-10 text-xs text-white/55">
        <div className="mt-10 rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <a href="/privacy.html" target="_blank" rel="noreferrer" className="underline">Политика ПДн (152-ФЗ)</a>
            <a href="/offer.html" target="_blank" rel="noreferrer" className="underline">Публичная оферта</a>
          </div>
          <div className="mt-3">
            Самозанятый: [ФИО исполнителя] · ИНН: [ИНН исполнителя]
          </div>
        </div>
      </footer>
    </div>
  );
}
