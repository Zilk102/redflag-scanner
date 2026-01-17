import { useMemo, useState } from 'react';
import axios from 'axios';

type AnalyzeResponse = {
  id: string;
  originalText: string;
  result: unknown;
  isPaid: boolean;
  createdAt: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function computeToxicityPercent(text: string) {
  const t = text.toLowerCase();
  const hits = [
    { w: 10, words: ['дура', 'идиот', 'тупая', 'тупой', 'шлюха', 'козёл', 'мразь'] },
    { w: 7, words: ['ненавижу', 'убью', 'сдохни', 'заткнись', 'пошла', 'пошел'] },
    { w: 5, words: ['ты обязана', 'ты должна', 'мне плевать', 'сам виноват', 'сама виновата'] },
    { w: 4, words: ['никому не нужна', 'никому не нужен', 'все из-за тебя', 'не выдумывай'] },
  ];

  let score = 0;
  for (const group of hits) {
    for (const word of group.words) {
      if (t.includes(word)) score += group.w;
    }
  }

  const exclamations = (text.match(/!/g) ?? []).length;
  const caps = (text.match(/[A-ZА-ЯЁ]{3,}/g) ?? []).length;

  score += Math.min(exclamations, 10) * 1.2;
  score += Math.min(caps, 10) * 1.5;

  const lengthFactor = clamp(text.length / 800, 0.35, 1);
  const normalized = (score / (35 * lengthFactor)) * 100;
  return clamp(Math.round(normalized), 0, 100);
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

function extractDemoPhrase(aiText: string, toxicityPercent: number) {
  const firstLine = aiText.split('\n').map((s) => s.trim()).find(Boolean);
  if (firstLine) {
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
  }

  if (toxicityPercent >= 75) return 'Беги от него!';
  if (toxicityPercent >= 55) return 'Тут явно пахнет манипуляциями.';
  if (toxicityPercent >= 35) return 'Есть тревожные звоночки.';
  return 'Похоже на норм, но будь внимательнее.';
}

export default function App() {
  const [text, setText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isCreatingPayment, setIsCreatingPayment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);

  const toxicityPercent = useMemo(() => computeToxicityPercent(text), [text]);
  const aiText = useMemo(() => extractAiText(result?.result), [result]);
  const demoPhrase = useMemo(
    () => extractDemoPhrase(aiText, toxicityPercent),
    [aiText, toxicityPercent],
  );

  async function onAnalyze() {
    const trimmed = text.trim();
    if (!trimmed) {
      setError('Вставь переписку в поле, иначе сканировать нечего.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await axios.post<AnalyzeResponse>(
        '/api/analyze',
        { text: trimmed },
        { withCredentials: true },
      );
      setResult(response.data);
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const serverError = e.response?.data as unknown;
        if (
          typeof serverError === 'object' &&
          serverError !== null &&
          'error' in serverError &&
          typeof (serverError as { error?: unknown }).error === 'string'
        ) {
          setError((serverError as { error: string }).error);
          return;
        }
      }
      setError('Не удалось получить результат. Проверь сервер и попробуй ещё раз.');
    } finally {
      setIsLoading(false);
    }
  }

  async function onBuy() {
    if (!result) return;
    if (result.isPaid) return;

    setIsCreatingPayment(true);
    setError(null);

    try {
      const response = await axios.post<{ confirmationUrl: string }>(
        '/api/payment/create',
        { analysisId: result.id },
        { withCredentials: true },
      );

      const url = response.data?.confirmationUrl;
      if (typeof url !== 'string' || !url) {
        setError('Сервер не вернул ссылку на оплату. Попробуй ещё раз.');
        return;
      }

      window.location.assign(url);
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const serverError = e.response?.data as unknown;
        if (
          typeof serverError === 'object' &&
          serverError !== null &&
          'error' in serverError &&
          typeof (serverError as { error?: unknown }).error === 'string'
        ) {
          setError((serverError as { error: string }).error);
          return;
        }
      }
      setError('Не удалось создать оплату. Попробуй ещё раз.');
    } finally {
      setIsCreatingPayment(false);
    }
  }

  return (
    <div className="min-h-screen">
      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:py-14">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-red-500/90 to-fuchsia-500/80 shadow-neon" />
            <div>
              <div className="text-sm font-semibold tracking-wide text-zinc-100">
                RedFlag Scanner
              </div>
              <div className="text-xs text-zinc-400">Психо-скан переписок за 30 секунд</div>
            </div>
          </div>
          <div className="hidden sm:block text-xs text-zinc-500">
            Тёмная тема · Красные акценты · Неон
          </div>
        </header>

        <main className="mt-10 grid gap-8">
          <section className="rounded-3xl border border-white/10 bg-white/5 p-5 shadow-neon backdrop-blur sm:p-8">
            <div className="grid gap-4">
              <h1 className="text-balance text-2xl font-extrabold tracking-tight text-zinc-50 sm:text-4xl">
                Узнай, кто он(а) на самом деле.
              </h1>
              <p className="max-w-2xl text-sm leading-relaxed text-zinc-300 sm:text-base">
                Вставь переписку — мы найдём манипуляции, газлайтинг и прочие “ред флаги”.
              </p>

              <div className="mt-2 grid gap-4">
                <div className="relative">
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Вставь переписку сюда"
                    className="h-52 w-full resize-none rounded-2xl border border-white/10 bg-black/40 p-4 text-sm text-zinc-100 outline-none ring-0 placeholder:text-zinc-500 focus:border-fuchsia-400/40 focus:outline-none focus:ring-4 focus:ring-fuchsia-500/10 sm:h-60 sm:p-5 sm:text-base"
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 rounded-b-2xl bg-gradient-to-t from-black/60 to-transparent" />
                </div>

                <button
                  type="button"
                  onClick={onAnalyze}
                  disabled={isLoading}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-red-500 via-rose-500 to-fuchsia-500 px-5 py-4 text-sm font-extrabold tracking-wide text-white shadow-neon transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 sm:text-base"
                >
                  {isLoading ? 'Сканирую…' : 'Просканировать на Ред Флаги'}
                </button>

                {error ? (
                  <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                    {error}
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          {result ? (
            <section className="grid gap-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-zinc-200">Демо вердикт</div>
                    <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs text-zinc-300">
                      бесплатно
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="flex items-end justify-between">
                      <div className="text-xs text-zinc-400">Токсичность</div>
                      <div className="text-2xl font-extrabold text-zinc-50">{toxicityPercent}%</div>
                    </div>
                    <div className="mt-2 h-2 w-full rounded-full bg-white/10">
                      <div
                        className="h-2 rounded-full bg-gradient-to-r from-red-500 to-fuchsia-500"
                        style={{ width: `${toxicityPercent}%` }}
                      />
                    </div>
                    <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-zinc-100">
                      {demoPhrase}
                    </div>
                    <div className="mt-3 text-xs text-zinc-500">
                      Полный разбор ниже скрыт.
                    </div>
                  </div>
                </div>

                <div className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                  <div className="text-sm font-semibold text-zinc-200">Полный разбор</div>
                  <div className="mt-3 text-sm leading-relaxed text-zinc-300">
                    Мы уже получили полный анализ, но показываем его размытым.
                  </div>
                  <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-xs text-zinc-400">
                    Нажми кнопку поверх размытия, чтобы открыть полностью.
                  </div>
                </div>
              </div>

              <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-500/10 via-transparent to-red-500/10" />
                <div className="relative">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-zinc-200">Полный разбор</div>
                    <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs text-zinc-300">
                      скрыто
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4">
                    <div className="relative overflow-hidden rounded-2xl">
                      <div className="select-none whitespace-pre-wrap text-sm leading-relaxed text-zinc-100 blur-sm opacity-55">
                        {aiText || 'Ответ AI пришёл, но текст не удалось распарсить.'}
                      </div>
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

                      <div className="absolute inset-0 flex items-center justify-center px-4">
                        <button
                          type="button"
                          onClick={onBuy}
                          disabled={isCreatingPayment}
                          className="pointer-events-auto inline-flex w-full max-w-lg items-center justify-center rounded-2xl bg-gradient-to-r from-red-500 via-rose-500 to-fuchsia-500 px-5 py-4 text-sm font-extrabold tracking-wide text-white shadow-neon transition hover:brightness-110 sm:text-base"
                        >
                          {isCreatingPayment
                            ? 'Перенаправляю на оплату…'
                            : 'Открыть полный разбор + Совет психолога за 149₽'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          ) : null}
        </main>

        <footer className="mt-12 text-center text-xs text-zinc-500">
          Не храним переписки в браузере. Анализ идёт через API.
        </footer>
      </div>
    </div>
  );
}
