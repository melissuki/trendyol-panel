/**
 * Trendyol API'si epoch-millisecond ile calisir, rapor ise Turkiye takvim
 * gunlerine gore gruplanir. Bu dosya iki dunya arasindaki cevrimleri yapar.
 * Sabit UTC+3 varsaymiyoruz; Intl uzerinden gercek offset hesaplaniyor.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

/** 'YYYY-MM-DD' -> ilgili zaman diliminde gunun 00:00:00.000 epoch ms degeri */
export function zonedDayStart(dateStr, timeZone) {
  assertDateString(dateStr);
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  ts = guess - tzOffsetMs(new Date(ts), timeZone); // DST sinirlarinda ikinci yaklasim
  return ts;
}

/** 'YYYY-MM-DD' -> ilgili zaman diliminde gunun 23:59:59.999 epoch ms degeri */
export function zonedDayEnd(dateStr, timeZone) {
  return zonedDayStart(dateStr, timeZone) + 24 * 60 * 60 * 1000 - 1;
}

/** epoch ms -> 'YYYY-MM-DD' (rapor zaman diliminde) */
export function dayKey(ms, timeZone) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Number(ms)));
}

/** epoch ms -> 'dd.MM.yyyy HH:mm' (Excel'de okunabilir metin icin) */
export function formatDateTime(ms, timeZone) {
  if (!ms) return '';
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(Number(ms)));
}

/** epoch ms -> 'HH:mm' (rapor zaman diliminde) */
export function formatTime(ms, timeZone) {
  if (!ms) return '';
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(Number(ms)));
}

/** 'YYYY-MM-DD' -> 'dd.MM.yyyy' */
export function formatDayLabel(dayStr) {
  if (!DATE_RE.test(dayStr)) return dayStr;
  const [y, m, d] = dayStr.split('-');
  return `${d}.${m}.${y}`;
}

/** Turkce gun adi (Pazartesi, Sali ...) */
export function weekdayLabel(dayStr, timeZone) {
  if (!DATE_RE.test(dayStr)) return '';
  const ms = zonedDayStart(dayStr, timeZone) + 12 * 60 * 60 * 1000;
  return new Intl.DateTimeFormat('tr-TR', { timeZone, weekday: 'long' }).format(new Date(ms));
}

export function assertDateString(dateStr) {
  if (!DATE_RE.test(String(dateStr))) {
    throw new Error(`Gecersiz tarih formati: "${dateStr}" (YYYY-MM-DD bekleniyor)`);
  }
}

export function daysBetween(startMs, endMs) {
  return Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000));
}

/**
 * Trendyol endpoint'leri tarih araligini sinirlar (orders: 2 hafta,
 * settlements: 15 gun). Uzun araliklari otomatik parcalara boleriz.
 */
export function chunkRange(startMs, endMs, maxDays) {
  const span = maxDays * 24 * 60 * 60 * 1000;
  const chunks = [];
  let cursor = startMs;
  while (cursor <= endMs) {
    const end = Math.min(cursor + span - 1, endMs);
    chunks.push({ startDate: cursor, endDate: end });
    cursor = end + 1;
  }
  return chunks;
}

/** Aralikta hic satis olmasa bile takvimde bosluk kalmamasi icin tum gunler */
export function enumerateDays(startDayStr, endDayStr, timeZone) {
  const out = [];
  let cursor = zonedDayStart(startDayStr, timeZone);
  const end = zonedDayStart(endDayStr, timeZone);
  let guard = 0;
  while (cursor <= end && guard < 1000) {
    const key = dayKey(cursor, timeZone);
    out.push(key);
    cursor = zonedDayStart(key, timeZone) + 26 * 60 * 60 * 1000; // DST-safe ileri sicrama
    cursor = zonedDayStart(dayKey(cursor, timeZone), timeZone);
    guard += 1;
  }
  return out;
}

