import {
  chunkRange,
  dayKey,
  isWithinLocalDayRange,
  padRange,
  trendyolLocalToUtc,
  utcToTrendyolLocal,
} from '../lib/dates.js';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { num, round2 } from '../lib/money.js';
import { fetchAllPages, sellerPath } from './trendyolClient.js';
import {
  classifyLineStatus,
  isCancelledLineStatus,
  isUndeliveredLineStatus,
  isUnsuppliedLineStatus,
  summarizeStatuses,
} from '../lib/status.js';

/**
 * SIPARISLER (Orders API)
 * GET /integration/order/sellers/{sellerId}/orders
 *
 * Onemli kisitlar:
 *  - startDate / endDate epoch-ms cinsindendir
 *  - Tarih araligi en fazla 2 HAFTA olabilir -> chunkRange ile boluyoruz
 *  - size en fazla 200
 *  - Yanit "shipment package" (kargo paketi) bazlidir; bir siparis birden fazla
 *    pakete bolunebilir. Her paketin lines[] dizisi satir bazli urunleri tutar.
 */

/**
 * Trendyol dokumantasyonundaki sert kisitlar:
 *  - Tarih araligi en fazla 2 hafta (14 gun)
 *  - size en fazla 200
 *  - page 0 tabanlidir
 */
const ORDERS_MAX_RANGE_DAYS = 14;
const ORDERS_MAX_PAGE_SIZE = 200;

const ORDERS_CHUNK_DAYS = ORDERS_MAX_RANGE_DAYS;
const PAGE_SIZE = ORDERS_MAX_PAGE_SIZE;

/**
 * SATIR BAZLI STATU COZUMLEME  (canli veriyle dogrulanmistir)
 * =============================================================================
 * Trendyol siparis satirinda statu alani `orderLineItemStatusName`dir.
 * Canli hesapta gorulen degerler:
 *   Delivered, Shipped, Cancelled, ReadyToShip, Picking,
 *   UnDelivered, UnDeliveredAndReturned, UnPacked
 *
 * NEDEN SATIR BAZLI?
 *   Paket statusu ile satir statusu AYNI DEGILDIR. Canli 30 gunluk veride
 *   satir bazinda 494 "Cancelled" varken paket bazinda 475 goruluyor - yani
 *   paket statusune bakmak iptalleri EKSIK sayiyor. Bir paketin bir satiri
 *   iptal edilip digeri gonderilebildigi icin dogru olan satir bazli saymaktir.
 *
 * IPTAL (Cancelled): KATI kural -> yalnizca line.orderLineItemStatusName === 'Cancelled'
 * IADE  (Returned) : siparis statusunden TURETILMEZ. Iadeler yalnizca
 *                    /claims uc noktasindan gelir (bkz. claimsService.js).
 *                    Boylece iptal ve iade birbirine KARISMAZ.
 */

export const LINE_STATUS = {
  SALE: 'SALE',
  CANCELLED: 'CANCELLED',
  RETURNED: 'RETURNED',
  UNSUPPLIED: 'UNSUPPLIED',
};

export const STATUS_LABELS_TR = {
  [LINE_STATUS.SALE]: 'Satış',
  [LINE_STATUS.CANCELLED]: 'İptal',
  [LINE_STATUS.RETURNED]: 'İade',
  [LINE_STATUS.UNSUPPLIED]: 'Tedarik Edilemedi',
};

/**
 * Bir siparis satirinin OPERASYONEL statusunu belirler.
 *
 * Siniflandirma `lib/status.js` uzerinden yapilir: buyuk-kucuk harf, bosluk,
 * alt tire ve Turkce karakter farklari normalize edilir; boylece "Cancelled",
 * "CANCELLED", "İptal", "iptal edildi" ayni kovaya duser.
 *
 * DIKKAT: burada IADE URETILMEZ. Iade yalnizca /claims eslesmesiyle atanir
 * (bkz. claimsService.applyClaimsToLines) - boylece iptal ve iade karismaz.
 */
function resolveLineStatus(line) {
  const raw = line?.orderLineItemStatusName;
  if (isCancelledLineStatus(raw)) return LINE_STATUS.CANCELLED;
  if (isUnsuppliedLineStatus(raw)) return LINE_STATUS.UNSUPPLIED;
  return LINE_STATUS.SALE;
}

