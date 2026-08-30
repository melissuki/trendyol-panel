import { chunkRange } from '../lib/dates.js';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { round2 } from '../lib/money.js';
import { fetchAllPages, sellerPath } from './trendyolClient.js';

/**
 * FINANS / MUTABAKAT SERVISI  --  HIBRIT MODEL
 * =============================================================================
 * GET /integration/finance/che/sellers/{sellerId}/settlements
 * GET /integration/finance/che/sellers/{sellerId}/otherfinancials
 *
 * MODEL
 *   1) Mutabakat kaydi VARSA  -> KESINLESMIS. commissionAmount ve kesintiler
 *      dogrudan Trendyol'un kaydindan okunur.
 *   2) Mutabakat kaydi YOKSA  -> TAHMINI. Satirin KENDI komisyon orani ile:
 *          komisyon = lineGrossAmount * (rate / 100)
 *      Satir ARTIK BOS BIRAKILMAZ.
 *
 * KOMISYON ORANI NEREDEN GELIYOR?
 *   Trendyol siparis satirindaki `commission` alani ZATEN oranin kendisidir
 *   (yuzde: 4.4, 15.7, 21.5 ...). Canli veride bu deger, ayni siparis icin
 *   mutabakattan donen `commissionRate` ile BIREBIR ayni cikiyor (15.7 = 15.7).
 *   Dolayisiyla oran, kategori ortalamasi degil O SATIRIN gercek oranidir.
 *
 *   NOT: Trendyol Product API (/product/sellers/{id}/products) komisyon orani
 *   DONDURMEZ - yanitta yalnizca vatRate vardir (canli olarak dogrulandi).
 *   Bu yuzden oran icin sirasiyla:
 *     a) siparis satirindaki `commission`             (birincil, satir bazli)
 *     b) ayni barkodun mutabakattan gozlemlenen orani (ikincil)
 *     c) hesap genelinde gozlemlenen agirlikli oran   (son care)
 *   Hicbiri yoksa satir "oran bilinmiyor" olarak isaretlenir; UYDURULMAZ.
 *
 * ONEMLI KISIT: finance/che uc noktalari `size` icin YALNIZCA 500 ya da 1000
 * kabul eder. Baska deger HTTP 400 dondurur ve TUM mutabakat cagrisi sessizce
 * basarisiz olur (butun satirlar "bekliyor" gorunur).
 */

const SETTLEMENT_CHUNK_DAYS = 15;
const SETTLEMENT_PAGE_SIZE = 500;
const SETTLEMENT_ALLOWED_SIZES = [500, 1000];

/** settlements uc noktasinin kabul ettigi islem tipleri. */
const SETTLEMENT_TYPES = ['Sale', 'Return', 'Discount', 'DiscountCancel'];

/**
 * otherfinancials uc noktasinin KABUL ETTIGI tipler - API'nin kendi hata
 * mesajindan dogrulanmistir. Listede olmayan tip HTTP 400 dondurur.
 */
const OTHER_FINANCIAL_TYPES = [
  'ReturnInvoice',
  'CommissionAgreementInvoice',
  'DeductionInvoices',
  'FinancialItem',
  'Stoppage',
  'CreditNote',
  'CommissionInvoice',
];

const keyOf = (orderNumber, barcode) =>
  `${String(orderNumber ?? '').trim()}::${String(barcode ?? '').trim()}`;

/**
 * Iade/iptal yonlu islem mi?
 * Trendyol `transactionType`i yanitta TURKCE dondurebiliyor ("Satış", "İade"),
 * istekte ise Ingilizce bekliyor. Ikisini de taniyoruz.
 */
const isReversal = (type) => /return|cancel|negative|refund|iade|iptal/i.test(String(type ?? ''));

