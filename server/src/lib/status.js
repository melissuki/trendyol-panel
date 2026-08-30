/**
 * STATU NORMALIZASYONU VE SINIFLANDIRMA
 * =============================================================================
 * Trendyol ayni statuyu hesaptan hesaba, hatta uc noktadan uc noktaya farkli
 * yazabiliyor: Ingilizce/Turkce karisik, farkli buyuk-kucuk harf, bosluk,
 * alt tire, Turkce karakter (İ/ı/ş/ğ/ü/ö/ç).
 *
 * Bu dosya TEK normalizasyon noktasidir. Ham deger her zaman saklanir ve
 * raporda gosterilir; siniflandirma yalnizca normalize edilmis deger uzerinden
 * yapilir. Boylece "İade Edildi", "iade edildi", "IADE_EDILDI" ve "Returned"
 * ayni kovaya duser.
 */

/**
 * Turkce'ye duyarli kucultme.
 * DIKKAT: JS'in varsayilan toLowerCase()'i 'I' -> 'i' yapar ama Turkce'de
 * 'I' -> 'ı'dir. Once Turkce'ye ozgu harfleri elle esliyoruz, sonra ASCII'ye
 * indirgiyoruz; boylece "İptal", "IPTAL", "iptal" hepsi "iptal" olur.
 */
const TR_MAP = {
  İ: 'i', I: 'i', ı: 'i',
  Ş: 's', ş: 's',
  Ğ: 'g', ğ: 'g',
  Ü: 'u', ü: 'u',
  Ö: 'o', ö: 'o',
  Ç: 'c', ç: 'c',
  Â: 'a', â: 'a',
};

/**
 * Ham statuyu karsilastirilabilir bir anahtara cevirir.
 *   "  İade   Edildi " -> "iadeedildi"
 *   "UnDeliveredAndReturned" -> "undeliveredandreturned"
 *   "CANCELLED_BY_CUSTOMER" -> "cancelledbycustomer"
 */
export function normalizeStatus(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'object') {
    // { name: "Accepted" } gibi obje statuleri
    text = String(value.name ?? value.status ?? value.value ?? '');
  }
  return text
    .replace(/[İIıŞşĞğÜüÖöÇçÂâ]/g, (ch) => TR_MAP[ch] ?? ch)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // birlesik aksanlari at
    .replace(/[^a-z0-9]/g, '');      // bosluk, alt tire, tire, nokta...
}

/** Normalize edilmis deger, listedeki kaliplardan biriyle basliyor mu? */
const startsWithAny = (normalized, patterns) =>
  Boolean(normalized) && patterns.some((p) => normalized.startsWith(p));

const includesAny = (normalized, patterns) =>
  Boolean(normalized) && patterns.some((p) => normalized.includes(p));

// ---------------------------------------------------------------------------
// SIPARIS SATIRI STATULERI  (orderLineItemStatusName)
// ---------------------------------------------------------------------------

/**
 * IPTAL kaliplari. Canli hesapta gorulen: "Cancelled".
 * Turkce/varyant ihtimallerine karsi genis tutuldu.
 */
const CANCELLED_PATTERNS = ['cancelled', 'canceled', 'cancel', 'iptal'];

/** Tedarik edilemeyen: iptal DEGILDIR, ayri kovada raporlanir. */
const UNSUPPLIED_PATTERNS = ['unsupplied', 'tedarikedilemedi', 'tedarikedilemeyen'];

/**
 * Teslim edilemeyip geri donen satirlar.
 * IADE SAYILMAZ - Trendyol Satici Paneli de bunlari "İade" sayacina katmiyor.
 * Ayri bir kovada raporlanir (bkz. claimsService `undeliveredNoClaim`).
 */
const UNDELIVERED_PATTERNS = ['undelivered', 'teslimedilemedi', 'teslimedilemeyen'];

/** Basarili/aktif satir statuleri - bilgi amacli. */
const ACTIVE_PATTERNS = [
  'delivered', 'shipped', 'readytoship', 'picking', 'created', 'invoiced',
  'awaiting', 'atcollectionpoint', 'teslimedildi', 'kargoyaverildi',
];

export const isCancelledLineStatus = (raw) => {
  const n = normalizeStatus(raw);
  // "undeliveredandreturned" icinde "cancel" gecmez; yine de once iptal-disi
  // kaliplari eleyelim ki yanlis eslesme olmasin.
  if (startsWithAny(n, UNDELIVERED_PATTERNS)) return false;
  return startsWithAny(n, CANCELLED_PATTERNS) || includesAny(n, ['iptal']);
};

export const isUnsuppliedLineStatus = (raw) => startsWithAny(normalizeStatus(raw), UNSUPPLIED_PATTERNS);

export const isUndeliveredLineStatus = (raw) => {
  const n = normalizeStatus(raw);
  return startsWithAny(n, UNDELIVERED_PATTERNS) || n === 'undeliveredandreturned';
};