/** Satir teslim edilemeyip geri dondu mu? (iade SAYILMAZ, ayri raporlanir) */
function isUndelivered(line) {
  return isUndeliveredLineStatus(line?.orderLineItemStatusName);
}

/**
 * Trendyol satir tutarlari:
 *  - line.price    : indirim sonrasi BIRIM fiyat
 *  - line.amount   : musterinin o satir icin odedigi TOPLAM tutar
 *  - line.discount : satici tarafindan karsilanan indirim
 *  - line.tyDiscount: Trendyol tarafindan karsilanan indirim (saticiya geri oder)
 *
 * Farkli hesaplarda `amount` alaninin birim mi toplam mi geldigi degisebildigi
 * icin savunmaci hesaplama yapiyoruz: amount mantikli degilse price * quantity.
 */
export function lineGrossAmount(line) {
  const quantity = Math.max(1, num(line?.quantity, 1));
  const price = num(line?.lineUnitPrice ?? line?.price, 0);

  // Trendyol satirda `lineGrossAmount` alanini dondurur: satirin TOPLAM brut
  // tutari. Varsa dogrudan onu kullaniriz - en guvenilir kaynak budur.
  const lineGross = num(line?.lineGrossAmount, 0);
  if (lineGross > 0) return lineGross;

  const amount = num(line?.amount, 0);

  if (amount > 0) {
    // amount birim fiyata cok yakinsa ve adet > 1 ise birim gelmis demektir
    if (quantity > 1 && price > 0 && Math.abs(amount - price) < 0.01) {
      return price * quantity;
    }
    return amount;
  }
  return price * quantity;
}

/**
 * Bazi paketlerde iptal gerekcesi paket govdesinde ya da paket gecmisinde
 * gelir. Sozlesme hesaptan hesaba degistigi icin aday alanlari sirayla tarariz.
 */
function extractPackageCancelReason(pkg, line) {
  // Canli veride iptal gerekcesi SATIRDA geliyor: line.cancelReason (+ cancelledBy)
  const candidates = [
    line?.cancelReason,
    line?.cancelReasonText,
    line?.orderLineItemStatusReason,
    pkg?.cancelReason,
    pkg?.cancellationReason,
    pkg?.packageHistories?.find?.((h) => String(h?.status) === 'Cancelled')?.reason,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object' && typeof candidate.name === 'string') return candidate.name;
  }
  return null;
}

/** Musteri adi hesaptan hesaba farkli alanlarda gelebilir; aday alanlari sirayla tarariz. */
export const UNKNOWN_CUSTOMER = 'Bilinmiyor';

/**
 * Yanittan gelen herhangi bir degeri Excel'e/JSON'a guvenle yazilabilecek duz
 * metne cevirir. Trendyol bazi hesaplarda ad alanlarini obje ya da dizi olarak
 * dondurebiliyor; String() ile zorlarsak hucreye "[object Object]" yaziliyor.
 * Bu yuzden yalnizca ilkel (primitive) degerleri metne ceviriyoruz.
 */
function cleanName(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return '';
  // obje / dizi / fonksiyon -> isim degildir, yok say
  return '';
}

/** Ilk dolu adayi dondurur; hicbiri yoksa bos metin. */
function firstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    const value = cleanName(candidate);
    if (value) return value;
  }
  return '';
}

/**
 * Paketten musteri adini cikarir.
 *
 * Bu fonksiyon HICBIR KOSULDA throw etmez: tek bir bozuk paket yuzunden tum
 * rapor isteginin dusmesi kabul edilemez. Beklenmedik bir sey olursa musteri
 * "Bilinmiyor" olarak isaretlenir ve islem devam eder.
 */
