import { env } from '../config/env.js';
import {
  dayKey,
  enumerateDays,
  isWithinLocalDayRange,
  formatDateTime,
  formatTime,
  zonedDayEnd,
  zonedDayStart,
} from '../lib/dates.js';
import { num, round2 } from '../lib/money.js';
import { notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  LINE_STATUS,
  STATUS_LABELS_TR,
  UNKNOWN_CUSTOMER,
  buildProductCatalog,
  fetchOrderLines,
} from './ordersService.js';
import { applyClaimsToLines, claimRowKey, fetchClaims } from './claimsService.js';
import { buildFinanceLedger } from './financeService.js';
import { auditWaterfall, computeRowFinancials, sumFinancials } from './revenueService.js';

/**
 * RAPOR MOTORU
 *
 * Siparis satirlari (Orders API) + iade/iptal talepleri (Claims API) burada
 * birlestirilir, gun bazinda gruplanir ve net ciro hesaplanir.
 *
 * NET CIRO KURALLARI (bkz. revenueService.js - tek formul orada)
 *   Net = Brüt Satış − Komisyon − Kargo/Hizmet − İade/İptal Geri Ödemeleri
 *
 * Komisyon ve kargo/hizmet kesintileri Trendyol Mutabakat (Settlement)
 * API'sinden ISLEM BAZINDA okunur. .env'deki sabit oranlar KULLANILMAZ.
 * Mutabakat kaydi olusmamis satirlar "mutabakat bekliyor" olarak isaretlenir
 * ve tutarlari uydurulmaz.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Aynı saatte düşen kayıtlarda gösterim sırası */
const STATUS_ORDER = {
  [LINE_STATUS.SALE]: 0,
  [LINE_STATUS.CANCELLED]: 1,
  [LINE_STATUS.RETURNED]: 2,
  [LINE_STATUS.UNSUPPLIED]: 3,
};

const FALLBACK_REASONS = {
  [LINE_STATUS.CANCELLED]: 'Belirtilmemiş (satıcı/sistem iptali)',
  [LINE_STATUS.RETURNED]: 'Belirtilmemiş (iade talebi eşleşmedi)',
  [LINE_STATUS.UNSUPPLIED]: 'Tedarik edilemedi',
};

/** Trendyol statü kodları için Türkçe karşılıklar (Excel'de ham statü sütunu için) */
const RAW_STATUS_TR = {
  Awaiting: 'Onay bekliyor',
  Created: 'Oluşturuldu',
  Picking: 'Hazırlanıyor',
  Invoiced: 'Faturalandı',
  Shipped: 'Kargoya verildi',
  AtCollectionPoint: 'Teslimat noktasında',
  Delivered: 'Teslim edildi',
  Cancelled: 'İptal edildi',
  UnSupplied: 'Tedarik edilemedi',
  Returned: 'İade edildi',
  UnDelivered: 'Teslim edilemedi',
  UnPacked: 'Paket bölündü',
};

export function translateRawStatus(status) {
  return RAW_STATUS_TR[status] ?? status ?? '';
}

function parseRange({ startDate, endDate }) {
  const tz = env.REPORT_TIMEZONE;
  const startMs = zonedDayStart(startDate, tz);
  const endMs = zonedDayEnd(endDate, tz);
  if (endMs < startMs) throw new Error('Bitiş tarihi başlangıç tarihinden önce olamaz.');
  const days = Math.ceil((endMs - startMs) / DAY_MS);
  if (days > env.MAX_RANGE_DAYS) {
    throw new Error(`Tarih aralığı en fazla ${env.MAX_RANGE_DAYS} gün olabilir (seçilen: ${days} gün).`);
  }
  return { startMs, endMs, timeZone: tz, startDate, endDate };
}

