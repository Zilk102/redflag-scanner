const axios = require('axios');

const DEFAULT_SYSTEM_PROMPT =
  'Ты — токсичный, но проницательный эксперт по отношениям. Твой стиль: стендап-комик + психолог. Ты используешь сленг (ред флаг, кринж, газлайтинг, душнила). Ты НЕНАВИДИШЬ скучные отношения.\n\nТвоя задача: проанализировать текст переписки и вытащить всю токсичную механику: манипуляции, контроль, обесценивание, газлайтинг, эмоциональные качели, пассивную агрессию, ревность, давление, шантаж, двойные стандарты, вину и стыд.\n\nОтветь ТОЛЬКО валидным JSON-объектом без пояснений, без markdown и без любого дополнительного текста. Строго по схеме:\n{\n  "rating": 0-100,\n  "short_verdict": "Короткая, хлёсткая фраза (до 5 слов) для заголовка.",\n  "teaser": "Интригующее описание проблемы (2 предложения), которое обрывается на самом интересном...",\n  "full_analysis": "Длинный, детальный разбор всех манипуляций (минимум 3 абзаца).",\n  "advice": "Конкретный совет, что делать (бросать/терпеть)."\n}\n\nПравила: rating — целое 0..100 (100 = беги от него, 0 = святой человек). teaser — ровно 2 предложения, второе обрывается и заканчивается на многоточие. full_analysis — минимум 3 абзаца.';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildModelUri(folderId) {
  return `gpt://${folderId}/yandexgpt/latest`;
}

function getAuthHeaderValue() {
  const apiKey = process.env.YANDEX_API_KEY;
  const cloudApiKey = process.env.YANDEX_CLOUD_API_KEY;
  const iamToken = process.env.YANDEX_IAM_TOKEN;

  if (apiKey) return `Api-Key ${apiKey}`;
  if (cloudApiKey) return `Api-Key ${cloudApiKey}`;
  if (iamToken) return `Bearer ${iamToken}`;
  return null;
}

class YandexGPTService {
  constructor(options = {}) {
    this.url =
      options.url ||
      process.env.YANDEX_GPT_API_URL ||
      'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';
    this.folderId = options.folderId || process.env.YANDEX_FOLDER_ID;
    this.temperature =
      typeof options.temperature === 'number'
        ? options.temperature
        : Number(process.env.YANDEX_GPT_TEMPERATURE ?? '0.2');
    this.maxTokens =
      typeof options.maxTokens === 'number'
        ? options.maxTokens
        : Number(process.env.YANDEX_GPT_MAX_TOKENS ?? '2000');
    this.timeoutMs =
      typeof options.timeoutMs === 'number'
        ? options.timeoutMs
        : Number(process.env.YANDEX_GPT_TIMEOUT_MS ?? '30000');
    this.maxRetries =
      typeof options.maxRetries === 'number'
        ? options.maxRetries
        : Number(process.env.YANDEX_GPT_MAX_RETRIES ?? '2');
  }