export function extractCustomer(pkg) {
  try {
    const first = firstNonEmpty(
      pkg?.customerFirstName,
      pkg?.shipmentAddress?.firstName,
      pkg?.invoiceAddress?.firstName,
      pkg?.customer?.firstName,
    );
    const last = firstNonEmpty(
      pkg?.customerLastName,
      pkg?.shipmentAddress?.lastName,
      pkg?.invoiceAddress?.lastName,
      pkg?.customer?.lastName,
    );

    if (first || last) {
      return { firstName: first, lastName: last, fullName: [first, last].filter(Boolean).join(' ') };
    }

    // Bazi paketlerde yalnizca birlesik ad alani doner
    const full = firstNonEmpty(
      pkg?.shipmentAddress?.fullName,
      pkg?.invoiceAddress?.fullName,
      pkg?.customerName,
      pkg?.customer?.fullName,
    );
    if (full) {
      const parts = full.split(/\s+/).filter(Boolean);
      return {
        firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : full,
        lastName: parts.length > 1 ? parts[parts.length - 1] : '',
        fullName: full,
      };
    }
  } catch (error) {
    logger.warn('customer parse failed', {
      packageId: pkg?.id ?? null,
      orderNumber: pkg?.orderNumber ?? null,
      error: error?.message ?? String(error),
    });
  }

  return { firstName: '', lastName: '', fullName: UNKNOWN_CUSTOMER };
}

// ---------------------------------------------------------------------------
// ANA URUN (PARENT) / VARYANT COZUMLEME
// ---------------------------------------------------------------------------

/**
 * Beden/varyant gibi gorunen son ek kaliplari.
 * Or: "S", "XL", "36-38", "40/42", "one size", "Standart", "36 Beden"
 */
const SIZE_LIKE = /^(?:xxs|xs|s|m|l|xl|xxl|xxxl|\d+(?:[-/]\d+)*(?:\s*beden)?|one\s*size|tek\s*ebat|standart|standard|no\s*\d+)$/i;

/** Karsilastirma icin ad normalizasyonu (bosluk/noktalama/buyuk-kucuk farkini siler). */
function normalizeName(value) {
  return String(value ?? '')
    .toLocaleLowerCase('tr-TR')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:_]+$/g, '')
    .trim();
}

/**
 * Urun adindan beden/varyant son ekini ayirir.
 * Trendyol siparis satirlarinda ad genelde "<Ana Ürün>, <Beden>" formatindadir.
 *
 * @returns {{ parentName: string, variantLabel: string }}
 */
export function splitVariantName(productName, productSize) {
  const name = String(productName ?? '').trim();
  const size = String(productSize ?? '').trim();
  if (!name) return { parentName: '', variantLabel: size };

  const commaAt = name.lastIndexOf(',');
  if (commaAt > 0) {
    const head = name.slice(0, commaAt).trim();
    const tail = name.slice(commaAt + 1).trim();
    // Son ek ya satirin beden alanina esit ya da beden kalibina uyuyorsa ayir
    if (tail && (normalizeName(tail) === normalizeName(size) || SIZE_LIKE.test(tail))) {
      return { parentName: head, variantLabel: tail };
    }
  }
  return { parentName: name, variantLabel: size };
}

/**
 * Bir siparis satirinin ait oldugu ana urunu belirler.
 * Oncelik: Trendyol ana urun kimligi > ad tabanli gruplama.
 *
 * DIKKAT: merchantSku bilerek KULLANILMAZ - bazi hesaplarda tum satirlarda
 * ayni sabit deger ("merchantSku" gibi) gelebiliyor ve bu, birbiriyle
 * ilgisiz tum urunleri tek gruba toplardi.
 */
export function deriveParent(line) {
  const { parentName, variantLabel } = splitVariantName(line?.productName, line?.productSize);
  const mainId = line?.productMainId ?? line?.mainProductCode ?? null;

  const parentKey = mainId
    ? `id:${mainId}`
    : `ad:${normalizeName(parentName) || normalizeName(line?.productName) || String(line?.barcode ?? '')}`;

  return {
    parentKey,
    parentName: parentName || String(line?.productName ?? '').trim() || 'İsimsiz ürün',
    variantLabel: variantLabel || line?.productColor || 'Tek varyant',
  };
}

/**
 * Ham paket yanitini rapor icin duz satirlara cevirir.
 * Bozuk/eksik bir satir tum paketi dusurmesin diye satir bazinda korunur.
 */