/** Ürün listesi ekranı için: aralıkta satılmış tüm farklı ürünler. */
export async function getProductCatalog({ startDate, endDate }) {
  const range = parseRange({ startDate, endDate });
  const [rawLines, claimRows, finance] = await Promise.all([
    fetchOrderLines({ ...range, startDate, endDate }),
    fetchClaims(range),
    buildFinanceLedger(range),
  ]);

  // IADELER siparis statusunden degil /claims'ten gelir; iptaller satir
  // statusunden. Ikisi burada birlestirilir ve birbirine karismaz.
  const { lines: orderLines, stats: claimStats } = applyClaimsToLines(rawLines, claimRows);

  // Panel ve Excel AYNI formulu kullansin diye finansal hesap tek yerden gelir.
  const financialsFor = (line) =>
    computeRowFinancials({
      status: line.status,
      grossAmount: line.grossAmount,
      share: 1,
      finance: finance.resolveFor(line),
      returnShippingFee: line.status === LINE_STATUS.RETURNED ? env.RETURN_SHIPPING_FEE : 0,
    });

  const products = buildProductCatalog(orderLines, financialsFor);

  /**
   * SIPARIS SAYISI tum urunler icin TEK SEFER sayilir.
   * Urun bazindaki `orderCount` degerlerini toplamak YANLIS olurdu: iki farkli
   * urun ayni siparise ait olabilir ve o siparis iki kez sayilirdi.
   */
  const distinctOrders = new Set(orderLines.map((line) => String(line.orderNumber)));

  const totals = products.reduce(
    (acc, p) => ({
      products: acc.products + 1,
      variants: acc.variants + p.variantCount,
      totalGrossRevenue: round2(acc.totalGrossRevenue + p.totalGrossRevenue),
      cancelledReturnedGross: round2(acc.cancelledReturnedGross + p.cancelledReturnedGross),
      netSales: round2(acc.netSales + p.netSales),
      quantitySold: acc.quantitySold + p.quantitySold,
      quantityCancelled: acc.quantityCancelled + p.quantityCancelled,
      quantityReturned: acc.quantityReturned + p.quantityReturned,
      quantityUnsupplied: acc.quantityUnsupplied + p.quantityUnsupplied,
      quantityReturnPending: acc.quantityReturnPending + p.quantityReturnPending,
      grossSales: round2(acc.grossSales + p.grossSales),
      commission: round2(acc.commission + p.commission),
      shippingFee: round2(acc.shippingFee + p.shippingFee),
      excludedAmount: round2(acc.excludedAmount + (p.excludedAmount ?? 0)),
      refunds: 0,
      netRevenue: round2(acc.netRevenue + p.netRevenue),
      estimatedLines: acc.estimatedLines + p.estimatedLines,
      settledLines: acc.settledLines + p.settledLines,
    }),
    {
      products: 0, variants: 0, totalGrossRevenue: 0, cancelledReturnedGross: 0, netSales: 0,
      quantitySold: 0, quantityCancelled: 0, quantityReturned: 0,
      quantityUnsupplied: 0, quantityReturnPending: 0,
      grossSales: 0, commission: 0, shippingFee: 0, excludedAmount: 0, refunds: 0, netRevenue: 0,
      estimatedLines: 0, settledLines: 0,
    },
  );

  totals.orderCount = distinctOrders.size;
  totals.deductions = round2(totals.commission + totals.shippingFee);
  totals.waterfallBalanced =
    Math.abs(totals.totalGrossRevenue - totals.cancelledReturnedGross - totals.netSales) <= 0.05 &&
    Math.abs(totals.netSales - totals.deductions - totals.netRevenue) <= 0.05;

  return {
    range: { startDate, endDate, timeZone: range.timeZone },
    totals,
    products,
    finance: {
      available: finance.available,
      warnings: finance.warnings,
      settledLines: totals.settledLines,
      estimatedLines: totals.estimatedLines,
      diagnostics: finance.diagnostics,
    },
    // Mali musavirin iptal/iade sayilarini Trendyol paneliyle karsilastirabilmesi icin
    claims: claimStats,
    /**
     * TARIH FILTRESI TESHISI
     * `droppedByDateFilter` buyukse Trendyol tarih filtresini yok sayiyor
     * demektir; bizim yerel gun filtremiz yine de dogru araligi birakir.
     */
    dateFilter: rawLines.dateFilterStats ?? null,
    /**
     * TRENDYOL PANELI ILE KARSILASTIRMA REHBERI
     * Trendyol Satici Paneli'ndeki ciro rakami iptal/iade edilen kalemleri
     * ICERMEZ. Bu yuzden panelle karsilastirilacak dogru alan
     * `totals.netSales`tir - `totalGrossRevenue` DEGIL (o, talebiniz uzerine
     * iptal/iade DAHIL toplami gosterir).
     */
    trendyolKarsilastirma: {
      panelleKarsilastirilacakAlan: 'netSales',
      netSales: totals.netSales,
      totalGrossRevenue: totals.totalGrossRevenue,
      cancelledReturnedGross: totals.cancelledReturnedGross,
      not:
        'Trendyol paneli iptal/iade edilen tutarları ciroya katmaz. ' +
        'Panelle birebir karşılaştırma için "Net Satış" değerini kullanın.',
    },
  };
}

