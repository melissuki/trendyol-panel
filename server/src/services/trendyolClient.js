import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { upstream } from '../lib/errors.js';

/**
 * Trendyol Entegrasyon API istemcisi.
 *
 * - Kimlik dogrulama: Basic base64(apiKey:apiSecret)
 * - User-Agent zorunludur: "{sellerId} - {entegrasyonEtiketi}"
 * - 429 (rate limit) ve 5xx yanitlarinda ustel geri cekilme (exponential backoff)
 * - Sayfali endpoint'ler icin otomatik sayfa dolasimi
 *
 * NOT: API anahtarlari SADECE burada kullanilir. Hicbir sekilde frontend'e
 * donen bir payload'a girmez.
 */

const basicToken = Buffer.from(`${env.TRENDYOL_API_KEY}:${env.TRENDYOL_API_SECRET}`).toString('base64');

const http = axios.create({
  baseURL: env.TRENDYOL_BASE_URL.replace(/\/+$/, ''),
  timeout: env.TRENDYOL_TIMEOUT_MS,
  headers: {
    Authorization: `Basic ${basicToken}`,
    'User-Agent': `${env.TRENDYOL_SELLER_ID} - ${env.TRENDYOL_INTEGRATION_TAG}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  // Trendyol bazi endpoint'lerde dizi parametreleri tekrarli key ile bekler
  paramsSerializer: {
    indexes: null,
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error) {
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') return true;
  const status = error.response?.status;
  if (!status) return true; // ag hatasi
  return status === 408 || status === 429 || status >= 500;
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED']);

function toAppError(error, context) {
  const status = error.response?.status;
  const body = error.response?.data;

  let message;
  if (status === 401 || status === 403) {
    message = 'Trendyol API kimlik doğrulaması başarısız. API Key / Secret / Satıcı ID değerlerini kontrol edin.';
  } else if (!status && NETWORK_CODES.has(error.code)) {
    // Yanit hic gelmedi: adres/ag sorunu. En sik sebep TRENDYOL_BASE_URL'in
    // yanlis (or. ayakta olmayan bir yerel mock) adrese bakiyor olmasidir.
    message =
      `Trendyol API'ye bağlanılamadı (${error.code}). ` +
      `İstek şu adrese gitti: ${http.defaults.baseURL}${context.url} — ` +
      `TRENDYOL_BASE_URL ayarını ve internet bağlantınızı kontrol edin.`;
  } else if (status >= 400 && status < 500) {
    message = `Trendyol API isteği reddedildi (${status} — ${context.method} ${context.url}). Gönderilen parametreleri kontrol edin.`;
  } else {
    message = `Trendyol API isteği başarısız (${context.method} ${context.url})`;
  }

  logger.error('trendyol request failed', {
    url: context.url,
    status: status ?? null,
    code: error.code ?? null,
    body: typeof body === 'string' ? body.slice(0, 500) : body,
  });

  return upstream(message, {
    status: status ?? null,
    code: error.code ?? null,
    baseUrl: http.defaults.baseURL,
    url: context.url,
    trendyol: typeof body === 'string' ? body.slice(0, 500) : body,
  });
}

async function request(config, attempt = 0) {
  const maxRetries = config.__maxRetries ?? env.TRENDYOL_MAX_RETRIES;
  try {
    const started = Date.now();
    const response = await http.request(config);
    logger.debug('trendyol request ok', {
      url: config.url,
      ms: Date.now() - started,
      page: config.params?.page,
    });
    return response;
  } catch (error) {
    if (!isRetryable(error) || attempt >= maxRetries) {
      throw toAppError(error, { url: config.url, method: (config.method ?? 'get').toUpperCase() });
    }

    const retryAfter = Number(error.response?.headers?.['retry-after']);
    const backoff = Number.isFinite(retryAfter)
      ? retryAfter * 1000
      : Math.min(1000 * 2 ** attempt, 15_000) + Math.floor(Math.random() * 300);

    logger.warn('trendyol retry', {
      url: config.url,
      attempt: attempt + 1,
      status: error.response?.status ?? null,
      waitMs: backoff,
    });

    await sleep(backoff);
    return request(config, attempt + 1);
  }
}

export function sellerPath(suffix) {
  return suffix.replace(':sellerId', encodeURIComponent(env.TRENDYOL_SELLER_ID));
}

export async function getJson(url, params = {}, { maxRetries } = {}) {
  const { data } = await request({ method: 'get', url, params, __maxRetries: maxRetries });
  return data;
}

/**
 * Sayfali endpoint'lerin tamamini toplar.
 * Trendyol yanit sozlesmesi: { page, size, totalPages, totalElements, content: [] }
 */
/**
 * `size` ust siniri UC NOKTAYA GORE DEGISIR:
 *   - order/claims : en fazla 200
 *   - finance/che  : SADECE 500 ya da 1000 kabul edilir (baska deger -> HTTP 400
 *                    "Size değeri 500 ya da 1000 olmalıdır")
 *
 * Bu yuzden tek bir global sinirla kirpmak mutabakat cagrilarini komple
 * kiriyordu. Sinir artik cagri basina `maxSize` ile veriliyor.
 */
const DEFAULT_MAX_PAGE_SIZE = 200;

export async function fetchAllPages(
  url,
  params = {},
  {
    size = DEFAULT_MAX_PAGE_SIZE,
    maxSize = DEFAULT_MAX_PAGE_SIZE,
    maxPages = 400,
    contentKey = 'content',
    allowedSizes = null,
    maxRetries = undefined,
  } = {},
) {
  // Uc nokta yalnizca belirli boyutlari kabul ediyorsa en yakin gecerli degere yuvarla
  const pageSize = allowedSizes
    ? (allowedSizes.includes(size) ? size : allowedSizes[0])
    : Math.min(Math.max(1, Math.trunc(size)), maxSize);
  const items = [];
  let page = 0;
  let totalPages = 1;
  let totalElements = null;

  do {
    const data = await getJson(url, { ...params, page, size: pageSize }, { maxRetries });
    const content = Array.isArray(data?.[contentKey]) ? data[contentKey] : [];
    items.push(...content);

    totalPages = Number.isFinite(data?.totalPages) ? data.totalPages : 1;
    totalElements = Number.isFinite(data?.totalElements) ? data.totalElements : totalElements;
    page += 1;

    if (content.length === 0) break;
  } while (page < totalPages && page < maxPages);

  if (page >= maxPages) {
    logger.warn('trendyol pagination guard hit', { url, maxPages, totalPages });
  }

  return { items, totalElements: totalElements ?? items.length, pages: page };
}

/** Basit erisim testi - /api/health icin */
export async function pingTrendyol() {
  const url = sellerPath('/order/sellers/:sellerId/orders');
  const now = Date.now();
  await getJson(url, { startDate: now - 60 * 60 * 1000, endDate: now, page: 0, size: 1 });
  return true;
}