function flattenPackage(pkg) {
  const lines = Array.isArray(pkg?.lines) ? pkg.lines : [];
  const customer = extractCustomer(pkg);
  const out = [];

  for (const line of lines) {
    try {
      const quantity = Math.max(1, num(line?.quantity, 1));
      const grossAmount = lineGrossAmount(line);
      const parent = deriveParent({
        productName: line?.productName,
        productSize: line?.productSize,
        productColor: line?.productColor,
        productMainId: line?.productMainId ?? pkg?.productMainId,
        barcode: line?.barcode,
      });
      out.push({
        // kimlik
        packageId: pkg?.id ?? null,
        orderNumber: pkg?.orderNumber ?? pkg?.id ?? '',
        // Claims eslesmesinin ANAHTARI: claims -> items[].orderLine.id ile birebir
        // ayni degerdir (canli veride 998/1003 eslesme dogrulanmistir).
        // Siparis satirinda `id` ve `lineId` her zaman ayni geliyor.
        orderLineId: line?.id ?? line?.lineId ?? null,
        lineId: line?.lineId ?? line?.id ?? null,
        // urun
        barcode: String(line?.barcode ?? '').trim(),
        merchantSku: String(line?.merchantSku ?? '').trim(),
        productName: String(line?.productName ?? '').trim(),
        productCode: line?.productCode ?? null,
        productSize: line?.productSize ?? '',
        productColor: line?.productColor ?? '',
        brand: pkg?.brand ?? line?.brand ?? '',
        /**
         * ZAMAN - bkz. lib/dates.js `trendyolLocalToUtc`
         * `orderDate` Trendyol tarafindan Istanbul duvar saati olarak, UTC gibi
         * kodlanmis geliyor; bir kez gercek UTC'ye ceviriyoruz. Aksi halde tum
         * gun gruplamasi ve Excel saatleri 3 saat ileri kayiyordu
         * (19:15 siparisi 22:15 gorunuyordu) ve gece siparisleri ertesi gune
         * tasarak "Gunluk Net Ciro" hesabini bozuyordu.
         *
         * `lastModifiedDate` ZATEN gercek UTC - ona dokunulmaz.
         */
        orderDate: trendyolLocalToUtc(pkg?.orderDate),
        orderDateRaw: num(pkg?.orderDate, null),
        lastModifiedDate: num(pkg?.lastModifiedDate, null),
        // durum (SATIR bazli - paket statusu kullanilmaz)
        status: resolveLineStatus(line),
        rawLineStatus: line?.orderLineItemStatusName ?? '',
        rawPackageStatus: pkg?.shipmentPackageStatus ?? pkg?.status ?? '',
        undelivered: isUndelivered(line),
        packageCancelReason: extractPackageCancelReason(pkg, line),
        cancelledBy: line?.cancelledBy ?? '',
        cancelReasonCode: line?.cancelReasonCode ?? null,
        // tutar
        quantity,
        unitPrice: num(line?.lineUnitPrice ?? line?.price, 0),
        grossAmount,
        discount: num(line?.discount, 0),
        tyDiscount: num(line?.tyDiscount, 0),
        vatBaseAmount: num(line?.vatBaseAmount, 0),
        vatRate: num(line?.vatRate, null),
        currencyCode: line?.currencyCode ?? 'TRY',
        /**
         * KOMISYON ORANI (yuzde). Trendyol siparis satirindaki `commission`
         * alani oranin kendisidir; mutabakattaki `commissionRate` ile birebir
         * ayni cikar. Mutabakat olusmadan tahmin yapabilmemizi saglar.
         */
        commissionRate: num(line?.commission, null),
        productCategoryId: line?.productCategoryId ?? null,
        // ana urun / varyant (panelde gruplama icin)
        parentKey: parent.parentKey,
        parentName: parent.parentName,
        variantLabel: parent.variantLabel,
        // musteri
        customerFirstName: customer.firstName,
        customerLastName: customer.lastName,
        customerFullName: customer.fullName,
        cargoProvider: pkg?.cargoProviderName ?? '',
      });
    } catch (error) {
      logger.warn('order line skipped', {
        packageId: pkg?.id ?? null,
        orderNumber: pkg?.orderNumber ?? null,
        // Claims eslesmesinin ANAHTARI: claims -> items[].orderLine.id ile birebir
        // ayni degerdir (canli veride 998/1003 eslesme dogrulanmistir).
        // Siparis satirinda `id` ve `lineId` her zaman ayni geliyor.
        orderLineId: line?.id ?? line?.lineId ?? null,
        lineId: line?.lineId ?? line?.id ?? null,
        error: error?.message ?? String(error),
      });
    }
  }

  return out;
}

