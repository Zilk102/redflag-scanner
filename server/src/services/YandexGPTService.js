const axios = require('axios');

const DEFAULT_SYSTEM_PROMPT =
  'Ты — токсичный, но проницательный эксперт по отношениям. Стиль: стендап-комик + психолог. Сленг допустим (ред флаг, кринж, газлайтинг), но без оскорблений пользователя.\n\nЗадача: проанализировать переписку и найти токсичные паттерны: манипуляции, контроль, обесценивание, газлайтинг, эмоциональные качели, пассивную агрессию, ревность, давление, шантаж, двойные стандарты, вину и стыд.\n\nВажно про rating: rating — это УРОВЕНЬ ОПАСНОСТИ/ТОКСИЧНОСТИ (риск) по шкале 0..100, где 0 = всё хорошо, токсичных паттернов нет; 100 = крайне токсично, нужно срочно выходить из общения.\n\nВерни ТОЛЬКО валидный JSON-объект (без markdown, без пояснений, без префиксов/суффиксов текста). Схема строгая:\n{\n  "rating": 0-100,\n  "short_verdict": "до 5 слов, ударная фраза для заголовка",\n  "teaser": "ровно 2 предложения, второе заканчивается на …",\n  "full_analysis": "минимум 3 абзаца, подробный разбор",\n  "advice": "что делать дальше, конкретно",\n  "flags": [\n    {\n      "category": "строка: категория (например: газлайтинг/контроль/обесценивание)",\n      "severity": 0-100,\n      "quote": "короткая цитата из переписки (дословно)",\n      "explanation": "почему это ред флаг",\n      "what_to_reply": "короткий пример ответа пользователю"\n    }\n  ]\n}\n\nПравила: rating — целое 0..100. Если rating <= 20, тогда flags MUST быть пустым массивом [] и в short_verdict/teaser нельзя пугать. Если rating >= 70, то short_verdict должен явно предупреждать. teaser — ровно 2 предложения, второе обрывается и заканчивается на … . flags: 0..12 элементов (0 только когда ред флагов нет), severity — целое 0..100, quote — максимально дословно. Поля обязательные.';

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

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTrimmedString(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

function toIntInRange(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < min || i > max) return null;
  return i;
}

function normalizeFlags(flagsRaw) {
  if (!Array.isArray(flagsRaw)) return [];

  const out = [];
  for (const item of flagsRaw) {
    if (!isPlainObject(item)) continue;
    const category = toTrimmedString(item.category);
    const severity = toIntInRange(item.severity, 0, 100);
    const quote = toTrimmedString(item.quote) ?? '';
    const explanation = toTrimmedString(item.explanation) ?? '';
    const whatToReply = toTrimmedString(item.what_to_reply) ?? '';

    if (!category || severity === null) continue;

    out.push({
      category,
      severity,
      quote,
      explanation,
      what_to_reply: whatToReply,
    });
  }

  return out.slice(0, 12);
}