export const isActiveLineStatus = (raw) => startsWithAny(normalizeStatus(raw), ACTIVE_PATTERNS);

/** Satir statusunu tek kelimede siniflar - teshis ciktilari icin. */
export function classifyLineStatus(raw) {
  if (isCancelledLineStatus(raw)) return 'CANCELLED';
  if (isUnsuppliedLineStatus(raw)) return 'UNSUPPLIED';
  if (isUndeliveredLineStatus(raw)) return 'UNDELIVERED';
  if (isActiveLineStatus(raw)) return 'ACTIVE';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// IADE TALEBI (CLAIM) STATULERI
// ---------------------------------------------------------------------------

/**
 * IADE SAYILMAYANLAR - YALNIZCA bunlar dislanir.
 * Canli hesapta gorulen: "Rejected", "Cancelled".
 */
const CLAIM_REJECTED_PATTERNS = [
  'rejected', 'denied', 'refused', 'reddedildi', 'reddedilen', 'red',
  'cancelled', 'canceled', 'iptal', 'iptaledildi',
];

/** Onaylanmis iade - tutar kesinlesmistir. */
const CLAIM_ACCEPTED_PATTERNS = [
  'accepted', 'approved', 'completed',
  'onaylandi', 'onayli', 'kabuledildi', 'tamamlandi',
  'iadeedildi', 'iadeonaylandi', 'iadetamamlandi', 'iadealindi',
];

/**
 * Sureci devam eden iade. Canli hesapta gorulen:
 * "Created", "WaitingInAction", ayrica "Inspection"/"Inspecting" gecebiliyor.
 */
const CLAIM_IN_PROGRESS_PATTERNS = [
  'created', 'waiting', 'waitinginaction', 'inaction', 'inspect', 'inspection',
  'inspecting', 'pending', 'processing', 'inprogress', 'olusturuldu', 'beklemede',
  'incelemede', 'islemde',
];

export const isRejectedClaimStatus = (raw) => {
  const n = normalizeStatus(raw);
  if (!n) return false;
  /**
   * "İade Talebi Reddedildi" gibi degerler 'reddedil' ile BASLAMAZ; bu yuzden
   * bu iki guclu belirtec ayrica ICINDE aranir.
   *
   * DIKKAT: kisa 'red' parcasi ICINDE aranmaz - "delivered" kelimesi de "red"
   * icerir ve teslim edilen siparisleri yanlislikla reddedilmis sayardi.
   */
  if (n.includes('reddedil') || n.includes('rejected')) return true;
  return startsWithAny(n, CLAIM_REJECTED_PATTERNS);
};

export const isAcceptedClaimStatus = (raw) => {
  const n = normalizeStatus(raw);
  if (isRejectedClaimStatus(n)) return false;
  return startsWithAny(n, CLAIM_ACCEPTED_PATTERNS);
};

export const isInProgressClaimStatus = (raw) => {
  const n = normalizeStatus(raw);
  if (isRejectedClaimStatus(n)) return false;
  return startsWithAny(n, CLAIM_IN_PROGRESS_PATTERNS);
};

/**
 * GERCEK URUN IADESI MI?
 *
 * KURAL: yalnizca ACIKCA reddedilmis/iptal edilmis talepler dislanir.
 * Bilinmeyen ya da yeni bir alt statu gelirse IADE SAYILIR - eksik saymak,
 * muhasebe acisindan fazla saymaktan daha buyuk bir hatadir ve ham statu
 * raporda ayrica gorunur.
 */
export const isRealReturnClaim = (raw) => {
  const n = normalizeStatus(raw);
  if (!n) return false;
  return !isRejectedClaimStatus(n);
};

/** Talep statusunu tek kelimede siniflar - teshis ciktilari icin. */
export function classifyClaimStatus(raw) {
  const n = normalizeStatus(raw);
  if (!n) return 'EMPTY';
  if (isRejectedClaimStatus(n)) return 'REJECTED';
  if (isAcceptedClaimStatus(n)) return 'ACCEPTED';
  if (isInProgressClaimStatus(n)) return 'IN_PROGRESS';
  return 'UNKNOWN_COUNTED_AS_RETURN';
}

/**
 * Ham statu degerlerini sayarak ozetler - "hangi statu string'leri islendi"
 * sorusunun cevabi. Loglara ve teshis uc noktasina bu cikti verilir.
 *
 * @param {Array} values ham statu degerleri
 * @param {(raw:string)=>string} classify siniflandirici
 * @returns {Array<{raw:string, normalized:string, classified:string, count:number}>}
 */
export function summarizeStatuses(values, classify) {
  const map = new Map();
  for (const raw of values) {
    const key = String(raw ?? '');
    if (!map.has(key)) {
      map.set(key, {
        raw: key || '(boş)',
        normalized: normalizeStatus(key),
        classified: classify(key),
        count: 0,
      });
    }
    map.get(key).count += 1;
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
