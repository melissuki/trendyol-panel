import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Cok basit TTL cache. Urun listesi ve Excel export'u ayni tarih araligi icin
 * ayni siparis/iade verisini kullanir; ikinci istekte Trendyol'u tekrar
 * yormamak icin bellekte tutuyoruz. Tek instance icin yeterli;
 * yatay olceklemede Redis'e tasiyin.
 */
const store = new Map();
const inflight = new Map();

export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

export function cacheSet(key, value, ttlSeconds = env.CACHE_TTL_SECONDS) {
  if (ttlSeconds <= 0) return value;
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  return value;
}

/**
 * Ayni anahtar icin paralel gelen istekleri tek upstream cagrisinda birlestirir.
 */
export async function cached(key, producer, ttlSeconds = env.CACHE_TTL_SECONDS) {
  const hit = cacheGet(key);
  if (hit !== undefined) {
    logger.debug('cache hit', { key });
    return hit;
  }
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const value = await producer();
      cacheSet(key, value, ttlSeconds);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export function cacheClear() {
  const size = store.size;
  store.clear();
  return size;
}