function pickAmount(record, candidates) {
  for (const field of candidates) {
    const raw = record?.[field];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

const COMMISSION_FIELDS = ['commissionAmount', 'commissionFee'];
const COMMISSION_RATE_FIELDS = ['commissionRate', 'commissionPercent'];
const SELLER_REVENUE_FIELDS = ['sellerRevenue', 'sellerRevenueAmount', 'paymentAmount'];
/**
 * Kargo/hizmet kesintisi Sale kaydinda GELMIYOR (canli yanitta boyle bir alan
 * yok). Hesaptan hesaba degisebildigi icin adaylar yine taranir; bulunamazsa
 * 0 yazilir - uydurma yapilmaz.
 */
const SHIPPING_FIELDS = ['deliveryFee', 'shipmentDeliveryFee', 'returnShipmentDeliveryFee', 'cargoFee', 'shippingFee'];
const SERVICE_FIELDS = ['serviceFee', 'platformServiceFee', 'processingFee'];
const DEBT_FIELDS = ['debt', 'debtAmount'];
const CREDIT_FIELDS = ['credit', 'creditAmount'];

/** Kaydin tekil kimligi - mukerrer toplama net ciroyu sessizce sisirir. */
function recordFingerprint(record, transactionType) {
  if (record?.id !== undefined && record?.id !== null && record.id !== '') return `id:${record.id}`;
  return [
    'k',
    String(record?.orderNumber ?? ''),
    String(record?.barcode ?? ''),
    String(record?.transactionType ?? transactionType ?? ''),
    String(record?.transactionDate ?? ''),
    String(record?.commissionAmount ?? ''),
    String(record?.debt ?? ''),
    String(record?.credit ?? ''),
  ].join('|');
}

/**
 * `otherfinancials` uc noktasi bazi islem tiplerinde Trendyol tarafinda
 * KALICI HTTP 500 donduruyor (CreditNote, CommissionInvoice ...). Bunlar
 * gecici hata degil; her tip icin 4 kez yeniden denemek raporu dakikalarca
 * bekletiyordu. Bu yuzden bu uc nokta "en iyi caba" ile ve TEK denemeyle
 * cagrilir; basarisiz olursa rapor komisyon verisiyle normal sekilde devam eder.
 */
async function fetchFrom(path, { startMs, endMs }, transactionTypes, { maxRetries } = {}) {
  const chunks = chunkRange(startMs, endMs, SETTLEMENT_CHUNK_DAYS);
  const byFingerprint = new Map();
  const failures = [];
  let duplicates = 0;

  for (const chunk of chunks) {
    for (const transactionType of transactionTypes) {
      try {
        const { items } = await fetchAllPages(
          sellerPath(path),
          { startDate: Math.trunc(chunk.startDate), endDate: Math.trunc(chunk.endDate), transactionType },
          { size: SETTLEMENT_PAGE_SIZE, allowedSizes: SETTLEMENT_ALLOWED_SIZES, maxRetries },
        );
        for (const item of items) {
          const record = { ...item, requestedType: transactionType };
          const key = recordFingerprint(item, transactionType);
          if (byFingerprint.has(key)) {
            duplicates += 1;
            continue;
          }
          byFingerprint.set(key, record);
        }
      } catch (error) {
        failures.push({
          transactionType,
          status: error?.details?.status ?? null,
          message: String(error?.message ?? '').slice(0, 160),
        });
        logger.warn('settlement fetch failed for type', {
          path,
          transactionType,
          status: error?.details?.status ?? null,
        });
      }
    }
  }

  if (duplicates > 0) logger.info('duplicate settlement records ignored', { path, duplicates });
  return { records: [...byFingerprint.values()], failures };
}

/** Ham mutabakat kayitlarini siparis+barkod bazinda toplar. */
function buildLedgerMap(records) {
  const map = new Map();

  for (const record of records) {
    const key = keyOf(record?.orderNumber, record?.barcode);
    if (key === '::') continue;

    if (!map.has(key)) {
      map.set(key, {
        commission: 0,
        commissionRefund: 0,
        shipping: 0,
        service: 0,
        other: 0,
        sellerRevenue: null,
        rate: null,
        types: new Set(),
        count: 0,
      });
    }
    const entry = map.get(key);
    entry.count += 1;
    if (record.transactionType) entry.types.add(record.transactionType);

    const reversal = isReversal(record.transactionType) || isReversal(record.requestedType);
    const sign = reversal ? -1 : 1;

    const commission = pickAmount(record, COMMISSION_FIELDS);
    if (commission !== null) {
      const magnitude = Math.abs(commission);
      entry.commission += sign * magnitude;
      if (reversal) entry.commissionRefund += magnitude;
    }

    const rate = pickAmount(record, COMMISSION_RATE_FIELDS);
    if (rate !== null && !reversal) entry.rate = rate;

    const revenue = pickAmount(record, SELLER_REVENUE_FIELDS);
    if (revenue !== null) entry.sellerRevenue = (entry.sellerRevenue ?? 0) + sign * Math.abs(revenue);

    const shipping = pickAmount(record, SHIPPING_FIELDS);
    if (shipping !== null) entry.shipping += Math.abs(shipping);

    const service = pickAmount(record, SERVICE_FIELDS);
    if (service !== null) entry.service += Math.abs(service);

    if (OTHER_FINANCIAL_TYPES.includes(record.requestedType)) {
      const debt = pickAmount(record, DEBT_FIELDS) ?? 0;
      const credit = pickAmount(record, CREDIT_FIELDS) ?? 0;
      entry.other += Math.abs(debt) - Math.abs(credit);
    }
  }

  return map;
}

/**
 * Mutabakattan GOZLEMLENEN komisyon oranlari (barkod bazinda).
 * Siparis satirinda oran gelmediginde ayni urunun gercek oranini kullanmak icin.
 */
function buildObservedRates(records) {
  const byBarcode = new Map();
  let totalCommission = 0;
  let totalBase = 0;

  for (const record of records) {
    if (isReversal(record.transactionType) || isReversal(record.requestedType)) continue;
    const rate = pickAmount(record, COMMISSION_RATE_FIELDS);
    const barcode = String(record?.barcode ?? '').trim();

    const commission = pickAmount(record, COMMISSION_FIELDS);
    const credit = pickAmount(record, CREDIT_FIELDS);
    if (commission !== null && credit) {
      totalCommission += Math.abs(commission);
      totalBase += Math.abs(credit);
    }

    if (rate === null || !barcode) continue;
    if (!byBarcode.has(barcode)) byBarcode.set(barcode, { sum: 0, count: 0 });
    const entry = byBarcode.get(barcode);
    entry.sum += rate;
    entry.count += 1;
  }

  const perBarcode = new Map();
  for (const [barcode, { sum, count }] of byBarcode) perBarcode.set(barcode, sum / count);

  const accountRate = totalBase > 0 ? (totalCommission / totalBase) * 100 : null;
  return { perBarcode, accountRate };
}

/**
 * Secilen aralik icin finans defterini kurar.
 *
 * @returns {Promise<{
 *   resolveFor: (line) => object,
 *   resolveRate: (line) => { rate: number|null, rateSource: string },
 *   available: boolean, warnings: string[], diagnostics: object,
 * }>}
 */
export async function buildFinanceLedger({ startMs, endMs }) {
  // Mutabakat kayitlari satis gununden sonra olusur; pencere genisletilir.
  const from = startMs - 30 * 86_400_000;
  const to = Math.min(endMs + 60 * 86_400_000, Date.now());

  const warnings = [];
  let ledger = new Map();
  let observed = { perBarcode: new Map(), accountRate: null };
  let diagnostics = {
    settlementRecords: 0,
    otherRecords: 0,
    matchedKeys: 0,
    seenTypes: [],
    observedRateBarcodes: 0,
    accountCommissionRate: null,
    failures: [],
  };
  let available = false;

  try {
    const { settlements, others } = await cached(`finance:${from}:${to}`, async () => {
      const [settlementResult, otherResult] = await Promise.all([
        fetchFrom('/finance/che/sellers/:sellerId/settlements', { startMs: from, endMs: to }, SETTLEMENT_TYPES),
        fetchFrom(
          '/finance/che/sellers/:sellerId/otherfinancials',
          { startMs: from, endMs: to },
          OTHER_FINANCIAL_TYPES,
          { maxRetries: 0 }, // en iyi caba - kalici 500'lerde raporu bekletme
        ),
      ]);
      return { settlements: settlementResult, others: otherResult };
    });

    const allRecords = [...settlements.records, ...others.records];
    ledger = buildLedgerMap(allRecords);
    observed = buildObservedRates(settlements.records);
    available = allRecords.length > 0;

    diagnostics = {
      settlementRecords: settlements.records.length,
      otherRecords: others.records.length,
      matchedKeys: ledger.size,
      seenTypes: [...new Set(allRecords.map((r) => r.transactionType))].filter(Boolean).slice(0, 20),
      observedRateBarcodes: observed.perBarcode.size,
      accountCommissionRate: observed.accountRate === null ? null : round2(observed.accountRate),
      failures: [...settlements.failures, ...others.failures],
    };

    logger.info('finance ledger built', {
      settlements: settlements.records.length,
      others: others.records.length,
      keys: ledger.size,
      observedRates: observed.perBarcode.size,
    });

    if (!available) {
      warnings.push(
        'Mutabakat kayıtları bu tarih aralığı için boş döndü. Komisyonlar satır bazlı gerçek oranla TAHMİNİ hesaplandı.',
      );
    }
  } catch (error) {
    warnings.push(
      `Trendyol Finans/Mutabakat API'sine erişilemedi (${error.message}). ` +
        'Komisyonlar sipariş satırındaki gerçek orandan TAHMİNİ hesaplandı.',
    );
    logger.error('finance ledger unavailable', { error: error.message });
  }

  /**
   * Satirin komisyon oranini (yuzde) ve kaynagini belirler.
   * Sira: satirin kendi orani > barkodun gozlemlenen orani > hesap geneli.
   */
  const resolveRate = (line) => {
    const own = Number(line?.commissionRate);
    if (Number.isFinite(own) && own > 0) return { rate: own, rateSource: 'orderLine' };

    const barcode = String(line?.barcode ?? '').trim();
    const perBarcode = observed.perBarcode.get(barcode);
    if (Number.isFinite(perBarcode) && perBarcode > 0) return { rate: perBarcode, rateSource: 'settlementObserved' };

    if (Number.isFinite(observed.accountRate) && observed.accountRate > 0) {
      return { rate: observed.accountRate, rateSource: 'accountAverage' };
    }
    return { rate: null, rateSource: 'unknown' };
  };

  return {
    available,
    warnings,
    diagnostics,
    resolveRate,
    /**
     * settled:true  -> KESINLESMIS (Trendyol mutabakat kaydindan)
     * settled:false -> TAHMINI     (satirin gercek komisyon orani ile)
     */
    resolveFor(line) {
      const hit = ledger.get(keyOf(line.orderNumber, line.barcode));

      if (hit && hit.count > 0) {
        return {
          settled: true,
          basis: 'settlement',
          commission: round2(hit.commission),
          commissionRefunded: round2(hit.commissionRefund),
          commissionRate: hit.rate,
          rateSource: 'settlement',
          shippingFee: round2(hit.shipping),
          serviceFee: round2(hit.service),
          otherDeductions: round2(hit.other),
          sellerRevenue: hit.sellerRevenue === null ? null : round2(hit.sellerRevenue),
          transactionTypes: [...hit.types],
          recordCount: hit.count,
          note: '',
        };
      }

      // --- TAHMINI: satirin kendi komisyon orani ile ---
      const { rate, rateSource } = resolveRate(line);
      const gross = Number(line?.grossAmount) || 0;
      const estimated = rate === null ? 0 : round2(gross * (rate / 100));

      return {
        settled: false,
        basis: rate === null ? 'unknown' : 'estimate',
        commission: estimated,
        commissionRefunded: 0,
        commissionRate: rate,
        rateSource,
        shippingFee: 0,
        serviceFee: 0,
        otherDeductions: 0,
        sellerRevenue: null,
        transactionTypes: [],
        recordCount: 0,
        note:
          rate === null
            ? 'Komisyon oranı bulunamadı (mutabakat kaydı da yok)'
            : `Mutabakat henüz oluşmadı — %${round2(rate)} oranı ile tahmin edildi`,
      };
    },
  };
}