/**
 * Verilen tarih araligindaki TUM siparis satirlarini getirir.
 * Ayni paket birden fazla chunk'ta donebilecegi icin paket id ile tekillestirilir.
 */
export async function fetchOrderLines({ startMs, endMs, startDate, endDate, timeZone = 'Europe/Istanbul' }) {
  // Takvim gunu metinleri verilmediyse pencereden turet
  const startDay = startDate ?? dayKey(startMs, timeZone);
  const endDay = endDate ?? dayKey(endMs, timeZone);
  const cacheKey = `orders:${startDay}:${endDay}:${timeZone}`;

  return cached(cacheKey, async () => {
    /**
     * PENCEREYI BIR GUN PAYLA GENISLET.
     * Trendyol'un tarih filtresinin hangi kodlamayi kullandigi kesin degil;
     * pay birakip nihai elemeyi yerel takvim gunu metniyle yapiyoruz.
     * Aksi halde gunun ilk saatlerindeki (00:00-03:00) siparisler
     * "Bugun" gorunumunden dusuyordu.
     */
    const padded = padRange(startMs, endMs, 1);
    const chunks = chunkRange(padded.startMs, padded.endMs, ORDERS_CHUNK_DAYS);
    const packagesById = new Map();
    let requestCount = 0;

    for (const chunk of chunks) {
      // Dokumantasyondaki asgari parametre seti:
      //   startDate / endDate : epoch-ms, TAM SAYI olmak zorunda
      //   orderByField        : tarih filtresinin HANGI tarihe uygulanacagini belirler.
      //                         Varsayilan 'PackageLastModifiedDate'tir; rapor siparis
      //                         gunune gore gruplandigi icin 'CreatedDate' kullaniyoruz.
      //   page / size         : fetchAllPages tarafindan eklenir (page 0 tabanli, size <= 200)
      // orderByDirection gonderilmiyor: siralamayi zaten asagida kendimiz yapiyoruz.
      /**
       * DIKKAT: Trendyol `orderDate`i Istanbul duvar saati olarak kodladigi
       * icin, tarih FILTRESI de ayni kodlamayi bekler. Bu yuzden pencereyi
       * sorguya gonderirken UTC'den duvar saatine geri ceviriyoruz; boylece
       * "gunun 00:00'i" Trendyol tarafinda da Istanbul 00:00'a denk gelir.
       */
      const { items, pages } = await fetchAllPages(
        sellerPath('/order/sellers/:sellerId/orders'),
        {
          startDate: Math.trunc(utcToTrendyolLocal(chunk.startDate)),
          endDate: Math.trunc(utcToTrendyolLocal(chunk.endDate)),
          orderByField: 'CreatedDate',
        },
        { size: PAGE_SIZE },
      );
      requestCount += pages;
      for (const pkg of items) {
        const key = pkg?.id ?? `${pkg?.orderNumber}-${pkg?.cargoTrackingNumber}`;
        if (key !== undefined && key !== null) packagesById.set(String(key), pkg);
      }
    }

    /**
     * SATIR BAZLI TEKILLESTIRME (bolunmus paketler)
     * -----------------------------------------------------------------
     * Trendyol bir kargo paketini bolunce ("UnPacked" = paket bolundu) ayni
     * SIPARIS SATIRI hem eski hem yeni pakette gorunebiliyor. Paket id'ye gore
     * tekillestirmek bunu YAKALAMAZ; satirlar iki kez sayilir ve iptal/iade
     * adetleri Trendyol panelinden fazla cikar.
     *
     * Bu yuzden satirlar `orderLineId` bazinda tekillestirilir. Ayni satir
     * birden fazla pakette gorunuyorsa BOLUNMUS (UnPacked) paket degil, canli
     * paket kaydi esas alinir.
     */
    const linesById = new Map();
    let duplicateLines = 0;

    for (const pkg of packagesById.values()) {
      const isSuperseded = String(pkg?.shipmentPackageStatus ?? '') === 'UnPacked';
      for (const line of flattenPackage(pkg)) {
        const key = line.orderLineId === null || line.orderLineId === undefined
          ? `pkg:${line.packageId}:${line.barcode}:${line.orderNumber}`
          : `line:${line.orderLineId}`;

        const existing = linesById.get(key);
        if (!existing) {
          linesById.set(key, { line, superseded: isSuperseded });
          continue;
        }
        duplicateLines += 1;
        // Bolunmus paketten gelen kaydi, canli paket kaydiyla degistir
        if (existing.superseded && !isSuperseded) linesById.set(key, { line, superseded: isSuperseded });
      }
    }

    const allLines = [...linesById.values()].map((entry) => entry.line);

    /**
     * SIKI TARIH FILTRESI
     * Trendyol'un tarih filtresi bazi hesaplarda paketin SON GUNCELLENME
     * tarihine gore calisir; bu yuzden secilen pencerenin disinda kalan
     * siparisler de yanitta gelebiliyor. Ustteki filtreye GUVENMIYORUZ:
     * pencereye girmeyen her satir burada kesin olarak elenir.
     * (Panelde ve Excel'de aralik disi tek bir satir bile gorunmemeli.)
     */
    /**
     * NIHAI ELEME: Istanbul TAKVIM GUNU metni karsilastirmasi.
     * Ham timestamp yerine 'YYYY-MM-DD' karsilastirdigimiz icin, yukari
     * akistan hangi kodlamayla gelirse gelsin siparis dogru gune duser;
     * gece yarisina yakin siparisler kaymaz.
     */
    const lines = [];
    let outOfRange = 0;
    for (const line of allLines) {
      const orderDate = num(line.orderDate, null);
      if (orderDate === null || !isWithinLocalDayRange(orderDate, startDay, endDay, timeZone)) {
        outOfRange += 1;
        continue;
      }
      lines.push(line);
    }

    // Rapor gunu siparis tarihine gore belirlenir
    lines.sort((a, b) => num(a.orderDate) - num(b.orderDate));

    /**
     * HAM STATU DENETIM KAYDI
     * Trendyol'dan GERCEKTE hangi `orderLineItemStatusName` degerlerinin
     * geldigini, normalize edilmis hallerini ve hangi kovaya dustuklerini
     * loga yazar. Beklenmedik/yeni bir statu geldiginde burada gorunur.
     */
    const statusSummary = summarizeStatuses(
      lines.map((l) => l.rawLineStatus),
      classifyLineStatus,
    );
    logger.info('order line status breakdown (RAW)', {
      statuses: statusSummary.map((r) => ({
        ham: r.raw,
        normalize: r.normalized,
        sinif: r.classified,
        adet: r.count,
      })),
    });

    const unknown = statusSummary.filter((r) => r.classified === 'UNKNOWN');
    if (unknown.length > 0) {
      logger.warn('BILINMEYEN siparis satiri statusu - siniflandirilamadi', {
        statuses: unknown.map((r) => `${r.raw} (${r.count})`),
        etki: 'Bu satirlar SATIS sayildi. Iptal/iade ise lib/status.js kaliplarina eklenmeli.',
      });
    }

    // Gun ve saat bazli dagilim: bir gunun ilk saatleri eksikse burada gorunur
    const byDay = new Map();
    const byHour = new Array(24).fill(0);
    for (const line of lines) {
      const d = dayKey(line.orderDate, timeZone);
      byDay.set(d, (byDay.get(d) ?? 0) + 1);
      const h = Number(
        new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' })
          .format(new Date(line.orderDate)),
      );
      if (Number.isFinite(h)) byHour[h] += 1;
    }
    logger.info('order day/hour distribution (Europe/Istanbul)', {
      aralik: `${startDay} .. ${endDay}`,
      gunler: Object.fromEntries([...byDay.entries()].sort()),
      saatler: byHour.reduce((acc, n, h) => (n ? { ...acc, [`${String(h).padStart(2, '0')}:00`]: n } : acc), {}),
    });

    /**
     * TARIH FILTRESI DENETIM KAYDI
     * Yukari akistan kac satir geldi, kaci yerel takvim gunu filtresiyle
     * elendi - tek bakista gorunur. `islenen` sayisi `elenen`den cok buyukse
     * Trendyol tarih filtresini yok sayiyor demektir (bizim filtremiz yine de
     * dogru araligi birakir).
     */
    logger.info(
      `[Date Filter Applied] Range: ${startDay} to ${endDay} | ` +
        `Total Orders Processed: ${allLines.length} | Orders Dropped by Date Filter: ${outOfRange}`,
      {
        aralik: `${startDay} .. ${endDay}`,
        saatDilimi: timeZone,
        yukariAkistanGelen: allLines.length,
        tarihFiltresiyleElenen: outOfRange,
        kalan: lines.length,
        mukerrerSatirBirlestirilen: duplicateLines,
        sorguPenceresi: 'secili aralik ±1 gun (pay), nihai eleme yerel takvim gunu metniyle',
      },
    );

    logger.info('orders fetched', {
      packages: packagesById.size,
      lines: lines.length,
      duplicateLinesMerged: duplicateLines,
      outOfRangeDropped: outOfRange,
      chunks: chunks.length,
      requests: requestCount,
      cancelledLines: statusSummary.filter((r) => r.classified === 'CANCELLED').reduce((s2, r) => s2 + r.count, 0),
      undeliveredLines: statusSummary.filter((r) => r.classified === 'UNDELIVERED').reduce((s2, r) => s2 + r.count, 0),
    });

    lines.statusSummary = statusSummary;
    lines.dateFilterStats = {
      startDate: startDay,
      endDate: endDay,
      timeZone,
      processed: allLines.length,
      droppedByDateFilter: outOfRange,
      kept: lines.length,
      duplicateLinesMerged: duplicateLines,
    };
    return lines;
  });
}