  async analyzeText(text) {
    try {
      if (!this.folderId) {
        throw new Error('YANDEX_FOLDER_ID не задан');
      }

      const authValue = getAuthHeaderValue();
      if (!authValue) {
        throw new Error('Не задан YANDEX_API_KEY, YANDEX_CLOUD_API_KEY или YANDEX_IAM_TOKEN');
      }

      const payload = {
        modelUri: buildModelUri(this.folderId),
        completionOptions: {
          stream: false,
          temperature: this.temperature,
          maxTokens: String(this.maxTokens),
        },
        messages: [
          { role: 'system', text: DEFAULT_SYSTEM_PROMPT },
          { role: 'user', text },
        ],
      };

      const headers = {
        'Content-Type': 'application/json',
        Authorization: authValue,
        'x-folder-id': this.folderId,
        'x-data-logging-enabled': 'false',
      };

      return await this.#postWithRetry(this.url, payload, headers);
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        return {
          result: {
            alternatives: [
              {
                message: {
                  role: 'assistant',
                  text: JSON.stringify({
                    rating: 50,
                    short_verdict: 'Сомнительный вайб, но без паники',
                    teaser:
                      'YandexGPT сейчас недоступен. Но если бы он был, он бы уже нашёл тут пару странных моментов…',
                    full_analysis:
                      'YandexGPT временно недоступен/вернул ошибку.\n\nЭто ответ в режиме разработки, чтобы не ломать UI.\n\nПроверь переменные окружения и доступ к foundationModels API.',
                    advice:
                      'Проверь YANDEX_FOLDER_ID и ключ/токен. Если проблема повторяется — скорее бросать, чем терпеть.',
                  }),
                },
                status: 'ALTERNATIVE_STATUS_FINAL',
              },
            ],
          },
          _mock: true,
          _error: err?.message ?? String(err),
        };
      }

      throw err;
    }
  }

  async scan(text) {
    const completion = await this.analyzeText(text);
    const aiText = this.#extractAssistantText(completion);
    const parsed = this.#parseJsonObject(aiText);
    if (parsed) return parsed;

    if (process.env.NODE_ENV === 'development') {
      return {
        rating: 50,
        short_verdict: 'Модель дала кринж-формат',
        teaser:
          'Ответ от YandexGPT пришёл, но формат поплыл. И вот это уже выглядит как ред флаг…',
        full_analysis:
          'Ответ от YandexGPT пришёл, но не удалось распарсить JSON.\n\nПроверь промпт/температуру и убедись, что модель отвечает строго JSON.\n\nЕсли в ответе появляется лишний текст, подними строгость инструкции и снизь temperature.',
        advice: 'Снизь temperature и попроси ответ в одну строку JSON без переносов. Скорее терпеть нельзя, чем можно.',
      };
    }

    throw new Error('YandexGPT вернул ответ не в формате JSON');
  }

  #extractAssistantText(completion) {
    const candidates = [
      completion?.result?.alternatives?.[0]?.message?.text,
      completion?.alternatives?.[0]?.message?.text,
    ];

    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }

    return '';
  }

  #parseJsonObject(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    const direct = this.#tryParseJson(trimmed);
    if (direct) return direct;

    let cursor = 0;
    while (cursor < trimmed.length) {
      const start = trimmed.indexOf('{', cursor);
      if (start === -1) return null;

      const sliced = this.#sliceBalancedJsonObject(trimmed, start);
      if (sliced) {
        const parsed = this.#tryParseJson(sliced);
        if (parsed) return parsed;
      }

      cursor = start + 1;
    }

    return null;
  }

  #sliceBalancedJsonObject(text, startIndex) {
    if (typeof text !== 'string') return null;
    if (text[startIndex] !== '{') return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i += 1) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (ch === '\\') {
          escaped = true;
          continue;
        }

        if (ch === '"') {
          inString = false;
        }

        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        depth += 1;
        continue;
      }

      if (ch === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(startIndex, i + 1);
        if (depth < 0) return null;
      }
    }

    return null;
  }

  #tryParseJson(value) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null) return null;

      const ratingValue = parsed.rating ?? parsed.score;
      const rating = Number(ratingValue);

      const shortVerdictValue = parsed.short_verdict ?? parsed.verdict;
      const shortVerdict = typeof shortVerdictValue === 'string' ? shortVerdictValue : null;

      const teaserValue = parsed.teaser;
      const teaser = typeof teaserValue === 'string' ? teaserValue : null;

      const fullAnalysisValue = parsed.full_analysis ?? parsed.analysis;
      const fullAnalysis = typeof fullAnalysisValue === 'string' ? fullAnalysisValue : null;

      const adviceValue = parsed.advice;
      const advice = typeof adviceValue === 'string' ? adviceValue : null;

      if (!Number.isFinite(rating)) return null;
      if (!shortVerdict || !fullAnalysis || !advice) return null;

      const normalizedFull = fullAnalysis.trim();
      const derivedTeaser = this.#deriveTeaser(normalizedFull);

      return {
        rating: Math.max(0, Math.min(100, Math.round(rating))),
        short_verdict: shortVerdict.trim(),
        teaser: (teaser ?? derivedTeaser).trim(),
        full_analysis: normalizedFull,
        advice: advice.trim(),
      };
    } catch {
      return null;
    }
  }

  #deriveTeaser(fullAnalysis) {
    if (typeof fullAnalysis !== 'string' || !fullAnalysis.trim()) return 'Есть проблема. И она только начинается…';

    const text = fullAnalysis
      .replace(/\s+/g, ' ')
      .trim();

    const sentences = text
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const firstTwo = sentences.slice(0, 2).join(' ');
    if (!firstTwo) return 'Есть проблема. И она только начинается…';

    const maxLen = 260;
    const clipped = firstTwo.length > maxLen ? `${firstTwo.slice(0, maxLen - 1).trim()}…` : firstTwo;
    if (/[.…]$/.test(clipped)) return clipped;
    return `${clipped}…`;
  }

  async #postWithRetry(url, payload, headers) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await axios.post(url, payload, {
          headers,
          timeout: this.timeoutMs,
          validateStatus: () => true,
        });

        if (response.status >= 200 && response.status < 300) {
          return response.data;
        }

        if (response.status === 404 && url.endsWith('.')) {
          url = url.slice(0, -1);
          continue;
        }

        const retryable =
          response.status === 429 ||
          (response.status >= 500 && response.status <= 599);

        if (!retryable || attempt >= this.maxRetries) {
          const details =
            typeof response.data === 'string'
              ? response.data
              : JSON.stringify(response.data);
          throw new Error(`YandexGPT ошибка ${response.status}: ${details}`);
        }

        const backoffMs = 500 * Math.pow(2, attempt);
        await sleep(backoffMs);
      } catch (err) {
        lastError = err;

        const isAxios = Boolean(err?.isAxiosError);
        if (!isAxios || attempt >= this.maxRetries) {
          throw err;
        }

        const backoffMs = 500 * Math.pow(2, attempt);
        await sleep(backoffMs);
      }
    }

    throw lastError ?? new Error('Не удалось получить ответ от YandexGPT');
  }
}

module.exports = {
  YandexGPTService,
};