function normalizeScanVerdict(obj) {
  if (!isPlainObject(obj)) return null;

  const rating = toIntInRange(obj.rating ?? obj.score, 0, 100);
  const shortVerdict = toTrimmedString(obj.short_verdict ?? obj.verdict);
  const teaser = toTrimmedString(obj.teaser);
  const fullAnalysis = toTrimmedString(obj.full_analysis ?? obj.analysis);
  const advice = toTrimmedString(obj.advice);
  const flags = normalizeFlags(obj.flags);

  if (rating === null) return null;
  if (!shortVerdict || !teaser || !fullAnalysis || !advice) return null;

  return {
    rating,
    short_verdict: shortVerdict,
    teaser,
    full_analysis: fullAnalysis,
    advice,
    flags,
  };
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

    this.failureThreshold =
      typeof options.failureThreshold === 'number'
        ? options.failureThreshold
        : Number(process.env.YANDEX_GPT_CB_FAILURES ?? '5');
    this.openMs =
      typeof options.openMs === 'number'
        ? options.openMs
        : Number(process.env.YANDEX_GPT_CB_OPEN_MS ?? '30000');
    this.maxConcurrent =
      typeof options.maxConcurrent === 'number'
        ? options.maxConcurrent
        : Number(process.env.YANDEX_GPT_MAX_CONCURRENT ?? '2');
    this.minIntervalMs =
      typeof options.minIntervalMs === 'number'
        ? options.minIntervalMs
        : Number(process.env.YANDEX_GPT_MIN_INTERVAL_MS ?? '0');

    this._semActive = 0;
    this._semQueue = [];
    this._circuitOpenUntil = 0;
    this._circuitFailures = 0;
    this._lastRequestAt = 0;
  }

  async analyzeText(text) {
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
  }

  async scan(text) {
    const completion = await this.analyzeText(text);
    const aiText = this.#extractAssistantText(completion);
    const parsed = this.#parseJsonObject(aiText);
    const normalized = normalizeScanVerdict(parsed);
    if (normalized) return normalized;

    throw new Error('YandexGPT вернул ответ не по схеме');
  }

  async askAboutScan({ text, result, question }) {
    if (!this.folderId) {
      throw new Error('YANDEX_FOLDER_ID не задан');
    }

    const authValue = getAuthHeaderValue();
    if (!authValue) {
      throw new Error('Не задан YANDEX_API_KEY, YANDEX_CLOUD_API_KEY или YANDEX_IAM_TOKEN');
    }

    const system =
      'Ты — ассистент RedFlag Scanner. Отвечай по делу, коротко и практично.\n\nПравила: верни ТОЛЬКО JSON без markdown и без лишнего текста: {"answer":"..."}. answer — 2-8 предложений, конкретно, без морализаторства.';

    const context =
      `Переписка:\n${text}\n\nРезультат анализа (JSON):\n${JSON.stringify(result ?? {}, null, 0)}\n\nВопрос пользователя:\n${question}`;

    const payload = {
      modelUri: buildModelUri(this.folderId),
      completionOptions: {
        stream: false,
        temperature: Math.max(0, Math.min(1, this.temperature)),
        maxTokens: String(Math.min(Number(this.maxTokens) || 2000, 1200)),
      },
      messages: [
        { role: 'system', text: system },
        { role: 'user', text: context },
      ],
    };

    const headers = {
      'Content-Type': 'application/json',
      Authorization: authValue,
      'x-folder-id': this.folderId,
      'x-data-logging-enabled': 'false',
    };

    const completion = await this.#postWithRetry(this.url, payload, headers);
    const aiText = this.#extractAssistantText(completion);
    const parsed = this.#parseJsonObject(aiText);
    const answer = isPlainObject(parsed) ? toTrimmedString(parsed.answer) : null;
    if (answer) {
      return { answer };
    }

    throw new Error('YandexGPT вернул ответ не по схеме');
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
      if (!isPlainObject(parsed)) return null;

      const normalized = normalizeScanVerdict(parsed);
      if (normalized) return normalized;

      const answer = toTrimmedString(parsed.answer);
      if (answer) return { answer };

      return null;
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

  #assertCircuitClosed() {
    const now = Date.now();
    const openUntil = Number(this._circuitOpenUntil ?? 0);
    if (openUntil > now) {
      const err = new Error('YandexGPT временно недоступен');
      err.statusCode = 503;
      throw err;
    }
  }

  #recordSuccess() {
    this._circuitFailures = 0;
    this._circuitOpenUntil = 0;
  }

  #recordFailure() {
    const failures = Number(this._circuitFailures ?? 0) + 1;
    this._circuitFailures = failures;

    const threshold = Number(this.failureThreshold ?? 0);
    const openMs = Number(this.openMs ?? 0);
    if (threshold > 0 && failures >= threshold && openMs > 0) {
      this._circuitOpenUntil = Date.now() + openMs;
    }
  }

  async #acquireSemaphore() {
    const limit = Number(this.maxConcurrent ?? 1);
    const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;

    const release = () => {
      this._semActive = Math.max(0, Number(this._semActive ?? 0) - 1);
      const next = Array.isArray(this._semQueue) ? this._semQueue.shift() : null;
      if (typeof next === 'function') next();
    };

    const active = Number(this._semActive ?? 0);
    if (active < safeLimit) {
      this._semActive = active + 1;
      return release;
    }

    await new Promise((resolve) => {
      if (!Array.isArray(this._semQueue)) this._semQueue = [];
      this._semQueue.push(resolve);
    });

    this._semActive = Number(this._semActive ?? 0) + 1;
    return release;
  }

  async #throttle() {
    const min = Number(this.minIntervalMs ?? 0);
    if (!Number.isFinite(min) || min <= 0) return;
    const now = Date.now();
    const last = Number(this._lastRequestAt ?? 0);
    const waitMs = last > 0 ? last + min - now : 0;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this._lastRequestAt = Date.now();
  }

  async #postWithRetry(url, payload, headers) {
    this.#assertCircuitClosed();

    const release = await this.#acquireSemaphore();
    try {
      let lastError;

      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        this.#assertCircuitClosed();
        await this.#throttle();

        try {
          const response = await axios.post(url, payload, {
            headers,
            timeout: this.timeoutMs,
            validateStatus: () => true,
          });

          if (response.status >= 200 && response.status < 300) {
            this.#recordSuccess();
            return response.data;
          }

          if (response.status === 404 && url.endsWith('.')) {
            url = url.slice(0, -1);
            continue;
          }

          const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);

          if (!retryable || attempt >= this.maxRetries) {
            const details = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            const e = new Error(`YandexGPT ошибка ${response.status}: ${details}`);
            e.statusCode = response.status >= 400 && response.status < 600 ? response.status : 502;
            throw e;
          }

          const backoffMs = 500 * Math.pow(2, attempt);
          await sleep(backoffMs);
        } catch (err) {
          lastError = err;

          const isAxios = Boolean(err?.isAxiosError);
          if (!isAxios || attempt >= this.maxRetries) {
            this.#recordFailure();
            throw err;
          }

          const backoffMs = 500 * Math.pow(2, attempt);
          await sleep(backoffMs);
        }
      }

      this.#recordFailure();
      throw lastError ?? new Error('Не удалось получить ответ от YandexGPT');
    } finally {
      release();
    }
  }
}

module.exports = {
  YandexGPTService,
};