/**
 * TRENDYOL ZAMAN DAMGASI NORMALIZASYONU
 * =============================================================================
 * Trendyol uc noktalari zaman damgalarini IKI FARKLI sekilde donduruyor
 * (canli hesapta olculerek dogrulanmistir):
 *
 *   ALAN                                   KODLAMA
 *   ---------------------------------------------------------------------
 *   /orders   orderDate                    Istanbul DUVAR SAATI, UTC gibi  <-- KAYIK
 *   /orders   lastModifiedDate             gercek UTC
 *   /orders   originShipmentDate           gercek UTC
 *   /claims   claimDate, orderDate         gercek UTC
 *   /finance  transactionDate, orderDate   gercek UTC
 *
 * KANIT (canli, 2026-08-29):
 *   1) En yeni `orderDate` degeri "simdi"den +2.87 SAAT ILERIDE cikiyor -
 *      verilmis bir siparisin gelecekte olmasi imkansizdir.
 *   2) Ayni siparisler icin:
 *        claims.orderDate      − orders.orderDate = -3.00 sa  (1061/1061 kayit)
 *        settlements.orderDate − orders.orderDate = -3.00 sa  (1500/1500 kayit)
 *   3) Siparis saatlerinin gunluk dagilimi: `orderDate` oldugu gibi UTC kabul
 *      edilince tipik Turkiye egrisi cikiyor (aksam 17-23 yogun, 03-06 sakin);
 *      Istanbul'a cevrilince "gece 01'de zirve, sabah 08'de olu" gibi
 *      gerceklikle bagdasmayan bir tablo olusuyor.
 *
 * Bu yuzden `orderDate` degerini bir kez Istanbul duvar saatinden GERCEK UTC'ye
 * ceviriyoruz. Cevrimden sonra tum bicimlendirme ve gun gruplama zaten dogru
 * calisan Intl tabanli fonksiyonlarla yapiliyor ve 19:15 siparisi Excel'de
 * 19:15 gorunuyor (onceden 22:15 goruyordu).
 *
 * NOT: Buraya `date-fns-tz` gibi bir kutuphane eklemek bu hatayi COZMEZ -
 * sorun bicimlendirmede degil, gelen verinin kodlamasindadir. Asagidaki
 * Intl tabanli cevrim IANA veritabanini kullanir, DST gecislerinde dogrudur
 * ve ek bagimlilik gerektirmez.
 */

/**
 * Istanbul duvar saatini UTC gibi kodlanmis bir epoch'u GERCEK UTC epoch'a cevirir.
 *
 * @param {number|null|undefined} ms  Trendyol'dan gelen ham deger
 * @param {string} timeZone           hedef saat dilimi (varsayilan Europe/Istanbul)
 * @returns {number|null}             gercek UTC epoch (ms)
 */
export function trendyolLocalToUtc(ms, timeZone = 'Europe/Istanbul') {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return null;

  // value = gercekUtc + offset(gercekUtc)  ->  gercekUtc = value - offset
  // Offset, gecisin hangi tarafinda oldugumuza gore degisebildigi icin
  // (Turkiye 2016'dan beri sabit +03 olsa da) iki adimda yakinsiyoruz.
  let utc = value - tzOffsetMs(new Date(value), timeZone);
  utc = value - tzOffsetMs(new Date(utc), timeZone);
  return utc;
}

/** Ters cevrim - test ve dogrulama icin. */
export function utcToTrendyolLocal(ms, timeZone = 'Europe/Istanbul') {
  const value = Number(ms);
  if (!Number.isFinite(value)) return null;
  return value + tzOffsetMs(new Date(value), timeZone);
}


/**
 * YEREL TAKVIM GUNU KARSILASTIRMASI  (saat dilimi kaymasina karsi kesin cozum)
 * =============================================================================
 * NEDEN HAM TIMESTAMP DEGIL DE GUN METNI?
 *
 * Trendyol'un tarih FILTRESININ hangi kodlamayi kullandigi belgelenmemis ve
 * dogrulanamiyor: `orderDate` ciktisi Istanbul duvar saatini UTC gibi
 * kodluyor, ancak ayni uc noktanin `startDate`/`endDate` filtresinin de ayni
 * kodlamayi kullandigi KESIN DEGIL (bu API alanlar arasinda kodlama
 * karistirdigi kanitlandi - bkz. trendyolLocalToUtc aciklamasi).
 *
 * Bu belirsizlige bagimli kalmamak icin:
 *   1) Yukari akisa gonderilen pencere BIR GUN PAYLA genisletilir (her iki
 *      kodlamada da gercek gun tamamen kapsanir),
 *   2) Nihai filtre BURADA, Istanbul takvim gunu METNI (YYYY-MM-DD)
 *      karsilastirilarak uygulanir.
 *
 * Boylece 00:00-03:00 arasindaki gece siparisleri hicbir kodlamada
 * kaybolmaz ve "Bugun" gorunumu eksik cikmaz.
 */

/** epoch ms -> Istanbul takvim gunu metni. `dayKey` ile ayni; niyet belirtir. */
export const localDayKey = (ms, timeZone) => dayKey(ms, timeZone);

/**
 * Zaman damgasi, secilen takvim gunu araligina giriyor mu?
 * Karsilastirma tamamen METIN uzerinden yapilir ('2026-08-29' <= x <= '2026-08-29'),
 * bu yuzden saat/offset kaymasindan etkilenmez.
 *
 * @param {number} ms          gercek UTC epoch
 * @param {string} startDate   'YYYY-MM-DD' (dahil)
 * @param {string} endDate     'YYYY-MM-DD' (dahil)
 * @param {string} timeZone
 */
export function isWithinLocalDayRange(ms, startDate, endDate, timeZone) {
  const key = dayKey(ms, timeZone);
  if (!key) return false;
  return key >= startDate && key <= endDate;
}

/**
 * Yukari akis sorgusu icin pencereyi gun payiyla genisletir.
 * Fazladan gelen kayitlar `isWithinLocalDayRange` ile elenir.
 */
export function padRange(startMs, endMs, days = 1) {
  const pad = days * 24 * 60 * 60 * 1000;
  return { startMs: startMs - pad, endMs: endMs + pad };
}
