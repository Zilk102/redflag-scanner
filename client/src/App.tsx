import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { AlertTriangle, CheckCircle, HeartCrack } from 'lucide-react';
import { Helmet } from 'react-helmet-async';
import { reachGoal } from './utils/analytics';

axios.defaults.withCredentials = true;

type ScanResponse = {
  id: string;
  shareId?: string;
  isPublic?: boolean;
  userId?: string | null;
  text: string;
  result: unknown;
  isPaid: boolean;
  createdAt: string;
  autoDeleteAt?: string | null;
  anonymization?: unknown;
};

type AuthUser = {
  id: string;
  email: string;
};

type CsrfResponse = {
  csrfToken?: string;
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
  flags: AiFlag[];
};

type AiFlag = {
  category: string;
  severity: number;
  quote: string;
  explanation: string;
  what_to_reply: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

async function copyToClipboard(value: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  if (typeof document === 'undefined') throw new Error('clipboard_unavailable');

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!ok) throw new Error('clipboard_failed');
}

function buildShareUrl(scanId: string) {
  const url = new URL(window.location.href);
  url.pathname = `/r/${encodeURIComponent(scanId)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function anonymizeText(input: string) {
  return input
    .replace(/https?:\/\/\S+/gi, '[ссылка]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\+?\d[\d\s\-()]{7,}\d/g, '[телефон]')
    .replace(/@([\p{L}0-9_]{2,})/giu, '@***');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightQuotes(text: string, quotes: string[]) {
  const cleanQuotes = Array.from(
    new Set(
      quotes
        .map((q) => q.trim())
        .filter((q) => q.length >= 6)
        .slice(0, 10),
    ),
  );

  if (!text || cleanQuotes.length === 0) return [{ kind: 'text', value: text }] as const;

  const pattern = cleanQuotes
    .sort((a, b) => b.length - a.length)
    .map((q) => escapeRegExp(q))
    .join('|');

  if (!pattern) return [{ kind: 'text', value: text }] as const;
  const re = new RegExp(pattern, 'g');

  const parts: { kind: 'text' | 'mark'; value: string }[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    const match = m[0] ?? '';
    if (!match) continue;
    if (idx > lastIndex) parts.push({ kind: 'text', value: text.slice(lastIndex, idx) });
    parts.push({ kind: 'mark', value: match });
    lastIndex = idx + match.length;
  }
  if (lastIndex < text.length) parts.push({ kind: 'text', value: text.slice(lastIndex) });

  return parts;
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
  function normalizeFlags(value: unknown): AiFlag[] {
    if (!Array.isArray(value)) return [];
    const out: AiFlag[] = [];

    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue;
      const i = item as Record<string, unknown>;

      const category = typeof i.category === 'string' ? i.category.trim() : '';
      const severity = Number(i.severity);
      const quote = typeof i.quote === 'string' ? i.quote.trim() : '';
      const explanation = typeof i.explanation === 'string' ? i.explanation.trim() : '';
      const what = typeof i.what_to_reply === 'string' ? i.what_to_reply.trim() : '';

      if (!category || !Number.isFinite(severity)) continue;

      out.push({
        category,
        severity: clamp(Math.round(severity), 0, 100),
        quote,
        explanation,
        what_to_reply: what,
      });
    }

    return out.slice(0, 12);
  }

  function normalize(parsed: unknown): AiVerdict | null {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;

    const rating = Number(p.rating ?? p.score);
    const shortVerdict = p.short_verdict ?? p.verdict;
    const teaser = p.teaser;
    const fullAnalysis = p.full_analysis ?? p.analysis;
    const advice = p.advice;
    const flags = normalizeFlags(p.flags);

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
      flags,
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

function ResultsCard({
  ai,
  isPaid,
  autoDeleteAt,
  onPay,
  onShare,
  onCopy,
  onDownload,
  onDownloadPdf,
  onDownloadImage,
  onDelete,
}: {
  ai: AiVerdict;
  isPaid: boolean;
  autoDeleteAt?: string | null;
  onPay: () => void;
  onShare: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onDownloadPdf: () => void;
  onDownloadImage: () => void;
  onDelete: () => void;
}) {
  const ratingLabel = ai.rating >= 80 ? 'срочно беги' : ai.rating >= 50 ? 'осторожно' : 'похоже норм';
  const badge = getLevelColor(ai.rating);
  const [openFlagIndex, setOpenFlagIndex] = useState<number | null>(null);

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

      <div className="grid gap-3 sm:grid-cols-6">
        <button
          type="button"
          onClick={() => {
            reachGoal('share_click');
            onShare();
          }}
          className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm font-black uppercase tracking-[0.14em] text-white/90 transition hover:bg-white/10 active:bg-white/5"
        >
          Поделиться
        </button>
        <button
          type="button"
          onClick={() => {
            reachGoal('copy_result');
            onCopy();
          }}
          className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm font-black uppercase tracking-[0.14em] text-white/90 transition hover:bg-white/10 active:bg-white/5"
        >
          Скопировать
        </button>
        <button
          type="button"
          onClick={() => {
            reachGoal('download_result');
            onDownload();
          }}
          className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm font-black uppercase tracking-[0.14em] text-white/90 transition hover:bg-white/10 active:bg-white/5"
        >
          Скачать
        </button>
        <button
          type="button"
          onClick={() => {
            reachGoal('download_pdf');
            onDownloadPdf();
          }}
          className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm font-black uppercase tracking-[0.14em] text-white/90 transition hover:bg-white/10 active:bg-white/5"
        >
          PDF
        </button>
        <button
          type="button"
          onClick={() => {
            reachGoal('download_image');
            onDownloadImage();
          }}
          className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm font-black uppercase tracking-[0.14em] text-white/90 transition hover:bg-white/10 active:bg-white/5"
        >
          Картинка
        </button>
        <button
          type="button"
          onClick={() => {
            reachGoal('delete_scan_click');
            onDelete();
          }}
          className="inline-flex items-center justify-center rounded-2xl border border-red-500/35 bg-red-500/10 px-4 py-4 text-sm font-black uppercase tracking-[0.14em] text-red-100 transition hover:bg-red-500/15 active:bg-red-500/10"
        >
          Удалить
        </button>
      </div>

      {autoDeleteAt ? (
        <div className="text-center text-xs font-semibold uppercase tracking-[0.22em] text-white/55">
          Автоудаление: {new Date(autoDeleteAt).toLocaleString('ru-RU')}
        </div>
      ) : null}

      {ai.flags.length ? (
        <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-deep-bg/55 p-6">
          <div className={[!isPaid ? 'blur-md select-none' : '', 'transition'].join(' ')}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">Красные флаги</div>
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/40">{ai.flags.length} шт.</div>
            </div>

            <div className="mt-4 grid gap-3">
              {ai.flags.map((f, idx) => {
                const color = getLevelColor(f.severity);
                const isOpen = openFlagIndex === idx;
                return (
                  <div key={`${f.category}-${idx}`} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <button
                      type="button"
                      onClick={() => setOpenFlagIndex((cur) => (cur === idx ? null : idx))}
                      className="flex w-full items-center justify-between gap-3 text-left"
                    >
                      <div className="grid gap-1">
                        <div className="text-sm font-black uppercase tracking-[0.10em] text-white">
                          {f.category}
                        </div>
                        <div className="text-xs text-white/65">Серьёзность: {f.severity}/100</div>
                      </div>
                      <div className={['h-3 w-3 rounded-full', color.stroke.replace('stroke-', 'bg-')].join(' ')} />
                    </button>

                    {isOpen ? (
                      <div className="mt-4 grid gap-3">
                        {f.quote ? (
                          <div className="rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-white/85">
                            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/50">Цитата</div>
                            <div className="mt-2 whitespace-pre-wrap leading-relaxed">{f.quote}</div>
                          </div>
                        ) : null}
                        {f.explanation ? (
                          <div className="text-sm leading-relaxed text-white/85">{f.explanation}</div>
                        ) : null}
                        {f.what_to_reply ? (
                          <div className="grid gap-2">
                            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/50">Что ответить</div>
                            <div className="rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-white/90">
                              {f.what_to_reply}
                            </div>
                            <button
                              type="button"
                              onClick={async () => {
                                await copyToClipboard(f.what_to_reply).catch(() => null);
                              }}
                              className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs font-black uppercase tracking-[0.14em] text-white/90 transition hover:bg-white/10 active:bg-white/5"
                            >
                              Скопировать ответ
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {!isPaid ? (
            <div className="absolute inset-0 grid place-items-center bg-deep-bg/30 p-6">
              <div className="grid w-full max-w-md justify-items-center gap-2 text-center">
                <div className="text-[13px] font-black uppercase tracking-[0.08em] text-white">Открыть красные флаги</div>
                <div className="text-xs leading-relaxed text-white/70">Оплати, чтобы увидеть детали и ответы</div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

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
                className="neon-shadow inline-flex min-h-[60px] w-full flex-col items-center justify-center gap-1 rounded-2xl bg-neon-red px-6 py-3 text-center text-white transition hover:brightness-110 active:brightness-95"
              >
                <span className="text-[13px] font-black uppercase leading-tight tracking-[0.08em] sm:text-base">
                  ОТКРЫТЬ ПОЛНЫЙ ОТЧЁТ
                </span>
                <span className="text-[12px] font-extrabold leading-tight text-white/90 sm:text-sm">149 ₽</span>
              </button>
              <div className="text-xs leading-relaxed text-white/70">Узнай, что он на самом деле имел в виду</div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-deep-bg/55 p-6">
        <div className={[!isPaid ? 'blur-md select-none' : '', 'transition'].join(' ')}>
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">Совет</div>
          <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-white/90 sm:text-base">{ai.advice}</div>
        </div>
        {!isPaid ? (
          <div className="absolute inset-0 grid place-items-center bg-deep-bg/30 p-6">
            <div className="grid w-full max-w-md justify-items-center gap-2 text-center">
              <div className="text-[13px] font-black uppercase tracking-[0.08em] text-white">Открыть совет и разбор</div>
              <div className="text-xs leading-relaxed text-white/70">Оплати, чтобы увидеть полный отчёт</div>
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

function DeleteConfirmModal({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
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
          <div className="text-2xl font-black tracking-tight text-white">Удалить скан?</div>
          <div className="text-sm leading-relaxed text-white/80">
            Мы удалим текст переписки и результат анализа с сервера. Ссылки на этот отчёт перестанут работать.
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-6 py-4 text-sm font-black uppercase tracking-wide text-white/90 transition hover:bg-white/10 active:bg-white/5"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={() => {
                reachGoal('delete_scan_confirm');
                onConfirm();
              }}
              className="w-full rounded-2xl bg-red-500 px-6 py-4 text-sm font-black uppercase tracking-wide text-white transition hover:brightness-110 active:brightness-95"
            >
              Удалить
            </button>
          </div>
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
  const [isScanLoading, setIsScanLoading] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [anonymizeEnabled, setAnonymizeEnabled] = useState(true);
  const [retentionPreset, setRetentionPreset] = useState<'default' | '24h' | '7d' | 'off'>('default');
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [isAuthBusy, setIsAuthBusy] = useState(false);
  const [loadingLabelIndex, setLoadingLabelIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [scanResult, setScanResult] = useState<ScanResponse | null>(null);
  const [isPaid, setIsPaid] = useState(false);
  const [thankYouOpen, setThankYouOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [askQuestion, setAskQuestion] = useState('');
  const [askAnswer, setAskAnswer] = useState('');
  const [isAsking, setIsAsking] = useState(false);

  const screenshotInputRef = useRef<HTMLInputElement | null>(null);
  const ocrWorkerRef = useRef<unknown>(null);

  const csrfTokenRef = useRef('');
  const csrfInFlightRef = useRef<Promise<string> | null>(null);

  const ai = useMemo(() => parseAiVerdict(scanResult?.result), [scanResult]);
  const loadingLabels = useMemo(
    () => ['Анализируем токсичность...', 'Ищем красные флаги...', 'Связываемся с базой бывших...'],
    [],
  );

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

  const applyCsrfToken = useCallback((token: string) => {
    const t = token.trim();
    csrfTokenRef.current = t;
    if (t) {
      axios.defaults.headers.common['X-CSRF-Token'] = t;
    } else {
      delete axios.defaults.headers.common['X-CSRF-Token'];
    }
  }, []);

  const fetchCsrfToken = useCallback(async () => {
    const response = await axios.get<CsrfResponse>('/api/auth/csrf', {
      headers: { 'Cache-Control': 'no-store' },
    });
    const token = typeof response.data?.csrfToken === 'string' ? response.data.csrfToken.trim() : '';
    if (!token) throw new Error('csrf_missing');
    applyCsrfToken(token);
    return token;
  }, [applyCsrfToken]);

  const ensureCsrfToken = useCallback(async () => {
    const existing = csrfTokenRef.current;
    if (existing) return existing;

    if (!csrfInFlightRef.current) {
      csrfInFlightRef.current = fetchCsrfToken().finally(() => {
        csrfInFlightRef.current = null;
      });
    }

    return await csrfInFlightRef.current;
  }, [fetchCsrfToken]);

  const resultsRef = useRef<HTMLDivElement | null>(null);

  const resetUrlParams = useCallback((keys: string[]) => {
    const url = new URL(window.location.href);
    for (const k of keys) url.searchParams.delete(k);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const loadScanById = useCallback(
    (scanId: string, options?: { pollUntilPaid?: boolean }) => {
      const trimmed = scanId.trim();
      if (!trimmed) return;
      setIsScanLoading(true);
      setError(null);
      setScanResult(null);
      setIsPaid(false);

      let cancelled = false;
      let timeoutId: number | null = null;

      const load = async (attempt: number) => {
        try {
          const response = await axios.get<ScanResponse>(`/api/scan/public/${encodeURIComponent(trimmed)}`);
          if (cancelled) return;
          setScanResult(response.data);
          setIsPaid(Boolean(response.data.isPaid));
          window.setTimeout(() => {
            resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 50);

          const shouldPoll = options?.pollUntilPaid === true;
          if (shouldPoll && !response.data.isPaid) {
            if (attempt < 12) {
              timeoutId = window.setTimeout(() => {
                void load(attempt + 1);
              }, 1200);
            } else {
              showToast({
                id: crypto.randomUUID(),
                tone: 'danger',
                title: 'Оплата ещё подтверждается',
                message: 'Если отчёт не открылся, подожди минуту и обнови страницу.',
              });
            }
          }
        } catch {
          if (cancelled) return;
          showToast({
            id: crypto.randomUUID(),
            tone: 'danger',
            title: 'Не удалось загрузить отчёт. Проверь ссылку и попробуй ещё раз.',
          });
        } finally {
          if (!cancelled && attempt === 0) setIsScanLoading(false);
        }
      };

      void load(0);

      return () => {
        cancelled = true;
        if (timeoutId !== null) window.clearTimeout(timeoutId);
      };
    },
    [showToast],
  );

  useEffect(() => {
    let cancelled = false;
    const loadMe = async () => {
      try {
        const response = await axios.get<{ user: AuthUser | null }>('/api/auth/me');
        if (cancelled) return;
        const u = response.data?.user;
        setAuthUser(u && typeof u.id === 'string' && typeof u.email === 'string' ? u : null);
      } catch {
        if (cancelled) return;
        setAuthUser(null);
      }
    };
    void loadMe();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void ensureCsrfToken();
  }, [ensureCsrfToken]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const paymentStatus = url.searchParams.get('payment');
    const shareId = url.searchParams.get('shareId');
    const isPaymentSuccess = paymentStatus === 'success';

    const match = url.pathname.match(/^\/r\/([^/]+)\/?$/);
    const pathShareId = match?.[1] ? decodeURIComponent(match[1]) : '';

    if (isPaymentSuccess) {
      showToast({
        id: crypto.randomUUID(),
        tone: 'success',
        title: 'Оплата прошла успешно! Открываем отчет...',
      });
      setThankYouOpen(true);
    }

    const effectiveShareId = shareId || pathShareId;
    if (effectiveShareId) {
      const cleanup = loadScanById(effectiveShareId, { pollUntilPaid: isPaymentSuccess });
      if (isPaymentSuccess) resetUrlParams(['payment']);
      return () => {
        if (typeof cleanup === 'function') cleanup();
      };
    }

    if (isPaymentSuccess) resetUrlParams(['payment', 'shareId', 'analysisId']);
  }, [loadScanById, resetUrlParams, showToast]);

  useEffect(() => {
    return () => {
      const current = ocrWorkerRef.current as { terminate?: () => Promise<void> } | null;
      current?.terminate?.();
    };
  }, []);

  const handleAuthSubmit = useCallback(async () => {
    if (isAuthBusy) return;
    const email = authEmail.trim();
    const password = authPassword;
    if (!email || !password) {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Заполни email и пароль',
      });
      return;
    }

    try {
      setIsAuthBusy(true);
      await ensureCsrfToken();
      const url = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const response = await axios.post<{ user: AuthUser; csrfToken?: string }>(url, { email, password });
      const u = response.data?.user;
      if (!u || typeof u.id !== 'string' || typeof u.email !== 'string') throw new Error('bad_user');
      const nextCsrf = typeof response.data?.csrfToken === 'string' ? response.data.csrfToken : '';
      if (nextCsrf) applyCsrfToken(nextCsrf);
      setAuthUser(u);
      setAuthPassword('');
      showToast({
        id: crypto.randomUUID(),
        tone: 'success',
        title: authMode === 'register' ? 'Аккаунт создан' : 'Ты вошёл(а)',
      });
    } catch {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Не удалось войти',
        message: 'Проверь email/пароль и попробуй ещё раз.',
      });
    } finally {
      setIsAuthBusy(false);
    }
  }, [applyCsrfToken, authEmail, authMode, authPassword, ensureCsrfToken, isAuthBusy, showToast]);

  const handleLogout = useCallback(async () => {
    if (isAuthBusy) return;
    try {
      setIsAuthBusy(true);
      await ensureCsrfToken();
      const response = await axios.post<{ ok?: boolean; csrfToken?: string }>('/api/auth/logout');
      const nextCsrf = typeof response.data?.csrfToken === 'string' ? response.data.csrfToken : '';
      if (nextCsrf) applyCsrfToken(nextCsrf);
    } catch {
      return;
    } finally {
      setAuthUser(null);
      setIsAuthBusy(false);
    }
  }, [applyCsrfToken, ensureCsrfToken, isAuthBusy]);

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

    if (!authUser) {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Нужна авторизация',
        message: 'Войди или зарегистрируйся, чтобы создать отчёт и управлять им.',
      });
      return;
    }

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
      await ensureCsrfToken();
      const payloadText = anonymizeEnabled ? anonymizeText(trimmed) : trimmed;
      const retentionHours =
        retentionPreset === '24h' ? 24 : retentionPreset === '7d' ? 168 : retentionPreset === 'off' ? 0 : undefined;
      const response = await axios.post<ScanResponse>('/api/scan', {
        text: payloadText,
        consent: true,
        anonymization: { enabled: anonymizeEnabled },
        retentionHours,
      });
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

    if (!authUser) {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Нужна авторизация',
        message: 'Войди, чтобы оплатить и открыть полный отчёт.',
      });
      return;
    }

    try {
      setIsPaying(true);
      await ensureCsrfToken();
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

  async function handleShare() {
    const id = scanResult?.shareId;
    if (!id || !ai) return;

    const url = buildShareUrl(id);
    const textToShare = `Рейтинг: ${ai.rating}/100\n${ai.short_verdict}\n\n${ai.teaser}`;

    try {
      const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
      if (canShare) {
        await navigator.share({
          title: 'RedFlag Scanner',
          text: textToShare,
          url,
        });
      } else {
        await copyToClipboard(url);
      }
      showToast({
        id: crypto.randomUUID(),
        tone: 'success',
        title: canShare ? 'Отправлено' : 'Ссылка скопирована',
      });
    } catch {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Не удалось поделиться',
        message: 'Попробуй скопировать ссылку вручную из адресной строки.',
      });
    }
  }

  async function handleCopy() {
    if (!ai) return;
    const lines: string[] = [
      `RedFlag Scanner`,
      `Рейтинг: ${ai.rating}/100`,
      `Вердикт: ${ai.short_verdict}`,
      ``,
      `Коротко:`,
      ai.teaser,
    ];

    if (isPaid) {
      lines.push('', 'Полный разбор:', ai.full_analysis, '', 'Совет:', ai.advice);
    }

    try {
      await copyToClipboard(lines.join('\n'));
      showToast({
        id: crypto.randomUUID(),
        tone: 'success',
        title: 'Результат скопирован',
      });
    } catch {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Не удалось скопировать',
        message: 'Попробуй ещё раз или скопируй текст вручную.',
      });
    }
  }

  async function handleDownload() {
    if (!ai) return;
    const lines: string[] = [
      `RedFlag Scanner`,
      `Рейтинг: ${ai.rating}/100`,
      `Вердикт: ${ai.short_verdict}`,
      ``,
      `Коротко:`,
      ai.teaser,
    ];

    if (isPaid) {
      lines.push('', 'Полный разбор:', ai.full_analysis, '', 'Совет:', ai.advice);
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `redflag-scan-${scanResult?.id ?? 'result'}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);

    showToast({
      id: crypto.randomUUID(),
      tone: 'success',
      title: 'Файл скачан',
    });
  }

  async function handleDownloadImage() {
    const id = scanResult?.shareId;
    if (!id) return;
    try {
      const response = await fetch(`/api/og/scan/${encodeURIComponent(id)}.png`, { cache: 'no-store' });
      if (!response.ok) throw new Error('fetch_failed');
      const pngBlob = await response.blob();
      const href = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `redflag-scan-${id}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);

      showToast({
        id: crypto.randomUUID(),
        tone: 'success',
        title: 'Картинка скачана',
      });
    } catch {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Не удалось скачать картинку',
        message: 'Попробуй ещё раз чуть позже.',
      });
    }
  }

  async function handleDownloadPdf() {
    const id = scanResult?.shareId;
    if (!id) return;
    try {
      const response = await fetch(`/api/scan/public/${encodeURIComponent(id)}.pdf`, { cache: 'no-store' });
      if (!response.ok) throw new Error('fetch_failed');
      const pdfBlob = await response.blob();
      const href = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `redflag-scan-${id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      showToast({
        id: crypto.randomUUID(),
        tone: 'success',
        title: 'PDF скачан',
      });
    } catch {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Не удалось скачать PDF',
        message: 'Попробуй ещё раз чуть позже.',
      });
    }
  }

  async function handleAsk() {
    const id = scanResult?.id;
    const q = askQuestion.trim();
    if (!id || !q) return;
    if (isAsking) return;

    if (!authUser) {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Нужна авторизация',
        message: 'Войди, чтобы задавать вопросы по отчёту.',
      });
      return;
    }

    try {
      setIsAsking(true);
      setAskAnswer('');
      await ensureCsrfToken();
      const response = await axios.post<{ answer: string }>(`/api/scan/${encodeURIComponent(id)}/ask`, { question: q });
      const answer = typeof response.data?.answer === 'string' ? response.data.answer.trim() : '';
      if (!answer) throw new Error('empty_answer');
      setAskAnswer(answer);
      reachGoal('ask_success');
    } catch {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Не удалось получить ответ',
        message: 'Проверь сервер и попробуй ещё раз.',
      });
    } finally {
      setIsAsking(false);
    }
  }

  async function handleDeleteScan() {
    const id = scanResult?.id;
    if (!id) return;

    if (!authUser) {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Нужна авторизация',
        message: 'Войди, чтобы удалять свои отчёты.',
      });
      setDeleteConfirmOpen(false);
      return;
    }

    try {
      await ensureCsrfToken();
      await axios.delete(`/api/scan/${encodeURIComponent(id)}`);
      setScanResult(null);
      setIsPaid(false);
      resetUrlParams(['shareId', 'payment', 'analysisId']);
      showToast({
        id: crypto.randomUUID(),
        tone: 'success',
        title: 'Скан удалён',
      });
    } catch {
      showToast({
        id: crypto.randomUUID(),
        tone: 'danger',
        title: 'Не удалось удалить',
        message: 'Попробуй ещё раз чуть позже.',
      });
    } finally {
      setDeleteConfirmOpen(false);
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
      <DeleteConfirmModal
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={() => {
          void handleDeleteScan();
        }}
      />
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
              {authUser ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-3">
                  <div className="text-sm font-semibold text-white/85">
                    Вошёл(а) как <span className="font-black text-white">{authUser.email}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void handleLogout();
                    }}
                    disabled={isAuthBusy}
                    className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-white/90 transition hover:bg-white/10 active:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Выйти
                  </button>
                </div>
              ) : (
                <div className="grid gap-3 rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">Авторизация</div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setAuthMode('login')}
                        className={[
                          'rounded-xl px-3 py-2 text-xs font-black uppercase tracking-[0.14em] transition',
                          authMode === 'login' ? 'bg-white/10 text-white' : 'bg-transparent text-white/60 hover:bg-white/5',
                        ].join(' ')}
                      >
                        Вход
                      </button>
                      <button
                        type="button"
                        onClick={() => setAuthMode('register')}
                        className={[
                          'rounded-xl px-3 py-2 text-xs font-black uppercase tracking-[0.14em] transition',
                          authMode === 'register' ? 'bg-white/10 text-white' : 'bg-transparent text-white/60 hover:bg-white/5',
                        ].join(' ')}
                      >
                        Регистрация
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <input
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      placeholder="email"
                      className="w-full rounded-xl border border-white/10 bg-slate-950/75 px-3 py-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-fuchsia-500/60 focus:ring-4 focus:ring-fuchsia-500/10"
                      autoComplete="email"
                    />
                    <input
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      placeholder="пароль"
                      type="password"
                      className="w-full rounded-xl border border-white/10 bg-slate-950/75 px-3 py-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-fuchsia-500/60 focus:ring-4 focus:ring-fuchsia-500/10"
                      autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        void handleAuthSubmit();
                      }}
                      disabled={isAuthBusy}
                      className="inline-flex items-center justify-center rounded-xl bg-white/10 px-4 py-3 text-xs font-black uppercase tracking-[0.14em] text-white transition hover:bg-white/15 active:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isAuthBusy ? '...' : authMode === 'register' ? 'Создать' : 'Войти'}
                    </button>
                  </div>
                </div>
              )}

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
                  disabled={isLoading || isOcrLoading || !authUser}
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

              <label className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/85">
                <input
                  type="checkbox"
                  checked={anonymizeEnabled}
                  onChange={(e) => setAnonymizeEnabled(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-white/20 bg-slate-950/60"
                />
                <span className="leading-relaxed">Анонимизировать ссылки, email, телефоны и @профили перед анализом</span>
              </label>

              <div className="grid gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/85">
                <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">Автоудаление отчёта</div>
                <select
                  value={retentionPreset}
                  onChange={(e) => setRetentionPreset(e.target.value as 'default' | '24h' | '7d' | 'off')}
                  className="w-full rounded-xl border border-white/10 bg-slate-950/75 px-3 py-2 text-sm text-slate-100 outline-none focus:border-fuchsia-500/60 focus:ring-4 focus:ring-fuchsia-500/10"
                >
                  <option value="default">По умолчанию (настройка сервера)</option>
                  <option value="24h">Удалить через 24 часа</option>
                  <option value="7d">Удалить через 7 дней</option>
                  <option value="off">Не удалять автоматически</option>
                </select>
              </div>

              <div className="text-center text-xs font-semibold uppercase tracking-[0.22em] text-white/55">
                Можно просто перетащить скриншот сюда (drag & drop)
              </div>

              {isLoading ? (
                <div className="text-center text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                  {loadingLabels[loadingLabelIndex]}
                </div>
              ) : null}

              {isScanLoading ? (
                <div className="text-center text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                  Загружаем отчёт по ссылке...
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

          <div ref={resultsRef} />
          {scanResult && ai ? (
            <ResultsCard
              ai={ai}
              isPaid={isPaid}
            autoDeleteAt={scanResult.autoDeleteAt ?? null}
              onPay={handlePayment}
              onShare={() => {
                void handleShare();
              }}
              onCopy={() => {
                void handleCopy();
              }}
              onDownload={() => {
                void handleDownload();
              }}
              onDownloadPdf={() => {
                void handleDownloadPdf();
              }}
              onDownloadImage={() => {
                void handleDownloadImage();
              }}
              onDelete={() => setDeleteConfirmOpen(true)}
            />
          ) : null}

          {scanResult && ai ? (
            <div className="mt-6 grid gap-6 rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur sm:p-8">
              <div className="grid gap-2">
                <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">Вопрос по отчёту</div>
                <div className="text-sm leading-relaxed text-white/80">
                  Спроси, что ответить, где манипуляция, или как поставить границу.
                </div>
              </div>

              <div className="grid gap-3">
                <textarea
                  value={askQuestion}
                  onChange={(e) => setAskQuestion(e.target.value)}
                  placeholder="Например: Как лучше ответить на его последнюю фразу?"
                  className="min-h-[120px] w-full resize-none rounded-2xl border border-white/10 bg-slate-950/75 p-4 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-fuchsia-500/60 focus:ring-4 focus:ring-fuchsia-500/10"
                />
                <button
                  type="button"
                  onClick={() => {
                    void handleAsk();
                  }}
                  disabled={!askQuestion.trim() || isAsking}
                  className="inline-flex items-center justify-center gap-3 rounded-2xl bg-white/10 px-6 py-4 text-sm font-black uppercase tracking-[0.14em] text-white transition hover:bg-white/15 active:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isAsking ? <Spinner /> : null}
                  Ответить
                </button>
              </div>

              {askAnswer ? (
                <div className="rounded-3xl border border-white/10 bg-deep-bg/55 p-6">
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">Ответ</div>
                  <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-white/90 sm:text-base">{askAnswer}</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => {
                        void copyToClipboard(askAnswer);
                      }}
                      className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm font-black uppercase tracking-[0.14em] text-white/90 transition hover:bg-white/10 active:bg-white/5"
                    >
                      Скопировать
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAskQuestion('');
                        setAskAnswer('');
                      }}
                      className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm font-black uppercase tracking-[0.14em] text-white/90 transition hover:bg-white/10 active:bg-white/5"
                    >
                      Очистить
                    </button>
                  </div>
                </div>
              ) : null}

              {scanResult.text ? (
                <div className="rounded-3xl border border-white/10 bg-deep-bg/55 p-6">
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">Переписка</div>
                  <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-white/90">
                    {highlightQuotes(
                      scanResult.text,
                      ai.flags.map((f) => f.quote).filter(Boolean),
                    ).map((p, idx) =>
                      p.kind === 'mark' ? (
                        <mark
                          key={idx}
                          className="rounded bg-fuchsia-500/20 px-1 text-white"
                        >
                          {p.value}
                        </mark>
                      ) : (
                        <span key={idx}>{p.value}</span>
                      ),
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
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