/**
 * URUN LISTESI - ANA URUN (PARENT) BAZINDA GRUPLANMIS OZET
 * =============================================================================
 * Ayni urunun farkli bedenleri panelde ayri satirlar olarak yer kaplamasin diye
 * ana urun altinda toplanir; her ana urunun `variants[]` dizisi beden bazinda
 * kirilimi AYNEN korur (Excel'e de bu kirilim yazilir).
 *
 * Finansal tutarlar `financialsFor(line)` ile disaridan gelir - boylece bu
 * modul mutabakat servisine bagimli olmaz (dairesel import olusmaz) ve
 * panel ile Excel ayni tek formulu kullanir.
 *
 * @param {Array}    orderLines
 * @param {Function} financialsFor  (line) => { grossSales, commission, shipping, refund, netRevenue, settled }
 */
export function buildProductCatalog(orderLines, financialsFor = () => null) {
  const parents = new Map();

  const emptyMetrics = () => ({
    quantitySold: 0,
    // IPTAL ve IADE HER ZAMAN AYRI KOVALARDA - hicbir yerde toplanmaz
    quantityCancelled: 0,
    quantityReturned: 0,
    quantityUnsupplied: 0,
    quantityReturnPending: 0,
    settledLines: 0,
    estimatedLines: 0,
    grossSales: 0,
    cancelledAmount: 0,
    returnedAmount: 0,
    unsuppliedAmount: 0,
    commission: 0,
    shippingFee: 0,
    excludedAmount: 0,
    refunds: 0,
    netRevenue: 0,
    settledLines: 0,
    orderNumbers: new Set(),
    firstOrderDate: null,
    lastOrderDate: null,
  });

  const accumulate = (target, line, fin) => {
    target.orderNumbers.add(line.orderNumber);
    if (line.orderDate) {
      target.firstOrderDate = Math.min(target.firstOrderDate ?? line.orderDate, line.orderDate);
      target.lastOrderDate = Math.max(target.lastOrderDate ?? line.orderDate, line.orderDate);
    }

    // Statuler birbirini DISLAR: bir adet yalnizca tek kovaya girer.
    if (line.status === LINE_STATUS.CANCELLED) {
      target.quantityCancelled += line.quantity;
      target.cancelledAmount += line.grossAmount;
    } else if (line.status === LINE_STATUS.RETURNED) {
      target.quantityReturned += line.quantity;
      target.returnedAmount += line.grossAmount;
    } else if (line.status === LINE_STATUS.UNSUPPLIED) {
      target.quantityUnsupplied += line.quantity;
      target.unsuppliedAmount += line.grossAmount;
    } else {
      target.quantitySold += line.quantity;
    }
    // Henuz onaylanmamis iade talebi olan adetler (bilgi amacli, ciroyu etkilemez)
    if (line.returnPendingQuantity > 0) target.quantityReturnPending += line.returnPendingQuantity;

    if (fin) {
      target.grossSales += fin.grossSales;
      target.commission += fin.commission;
      target.shippingFee += fin.shipping;
      target.excludedAmount += fin.excluded ?? 0;
      target.netRevenue += fin.netRevenue;
      // Hibrit model: her satirin bir tutari VARDIR. Fark yalnizca tutarin
      // KESINLESMIS mi (mutabakattan) yoksa TAHMINI mi (satir orani ile)
      // oldugudur. "Bos/bekliyor" satir birakilmaz.
      if (fin.settled) target.settledLines += 1;
      else target.estimatedLines += 1;
    }
  };

  for (const line of orderLines) {
    const variantKey = line.barcode || line.merchantSku || `${line.parentKey}::${line.variantLabel}`;
    if (!variantKey) continue;

    if (!parents.has(line.parentKey)) {
      parents.set(line.parentKey, {
        parentKey: line.parentKey,
        productName: line.parentName,
        brand: line.brand,
        variants: new Map(),
        ...emptyMetrics(),
      });
    }
    const parent = parents.get(line.parentKey);

    if (!parent.variants.has(variantKey)) {
      parent.variants.set(variantKey, {
        barcode: line.barcode || variantKey,
        merchantSku: line.merchantSku,
        productName: line.productName,
        variantLabel: line.variantLabel,
        productSize: line.productSize,
        productColor: line.productColor,
        productCode: line.productCode,
        ...emptyMetrics(),
      });
    }

    const fin = financialsFor(line);
    accumulate(parent, line, fin);
    accumulate(parent.variants.get(variantKey), line, fin);
  }

  const finalize = (entry, extra = {}) => {
    const totalUnits =
      entry.quantitySold + entry.quantityCancelled + entry.quantityReturned + entry.quantityUnsupplied;
    const lostUnits = entry.quantityCancelled + entry.quantityReturned + entry.quantityUnsupplied;
    const { orderNumbers, variants, ...rest } = entry;
    return {
      ...rest,
      ...extra,
      // Benzersiz SIPARIS NO adedi (Trendyol "Sipariş" mantigi; satir/adet degil)
      orderCount: orderNumbers.size,
      grossSales: round2(entry.grossSales),
      cancelledAmount: round2(entry.cancelledAmount),
      returnedAmount: round2(entry.returnedAmount),
      unsuppliedAmount: round2(entry.unsuppliedAmount),
      // --- 5 adimli denetim kirilimi ---
      netSales: round2(entry.grossSales),
      cancelledReturnedGross: round2(entry.cancelledAmount + entry.returnedAmount + entry.unsuppliedAmount),
      totalGrossRevenue: round2(
        entry.grossSales + entry.cancelledAmount + entry.returnedAmount + entry.unsuppliedAmount,
      ),
      deductions: round2(entry.commission + entry.shippingFee),
      commission: round2(entry.commission),
      shippingFee: round2(entry.shippingFee),
      excludedAmount: round2(entry.excludedAmount),
      refunds: 0,
      netRevenue: round2(entry.netRevenue),
      returnRate: totalUnits > 0 ? Math.round((lostUnits / totalUnits) * 1000) / 10 : 0,
      // Iptal ve iade oranlari AYRI AYRI da raporlanir
      cancelRate: totalUnits > 0 ? Math.round((entry.quantityCancelled / totalUnits) * 1000) / 10 : 0,
      returnOnlyRate: totalUnits > 0 ? Math.round((entry.quantityReturned / totalUnits) * 1000) / 10 : 0,
    };
  };

  return [...parents.values()]
    .map((parent) =>
      finalize(parent, {
        variantCount: parent.variants.size,
        variants: [...parent.variants.values()]
          .map((variant) => finalize(variant))
          .sort((a, b) => b.grossSales - a.grossSales || String(a.variantLabel).localeCompare(String(b.variantLabel), 'tr', { numeric: true })),
      }),
    )
    .sort((a, b) => b.grossSales - a.grossSales);
}
