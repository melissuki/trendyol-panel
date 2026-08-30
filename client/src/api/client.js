/**
 * API TABAN ADRESI
 * -----------------------------------------------------------------------------
 * Uretimde (Vercel) frontend ve API AYNI alan adinda calisir; bu yuzden taban
 * adres BOS birakilir ve istekler "/api/..." seklinde GORECELI gider.
 *
 * VITE_API_BASE_URL tanimli degilse:
 *   - tarayicida  -> '' (ayni alan adi; Vercel dagitimi icin dogru olan budur)
 *   - aksi halde  -> http://localhost:4000 (yerel gelistirme)
 *
 * Onceden burada kosulsuz 'http://localhost:4000' varsayilani vardi: Vercel'e
 * cikildiginda tarayici localhost'a istek atiyor ve "Sunucuya ulasilamadi"
 * hatasi veriyordu.
 */
const RAW_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:4000');

const BASE_URL = String(RAW_BASE_URL).replace(/\/+$/, '');

/**
 * OTURUM JETONU
 * sessionStorage kullaniyoruz: sekme kapaninca jeton dusuyor. localStorage'a
 * gore daha dar bir pencere sunar ve ortak kullanilan bilgisayarlarda oturumun
 * acik kalmasini onler.
 *
 * NOT: Trendyol API anahtarlari tarayiciya HICBIR SEKILDE gelmez; burada
 * tutulan tek sey backend'in urettigi kisa omurlu JWT'dir.
 */
const TOKEN_KEY = 'ty.session';

let memoryToken = null;
const listeners = new Set();

export function getToken() {
  if (memoryToken) return memoryToken;
  try {
    memoryToken = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    memoryToken = null; // gizli sekme / depolama kapali
  }
  return memoryToken;
}

export function setToken(token) {
  memoryToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* depolama yoksa yalnizca bellekte tut */
  }
}

/** Oturum düştüğünde (401) haberdar olmak için. */
export function onUnauthorized(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyUnauthorized() {
  setToken(null);
  listeners.forEach((listener) => listener());
}

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function buildUrl(path, params = {}) {
  /**
   * BASE_URL bos oldugunda `new URL('/api/...')` "Invalid URL" firlatir; bu
   * yuzden goreceli adreslerde sayfanin kendi kokunu taban aliyoruz.
   */
  const url = BASE_URL
    ? new URL(`${BASE_URL}${path}`)
    : new URL(path, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  return url.toString();
}

function authHeaders(extra = {}) {
  const token = getToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function toApiError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* gövde JSON değilse yok say */
  }
  const message =
    payload?.error?.message ??
    (response.status === 429
      ? 'Çok fazla istek gönderildi. Lütfen birkaç saniye sonra tekrar deneyin.'
      : `Sunucu hatası (${response.status})`);
  return new ApiError(message, {
    status: response.status,
    code: payload?.error?.code,
    details: payload?.error?.details,
  });
}

/** 401 gelirse oturumu düşür ve giriş ekranına dönülmesini tetikle. */
async function handleResponse(response) {
  if (response.status === 401) {
    notifyUnauthorized();
    throw await toApiError(response);
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

async function getJson(path, params, { signal } = {}) {
  let response;
  try {
    response = await fetch(buildUrl(path, params), {
      signal,
      headers: authHeaders({ Accept: 'application/json' }),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Sunucuya ulaşılamadı. Backend çalışıyor mu?', { status: 0 });
  }
  await handleResponse(response);
  return response.json();
}

// ---------------------------------------------------------------------------
// KIMLIK DOGRULAMA
// ---------------------------------------------------------------------------

export async function login({ username, password }) {
  let response;
  try {
    response = await fetch(buildUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new ApiError('Sunucuya ulaşılamadı. Backend çalışıyor mu?', { status: 0 });
  }
  // Giris ekraninda 401, "oturum dustu" degil "parola yanlis" demektir;
  // bu yuzden notifyUnauthorized tetiklenmemeli.
  if (!response.ok) throw await toApiError(response);

  const data = await response.json();
  setToken(data.token);
  return data;
}

export async function logout() {
  try {
    await fetch(buildUrl('/api/auth/logout'), { method: 'POST', headers: authHeaders() });
  } catch {
    /* çıkışta ağ hatası önemli değil; jeton yine de silinir */
  }
  setToken(null);
}

export const fetchAuthStatus = () => getJson('/api/auth/status');

/** Sayfa yenilendiğinde mevcut jetonun hâlâ geçerli olduğunu doğrular. */
export const fetchMe = (options) => getJson('/api/auth/me', undefined, options);

// ---------------------------------------------------------------------------
// VERI
// ---------------------------------------------------------------------------

/** Aralıkta satılan ürünler (ana ürün bazında gruplu, varyantlar iç içe) */
export const fetchProducts = ({ startDate, endDate }, options) =>
  getJson('/api/products', { startDate, endDate }, options);

/** Bir ürünün/varyantın gün gün detayı (ekran önizlemesi) */
export const fetchProductDaily = ({ barcode, parentKey, startDate, endDate }, options) =>
  getJson('/api/products/daily', { barcode, parentKey, startDate, endDate }, options);

/**
 * Excel raporunu indirir.
 * Doğrudan <a href> yerine fetch kullanıyoruz: hem Authorization başlığını
 * gönderebiliyoruz hem de hata gövdesini okuyup Türkçe mesaj gösterebiliyoruz.
 */
export async function downloadProductReport({ barcode, parentKey, startDate, endDate }) {
  const url = buildUrl('/api/reports/product.xlsx', { barcode, parentKey, startDate, endDate });

  let response;
  try {
    response = await fetch(url, { headers: authHeaders() });
  } catch {
    throw new ApiError('Sunucuya ulaşılamadı. Backend çalışıyor mu?', { status: 0 });
  }
  await handleResponse(response);

  const blob = await response.blob();
  const fallbackName = `trendyol-rapor-${barcode || parentKey || 'urun'}.xlsx`;
  const fileName = parseFileName(response.headers.get('Content-Disposition')) ?? fallbackName;

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Safari'nin indirmeyi başlatmasına zaman tanı
  setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);

  return { fileName, size: blob.size };
}

/** Content-Disposition başlığından dosya adını çözer (UTF-8 filename* öncelikli). */
export function parseFileName(header) {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* bozuk kodlama - ascii'ye düş */
    }
  }
  const ascii = /filename="?([^";]+)"?/i.exec(header);
  return ascii?.[1] ?? null;
}
