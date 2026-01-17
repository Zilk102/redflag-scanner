const axios = require('axios');

const DEFAULT_SYSTEM_PROMPT =
  'Ты опытный психолог и эксперт по отношениям. Твоя задача — проанализировать переписку на предмет манипуляций, токсичности и красных флагов. Отвечай жестко, с юмором, используй сленг (ред флаг, газлайтинг).';

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
      'x-data-logging-enabled': 'false',
    };

    return await this.#postWithRetry(this.url, payload, headers);
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