/**
 * Bir ürünün gün gün detay raporu.
 * Excel üretimi de, ekrandaki önizleme de bu tek fonksiyondan beslenir.
 */
export async function buildProductDailyReport({
  startDate,
  endDate,
  barcode,
  parentKey = null,
  includeEmptyDays = true,
}) {
  const range = parseRange({ startDate, endDate });
  const tz = range.timeZone;

  const [rawLines, claimRows, finance] = await Promise.all([
    fetchOrderLines({ ...range, startDate, endDate }),
    fetchClaims(range),
    buildFinanceLedger(range),
  ]);

  // IPTAL: satir statusunden (kati).  IADE: yalnizca /claims'ten.
  const { lines: orderLines, stats: claimStats, usedClaimKeys } = applyClaimsToLines(rawLines, claimRows);

  // Rapor ya tek bir varyant (barkod) ya da ana urunun TUM varyantlari icin
  // uretilebilir. Ana urun raporunda beden kirilimi Excel'de korunur.
  const target = String(barcode ?? '').trim();
  const parentTarget = parentKey ? String(parentKey).trim() : null;

  const productLines = parentTarget
    ? orderLines.filter((line) => line.parentKey === parentTarget)
    : orderLines.filter((line) => line.barcode === target || line.merchantSku === target);

  if (productLines.length === 0) {
    throw notFound(
      parentTarget
        ? `Seçilen tarih aralığında bu ürüne ait sipariş bulunamadı.`
        : `Seçilen tarih aralığında "${target}" barkodlu ürüne ait sipariş bulunamadı.`,
    );
  }

  const variantLabels = [...new Set(productLines.map((l) => l.variantLabel).filter(Boolean))];
  const product = {
    barcode: parentTarget ? '' : productLines[0].barcode || target,
    parentKey: productLines[0].parentKey,
    merchantSku: productLines[0].merchantSku,
    productName: parentTarget ? productLines[0].parentName : productLines[0].productName || 'İsimsiz ürün',
    parentName: productLines[0].parentName,
    productCode: productLines[0].productCode,
    brand: productLines[0].brand,
    isParentReport: Boolean(parentTarget),
    variantLabels,
    variantCount: variantLabels.length,
  };

  const warnings = [...finance.warnings];
  const rows = [];

  for (const line of productLines) {
    const claimRow = line.claim ?? null;
    // Kismi iade: satirin yalnizca iade edilen adedi IADE, kalani SATIS olur.
    const lineFinance = finance.resolveFor(line);
    const unitGross = line.quantity > 0 ? line.grossAmount / line.quantity : line.grossAmount;

    /** Satırın bir bölümünü rapor kaydına çevirir. */
    const emit = ({ status, quantity, claim }) => {
      if (quantity <= 0) return;

      const grossAmount = round2(unitGross * quantity);
      const share = line.quantity > 0 ? quantity / line.quantity : 1;
      /**
       * RAPOR GUNU = SIPARIS GUNU (her durumda).
       *
       * Iade satirlari da siparisin gunune yazilir; talep tarihine DEGIL.
       * Nedenleri:
       *  1) Iade talebi siparisten haftalar sonra acilabildigi icin, talep
       *     gunune yazmak satirlarin secili araligin DISINA dusmesine ve
       *     "0 iade" gorunmesine yol aciyordu.
       *  2) Bir gunun net cirosu, O GUN verilen siparislerden gerceklesen
       *     tutardir. Iade, o gune ait bir siparisin ciroya katkisini geri
       *     alir; dolayisiyla ayni gune yazilmasi gerekir.
       *  3) Boylece gunluk satirlarin toplami GENEL TOPLAM ile birebir eslesir.
       *
       * Talebin gercek tarihi ayrica `claimDateText` sutununda gosterilir.
       */
      const eventDate = line.orderDate;
      const day = dayKey(eventDate, tz);

      // TEK FORMUL: tutarlar mutabakattan gelir, .env sabitleri kullanilmaz.
      const fin = computeRowFinancials({
        status,
        grossAmount,
        share,
        finance: lineFinance,
        // IADE KARGOSU YALNIZCA IADELERE uygulanir; iptallerde asla.
        returnShippingFee: status === LINE_STATUS.RETURNED ? env.RETURN_SHIPPING_FEE : 0,
      });
      const shippingFee = status === LINE_STATUS.SALE ? fin.shipping : 0;
      const returnShippingFee = status === LINE_STATUS.SALE ? 0 : fin.shipping;
      const deductions = round2(fin.commission + fin.shipping);
      const netRevenue = fin.netRevenue;

      const reason =
        status === LINE_STATUS.SALE
          ? ''
          : claim?.reason || line.packageCancelReason || FALLBACK_REASONS[status];

      rows.push({
        day,
        eventDate,
        orderDate: line.orderDate,
        orderDateText: formatDateTime(line.orderDate, tz),
        eventDateText: formatDateTime(eventDate, tz),
        orderTime: formatTime(line.orderDate, tz),
        eventTime: formatTime(eventDate, tz),
        status,
        statusLabel: STATUS_LABELS_TR[status],
        orderNumber: line.orderNumber,
        customerFirstName: line.customerFirstName,
        customerLastName: line.customerLastName,
        customerFullName: line.customerFullName,
        packageId: line.packageId,
        orderLineId: line.orderLineId,
        quantity,
        unitPrice: round2(line.unitPrice),
        grossAmount,
        // --- finansal kalemler (hepsi mutabakat kaydindan) ---
        grossSales: fin.grossSales,
        excluded: fin.excluded,
        excludedAmount: fin.excluded,
        refund: 0,
        commission: fin.commission,
        commissionRefunded: fin.commissionRefunded,
        commissionRate: fin.commissionRate,
        commissionSource: fin.commissionRateSource,
        settled: fin.settled,
        /** Mali musavir icin: "Kesinleşmiş" | "Tahmini" | "Bilinmiyor" */
        valuationLabel: fin.valuationLabel,
        valuationBasis: fin.valuationBasis,
        settlementNote: fin.settlementNote,
        transactionTypes: fin.transactionTypes,
        returnSource: line.returnSource ?? null,
        returnPendingQuantity: line.returnPendingQuantity ?? 0,
        shippingFee: round2(shippingFee),
        returnShippingFee: round2(returnShippingFee),
        shipping: fin.shipping,
        deductions,
        netRevenue,
        reason,
        reasonSource: claim?.reason
          ? `Claims API (${line.claimMatchedBy ?? 'eşleşti'})`
          : line.packageCancelReason
            ? 'Sipariş paketi'
            : status === LINE_STATUS.SALE
              ? ''
              : 'Eşleşme yok',
        claimId: claim?.claimId ?? '',
        claimStatus: claim?.status ?? '',
        claimDateText: claim?.claimDate ? formatDateTime(claim.claimDate, tz) : '',
        customerNote: claim?.customerNote ?? '',
        rawLineStatus: translateRawStatus(line.rawLineStatus),
        rawPackageStatus: translateRawStatus(line.rawPackageStatus),
        productSize: line.productSize,
        productColor: line.productColor,
        variantLabel: line.variantLabel,
        parentKey: line.parentKey,
        parentName: line.parentName,
        productName: line.productName,
        barcode: line.barcode,
        merchantSku: line.merchantSku,
        cargoProvider: line.cargoProvider,
      });
    };

    if (line.status === LINE_STATUS.CANCELLED) {
      // IPTAL: satir statusu kesin, iade talebi olsa bile iptal kalir.
      emit({ status: LINE_STATUS.CANCELLED, quantity: line.quantity, claim: claimRow });
    } else if (line.status === LINE_STATUS.UNSUPPLIED) {
      emit({ status: LINE_STATUS.UNSUPPLIED, quantity: line.quantity, claim: claimRow });
    } else if (line.status === LINE_STATUS.RETURNED) {
      // Kismi iade bolunmesi applyClaimsToLines icinde YAPILDI; burada satir
      // artik tek bir statuye aittir.
      emit({ status: LINE_STATUS.RETURNED, quantity: line.quantity, claim: claimRow });
    } else {
      emit({ status: LINE_STATUS.SALE, quantity: line.quantity, claim: null });
    }
  }

  /**
   * NOT: "Secili aralikten ONCE satilip bu aralikta iade edilen urunler" icin
   * ayri satir URETILMEZ.
   *
   * Yeni net ciro tanimina gore (bkz. revenueService.js) iade edilen bir
   * kalemin brut tutari ciroya HIC girmez ve komisyonu Trendyol tarafindan
   * geri odenir. Onceki doneme ait bir siparisin brutu bu donemde zaten
   * sayilmadigi icin, iadesini bu doneme negatif olarak yazmak cift sayim
   * olurdu ve gunluk satirlarin toplami genel toplamdan sapardi.
   *
   * Boyle bir iade, ilgili siparisin KENDI donemi raporlandiginda dogru
   * sekilde gorunur.
   */

  /**
   * SIKI ARALIK FILTRESI (mali musavir denetimi icin kritik)
   * ---------------------------------------------------------------------
   * Bir satirin rapor gunu `eventDate`tir (satis -> siparis tarihi,
   * iade -> talep tarihi). Claims sorgusu, gec gelen iadeleri yakalamak icin
   * pencereden 15 gun ILERIYE tasindigindan, secili araligin DISINA dusen
   * satirlar uretilmis olabilir. Bunlar burada kesin olarak elenir; aksi
   * halde "Günlük Özet" toplami gun satirlarinin toplamini tutmaz ve
   * Excel'in "Ham Veri" sayfasina aralik disi kayit sizardi.
   */
  const inRange = [];
  const droppedOutOfRange = [];
  for (const row of rows) {
    const at = num(row.eventDate, null);
    /**
     * Ham timestamp yerine Istanbul TAKVIM GUNU metni karsilastirilir.
     * Boylece gun sinirindaki (23:5x / 00:0x) satirlar offset kaymasi yuzunden
     * yanlis gune dusup elenmez.
     */
    if (at === null || !isWithinLocalDayRange(at, startDate, endDate, tz)) {
      droppedOutOfRange.push(row);
      continue;
    }
    inRange.push(row);
  }
  rows.length = 0;
  rows.push(...inRange);

  logger.info(
    `[Date Filter Applied] Range: ${startDate} to ${endDate} | ` +
      `Total Rows Processed: ${inRange.length + droppedOutOfRange.length} | ` +
      `Rows Dropped by Date Filter: ${droppedOutOfRange.length}`,
    {
      urun: target || parentTarget,
      saatDilimi: tz,
      karsilastirma: 'Istanbul takvim gunu metni (YYYY-MM-DD), ham timestamp DEGIL',
    },
  );

  // --- Gün bazında grupla -------------------------------------------------
  const byDay = new Map();
  for (const row of rows) {
    if (!row.day) continue;
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    byDay.get(row.day).push(row);
  }

  const allDays = includeEmptyDays
    ? enumerateDays(startDate, endDate, tz)
    : [...byDay.keys()].sort();

  const days = allDays
    .filter((d) => includeEmptyDays || byDay.has(d))
    .map((date) => {
      const dayRows = (byDay.get(date) ?? [])
        .sort(
          (a, b) =>
            // 1) işlem saati  2) sipariş no  3) durum (Satış > İptal > İade)
            num(a.eventDate) - num(b.eventDate) ||
            String(a.orderNumber).localeCompare(String(b.orderNumber), 'tr', { numeric: true }) ||
            STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
        )
        // Gün içi sıra numarası: mutabakatta satır saymayı kolaylaştırır
        .map((row, index) => ({ ...row, sequence: index + 1 }));

      return { date, rows: dayRows, totals: totalsOf(dayRows) };
    });

  const totals = totalsOf(rows);
  const reasons = buildReasonBreakdown(rows);

  const estimatedRows = rows.filter((row) => row.settled === false && row.valuationBasis === 'estimate');
  const unknownRows = rows.filter((row) => row.valuationBasis === 'unknown' && row.status === LINE_STATUS.SALE);

  if (estimatedRows.length > 0) {
    warnings.push(
      `${estimatedRows.length} satır için Trendyol mutabakat kaydı henüz oluşmamış. ` +
        'Bu satırların komisyonu, siparişteki GERÇEK komisyon oranı kullanılarak hesaplandı ' +
        've raporda "Tahmini" olarak etiketlendi.',
    );
  }
  if (unknownRows.length > 0) {
    warnings.push(
      `${unknownRows.length} satır için ne mutabakat kaydı ne de komisyon oranı bulunabildi; ` +
        'bu satırlar "Bilinmiyor" olarak işaretlendi.',
    );
  }

  logger.info('daily report built', {
    barcode: target,
    rows: rows.length,
    days: days.length,
    net: totals.netRevenue,
  });

  return {
    product,
    range: { startDate, endDate, timeZone: tz },
    days,
    rows,
    totals,
    reasons,
    meta: {
      generatedAt: formatDateTime(Date.now(), tz),
      orderLineCount: productLines.length,
      claimItemCount: claimRows.filter((c) => c.barcode === target).length,
      // Tutarlarin kaynagi: her zaman Trendyol mutabakat kayitlari
      commissionSource: 'hybrid',
      financeAvailable: finance.available,
      settledRows: rows.filter((r) => r.settled).length,
      estimatedRows: estimatedRows.length,
      unknownRows: unknownRows.length,
      rowsOutsideRangeDropped: droppedOutOfRange.length,
      returnShippingFee: env.RETURN_SHIPPING_FEE,
      financeDiagnostics: finance.diagnostics,
      claimStats,
      warnings,
    },
  };
}

