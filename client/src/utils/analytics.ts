type YmFn = (...args: unknown[]) => void;

declare global {
  interface Window {
    ym?: YmFn & { a?: unknown[] };
  }
}

function getCounterId(counterId?: string | number) {
  const fromEnv = import.meta.env.VITE_YM_ID;
  const raw = String(counterId ?? fromEnv ?? '').trim();
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

export function initMetrika(counterId?: string | number) {
  const id = getCounterId(counterId);
  if (!id) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const existingScript = document.querySelector('script[data-ym-tag="true"]');
  if (existingScript) {
    if (typeof window.ym === 'function') {
      window.ym(id, 'init', {
        clickmap: true,
        trackLinks: true,
        accurateTrackBounce: true,
        webvisor: true,
      });
    }
    return;
  }

  let ym: YmFn & { a?: unknown[] };
  if (typeof window.ym === 'function') {
    ym = window.ym;
  } else {
    ym = function (...args: unknown[]) {
      (ym.a = ym.a ?? []).push(args);
    };
  }

  window.ym = ym;
  ym(id, 'init', {
    clickmap: true,
    trackLinks: true,
    accurateTrackBounce: true,
    webvisor: true,
  });

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://mc.yandex.ru/metrika/tag.js';
  script.setAttribute('data-ym-tag', 'true');

  const headOrBody = document.head ?? document.body;
  headOrBody.appendChild(script);
}

export function reachGoal(targetName: string, counterId?: string | number) {
  const id = getCounterId(counterId);
  if (!id) return;
  if (typeof window === 'undefined') return;
  if (typeof window.ym !== 'function') return;
  if (!targetName || !targetName.trim()) return;

  window.ym(id, 'reachGoal', targetName.trim());
}