export function totalsOf(rows) {
  const acc = {
    quantitySold: 0,
    quantityCancelled: 0,
    quantityReturned: 0,
    orderCount: 0,
    customerCount: 0,
    /**
     * MALI MUSAVIR (CPA) DENETIM SUTUNU - 5 ADIMLI ACIK KIRILIM
     * ---------------------------------------------------------------------
     *   1) totalGrossRevenue      Ilk Brut Ciro  (TUM siparisler dahil)
     *   2) cancelledReturnedGross Iptal/Iade Edilen Tutar
     *   3) netSales               Net Satis      = (1) − (2)
     *   4) deductions             Komisyon + Kargo (yalnizca basarili siparisler)
     *   5) netRevenue             Net Ciro       = (3) − (4)
     *
     * Iptal/iade edilen brut tutar ARTIK GORUNMEZ SEKILDE DUSULMUYOR;
     * her adim ayri ayri raporlanir ve denetimde izlenebilir.
     */
    totalGrossRevenue: 0,
    cancelledReturnedGross: 0,
    netSales: 0,
    // eski ad: net satis ile ayni deger (aktif siparislerin brutu)
    grossSales: 0,
    cancelledAmount: 0,
    returnedAmount: 0,
    unsuppliedAmount: 0,
    // finansal kalemler
    commission: 0,
    shippingFee: 0,
    // Iptal/iade edilen brut tutar - BILGI amaclidir, net cirodan ayrica
    // dusulmez (hic eklenmemistir).
    excludedAmount: 0,
    refunds: 0,
    deductions: 0,
    netRevenue: 0,
    settledRows: 0,
    estimatedRows: 0,
    unknownRows: 0,
    quantityUnsupplied: 0,
  };
  const orders = new Set();
  const customers = new Set();

  for (const row of rows) {
    orders.add(row.orderNumber);
    if (row.customerFullName && row.customerFullName !== UNKNOWN_CUSTOMER) customers.add(row.customerFullName);

    // Kovalar birbirini DISLAR: iptal ve iade asla ayni adete yazilmaz.
    if (row.status === LINE_STATUS.CANCELLED) {
      acc.quantityCancelled += row.quantity;
      acc.cancelledAmount += row.grossAmount;
    } else if (row.status === LINE_STATUS.RETURNED) {
      acc.quantityReturned += row.quantity;
      acc.returnedAmount += row.grossAmount;
    } else if (row.status === LINE_STATUS.UNSUPPLIED) {
      acc.quantityUnsupplied += row.quantity;
      acc.unsuppliedAmount += row.grossAmount;
    } else {
      acc.quantitySold += row.quantity;
    }

    if (row.settled) acc.settledRows += 1;
    else if (row.valuationBasis === 'estimate') acc.estimatedRows += 1;
    else if (row.status !== LINE_STATUS.CANCELLED) acc.unknownRows += 1;
  }

  // Finansal toplam ve OZDESLIK KONTROLU tek yerden (revenueService).
  const financial = sumFinancials(rows);
  acc.grossSales = financial.grossSales;
  acc.commission = financial.commission;
  acc.shippingFee = financial.shipping;
  acc.excludedAmount = financial.excluded;
  acc.refunds = 0;
  acc.netRevenue = financial.netRevenue;
  acc.deductions = round2(financial.commission + financial.shipping);

  // --- 5 ADIMLI DENETIM KIRILIMI ---
  acc.cancelledReturnedGross = round2(acc.cancelledAmount + acc.returnedAmount + acc.unsuppliedAmount);
  acc.netSales = financial.grossSales;                                   // (3)
  acc.totalGrossRevenue = round2(acc.netSales + acc.cancelledReturnedGross); // (1)
  /**
   * Adimlarin fiilen tuttugunun kaniti:
   *   (3) = (1) − (2)   ve   (5) = (3) − (4)
   * Tutmazsa `waterfallBalanced:false` olur ve rapor incelenmelidir.
   */
  /**
   * SIKI DENETIM: cift dusum ve satir bazli tutarsizlik kontrolu.
   * Ihlal bulunursa sessizce gecilmez - hem loga hem rapora yazilir.
   */
  const audit = auditWaterfall(rows);
  acc.waterfallBalanced = audit.ok;
  acc.waterfallViolations = audit.violations.slice(0, 20);
  if (!audit.ok) {
    logger.error('SELALE BUTUNLUK IHLALI', {
      ihlalSayisi: audit.violations.length,
      ilkIhlaller: audit.violations.slice(0, 5),
    });
  }
  /**
   * Net = Brüt(aktif) − Komisyon − Kargo  ozdesliginin fiilen tuttugunun kaniti.
   * `balanced:false` gorulurse rapor MUTLAKA incelenmeli (sessizce gecilmez).
   */
  acc.balanced = financial.balanced;
  acc.balanceDelta = financial.balanceDelta;

  /**
   * SIPARIS SAYISI = benzersiz SIPARIS NUMARASI adedi.
   * Trendyol Satici Paneli'ndeki "Sipariş" sayaci da budur; satir/adet sayisi
   * DEGILDIR. Bir siparis birden fazla urun satiri ve birden fazla kargo
   * paketi icerebilir - hepsi TEK siparistir.
   */
  acc.orderCount = orders.size;
  acc.customerCount = customers.size;
  for (const key of ['cancelledAmount', 'returnedAmount', 'unsuppliedAmount']) acc[key] = round2(acc[key]);

  const soldPlusLost =
    acc.quantitySold + acc.quantityCancelled + acc.quantityReturned + acc.quantityUnsupplied;
  const lost = acc.quantityCancelled + acc.quantityReturned + acc.quantityUnsupplied;
  acc.returnRate = soldPlusLost > 0 ? Math.round((lost / soldPlusLost) * 1000) / 10 : 0;
  // Iptal ve iade oranlari AYRI raporlanir (mali musavir ikisini karistirmamali)
  acc.cancelRate = soldPlusLost > 0 ? Math.round((acc.quantityCancelled / soldPlusLost) * 1000) / 10 : 0;
  acc.returnOnlyRate = soldPlusLost > 0 ? Math.round((acc.quantityReturned / soldPlusLost) * 1000) / 10 : 0;
  return acc;
}

/** İptal/iade nedenlerinin dağılımı (Excel'de ayrı sayfa, ekranda grafik). */
export function buildReasonBreakdown(rows) {
  const map = new Map();

  for (const row of rows) {
    if (row.status === LINE_STATUS.SALE) continue;
    const reason = row.reason || FALLBACK_REASONS[row.status];
    const key = `${row.status}::${reason}`;
    if (!map.has(key)) {
      map.set(key, {
        status: row.status,
        statusLabel: STATUS_LABELS_TR[row.status],
        reason,
        count: 0,
        quantity: 0,
        amount: 0,
      });
    }
    const entry = map.get(key);
    entry.count += 1;
    entry.quantity += row.quantity;
    entry.amount = round2(entry.amount + row.grossAmount);
  }

  const list = [...map.values()].sort((a, b) => b.quantity - a.quantity || b.amount - a.amount);
  const totalQuantity = list.reduce((s, r) => s + r.quantity, 0);
  return list.map((entry) => ({
    ...entry,
    share: totalQuantity > 0 ? Math.round((entry.quantity / totalQuantity) * 1000) / 10 : 0,
  }));
}
