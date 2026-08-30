import { chunkRange, dayKey } from '../lib/dates.js';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { num } from '../lib/money.js';
import { env } from '../config/env.js';
import { fetchAllPages, sellerPath } from './trendyolClient.js';
import { LINE_STATUS, extractCustomer } from './ordersService.js';
import {
  classifyClaimStatus,
  isAcceptedClaimStatus,
  isInProgressClaimStatus,
  isRealReturnClaim,
  isRejectedClaimStatus,
  summarizeStatuses,
} from '../lib/status.js';

/**
 * IADE / IPTAL TALEPLERI (Claims API)
 * GET /integration/order/sellers/{sellerId}/claims
 *
 * Yanit sozlesmesi (ozet):
 * {
 *   content: [{
 *     id: "<claimId>",
 *     orderNumber: "1234567890",
 *     orderDate: 1712000000000,
 *     claimDate: 1712300000000,
 *     cargoTrackingNumber: 123,
 *     items: [{
 *       orderLine: { id, barcode, productName, merchantSku, quantity, price, ... },
 *       claimItems: [{
 *         id, orderLineItemId,
 *         claimItemStatus: { name: "Accepted" | "Waiting" | "Rejected" | "Cancelled" },
 *         customerClaimItemReason:  { id, name, externalReasonId },   <-- MUSTERI NEDENI
 *         trendyolClaimItemReason:  { id, name },                    <-- TRENDYOL/SATICI NEDENI
 *         note, customerNote, resolved
 *       }]
 *     }]
 *   }]
 * }
 *
 * IADE NEDENI burada: claimItems[].customerClaimItemReason.name
 * (or. "Ürün kusurlu/hatalı", "Geç teslimat", "Fikrimi değiştirdim", "Beden uymadı")
 */

const CLAIMS_CHUNK_DAYS = 14;
// Canli olarak dogrulandi: claims uc noktasi size=200 kabul ediyor
// (50 ile 22 sayfa gerekiyordu; 200 ile istek sayisi 4 kat azaliyor).
const PAGE_SIZE = 200;

/** Nedeni cozerken oncelik sirasi: musteri nedeni > trendyol nedeni > not > statu */
export function resolveClaimReason(claimItem) {
  const candidates = [
    claimItem?.customerClaimItemReason?.name,
    claimItem?.customerClaimItemReason?.externalReasonName,
    claimItem?.trendyolClaimItemReason?.name,
    claimItem?.claimItemReason?.name,
    claimItem?.reason?.name,
    typeof claimItem?.reason === 'string' ? claimItem.reason : null,
    claimItem?.customerNote,
    claimItem?.note,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * CLAIM STATU SINIFLANDIRMASI (canli veriden dogrulanmistir)
 *   Accepted        -> onayli iade, ciroyu dusurur
 *   Created         -> musteri talep acti, henuz sonuclanmadi
 *   WaitingInAction -> islem bekliyor
 *   Rejected        -> reddedildi, iade DEGILDIR
 *   Cancelled       -> talep iptal edildi, iade DEGILDIR
 */
/**
 * CLAIM STATU SINIFLANDIRMASI
 * Tum esleme `lib/status.js` uzerinden yapilir (Turkce/Ingilizce, buyuk-kucuk
 * harf, bosluk ve alt tire farklarina dayanikli).
 *
 * Canli hesapta gorulen dagilim (30 gun):
 *   Accepted 486, Created 404, Cancelled 137, WaitingInAction 67, Rejected 2
 *
 * KURAL: yalnizca ACIKCA reddedilen/iptal edilen talepler iade sayilmaz.
 * Bilinmeyen bir alt statu gelirse IADE SAYILIR ve loga uyari dusulur.
 */
export const isRejectedStatus = isRejectedClaimStatus;
export const isAcceptedStatus = isAcceptedClaimStatus;
export const isPendingStatus = isInProgressClaimStatus;
export const isRealReturn = isRealReturnClaim;

function normalizeClaim(claim) {
  const rows = [];
  const items = Array.isArray(claim?.items) ? claim.items : [];
  const claimDate = num(claim?.claimDate ?? claim?.createDate ?? claim?.orderDate, null);
  // Claims yaniti musteri adini her zaman icermez; varsa aliriz, yoksa
  // siparis satiriyla eslesince Orders tarafindaki ad kullanilir.
  const customer = extractCustomer(claim);

  for (const item of items) {
    const orderLine = item?.orderLine ?? {};
    const claimItems = Array.isArray(item?.claimItems) ? item.claimItems : [];

    // Ayni order line icin birden fazla claimItem = birden fazla adet iade
    for (const claimItem of claimItems) {
      /**
       * Statu alani hesaptan hesaba farkli isimlerde gelebiliyor;
       * adaylari sirayla tariyoruz ve HAM degeri saklıyoruz.
       */
      const statusName =
        claimItem?.claimItemStatus?.name ??
        claimItem?.claimItemStatus ??
        claimItem?.status?.name ??
        claimItem?.status ??
        claimItem?.claimStatus?.name ??
        '';
      rows.push({
        claimId: claim?.id ?? null,
        claimItemId: claimItem?.id ?? null,
        orderNumber: String(claim?.orderNumber ?? '').trim(),
        orderLineId: orderLine?.id ?? null,
        orderLineItemId: claimItem?.orderLineItemId ?? null,
        // Yedek eslesme anahtarlari (satir kimligi tutmazsa kullanilir)
        shipmentPackageId: claim?.orderShipmentPackageId ?? claim?.shipmentPackageId ?? null,
        outboundPackageId: claim?.orderOutboundPackageId ?? null,
        cargoTrackingNumber: claim?.cargoTrackingNumber ?? null,
        barcode: String(orderLine?.barcode ?? '').trim(),
        merchantSku: String(orderLine?.merchantSku ?? '').trim(),
        productName: String(orderLine?.productName ?? '').trim(),
        // Trendyol her IADE EDILEN ADET icin ayri bir claimItem uretir.
        // Bu yuzden bir claimItem = 1 adet. orderLine.quantity ise siparisteki
        // toplam adettir; kismi iadelerde ikisi farklidir.
        claimedQuantity: 1,
        orderLineQuantity: Math.max(1, num(orderLine?.quantity, 1)),
        quantity: 1,
        customerFirstName: customer.firstName,
        customerLastName: customer.lastName,
        customerFullName: customer.fullName,
        unitPrice: num(orderLine?.price, 0),
        claimDate,
        claimDay: dayKey(claimDate, env.REPORT_TIMEZONE),
        orderDate: num(claim?.orderDate, null),
        status: statusName,
        /**
         * ONAYLI IADE MI?
         * DIKKAT: `resolved` alanina GUVENILMEZ - canli veride REDDEDILEN
         * talepler de resolved:true donuyor (or. status "Rejected", resolved true).
         * Bu yuzden yalnizca statu adina bakiyoruz; aksi halde reddedilen
         * talepler iade olarak sayilip ciroyu haksiz yere dusururdu.
         *
         * Canli statu dagilimi (30 gun): Accepted 486, Created 404,
         * Cancelled 137, WaitingInAction 67, Rejected 2
         */
        accepted: isAcceptedStatus(statusName),
        /** Onaylandi ya da surec devam ediyor -> URUN IADE EDILMISTIR. */
        isReturn: isRealReturn(statusName),
        /** Henuz onaylanmamis ama suregelen talep. */
        pending: isPendingStatus(statusName),
        rejected: isRejectedStatus(statusName),
        reason: resolveClaimReason(claimItem),
        customerNote: claimItem?.customerNote ?? claimItem?.note ?? '',
        // Iade mi iptal mi: teslim oncesi iptaller genelde "Cancelled" tipindedir
        claimType: /cancel|iptal/i.test(String(claim?.claimType ?? statusName)) ? 'CANCEL' : 'RETURN',
      });
    }

    // claimItems bos gelirse en azindan satir bazli bir kayit birakalim
    if (claimItems.length === 0) {
      rows.push({
        claimId: claim?.id ?? null,
        claimItemId: null,
        orderNumber: String(claim?.orderNumber ?? '').trim(),
        orderLineId: orderLine?.id ?? null,
        orderLineItemId: null,
        barcode: String(orderLine?.barcode ?? '').trim(),
        merchantSku: String(orderLine?.merchantSku ?? '').trim(),
        productName: String(orderLine?.productName ?? '').trim(),
        claimedQuantity: Math.max(1, num(orderLine?.quantity, 1)),
        orderLineQuantity: Math.max(1, num(orderLine?.quantity, 1)),
        quantity: Math.max(1, num(orderLine?.quantity, 1)),
        customerFirstName: customer.firstName,
        customerLastName: customer.lastName,
        customerFullName: customer.fullName,
        unitPrice: num(orderLine?.price, 0),
        claimDate,
        claimDay: dayKey(claimDate, env.REPORT_TIMEZONE),
        orderDate: num(claim?.orderDate, null),
        status: '',
        accepted: false,
        isReturn: false,
        pending: false,
        rejected: false,
        reason: null,
        customerNote: '',
        claimType: 'RETURN',
      });
    }
  }

  return rows;
}

/**
 * Tarih araligindaki iade/iptal taleplerini getirir.
 *
 * KRITIK KURAL (mali musavir denetimi):
 *   Bir siparis secili aralikta verilmisse, o siparise ait iade talebi NE ZAMAN
 *   acilirsa acilsin rapora GIRMELIDIR. Iade talebi tipik olarak siparisten
 *   gunler/haftalar SONRA olusur; pencereyi siparis araliginin bitisiyle
 *   sinirlamak iadelerin buyuk kismini kaybettiriyordu.
 *
 * Bu yuzden talep penceresi ileri yonde BUGUNE kadar acilir (lookAheadDays
 * varsayilani artik sabit bir sayi degil, "simdi"dir). Geriye dogru ise,
 * pencereden once satilip pencerede iade edilenleri yakalamak icin
 * lookBehindDays kadar genisletilir.
 */
export async function fetchClaims({ startMs, endMs, lookBehindDays = 60 }) {
  const from = startMs - lookBehindDays * 24 * 60 * 60 * 1000;
  // Ileri yonde BUGUNE kadar: secili aralikta verilen bir siparisin bugun
  // acilmis iadesi bile yakalanmalidir.
  const to = Math.max(endMs, Date.now());
  const cacheKey = `claims:${from}:${to}`;

  return cached(cacheKey, async () => {
    const chunks = chunkRange(from, to, CLAIMS_CHUNK_DAYS);
    const byClaimItem = new Map();
    let requestCount = 0;

    for (const chunk of chunks) {
      const { items, pages } = await fetchAllPages(
        sellerPath('/order/sellers/:sellerId/claims'),
        { startDate: chunk.startDate, endDate: chunk.endDate },
        { size: PAGE_SIZE },
      );
      requestCount += pages;

      for (const claim of items) {
        for (const row of normalizeClaim(claim)) {
          const key = row.claimItemId ?? `${row.claimId}-${row.orderLineId}-${row.orderLineItemId}`;
          byClaimItem.set(String(key), row);
        }
      }
    }

    const rows = [...byClaimItem.values()];
    logger.info('claims fetched', { claimItems: rows.length, chunks: chunks.length, requests: requestCount });
    return rows;
  });
}

/**
 * Siparis satirlarini iade kayitlariyla eslestirmek icin indeks.
 * Trendyol'da guvenilir eslesme sirasi:
 *   1) orderLineId  (en kesin)
 *   2) orderNumber + barcode
 *   3) orderNumber  (son care)
 */
/** Bir iade kaydinin tekil anahtari (mukerrer sayimi onlemek icin). */
export const claimRowKey = (row) =>
  String(row.claimItemId ?? `${row.claimId}-${row.orderLineId}-${row.orderLineItemId}`);

export function indexClaims(claimRows) {
  /**
   * SAVUNMALI ESLESME INDEKSI
   * ---------------------------------------------------------------------
   * Trendyol ayni kimligi bir uc noktada SAYI, digerinde METIN dondurebiliyor
   * (5757813641 vs "5757813641"). Ayrica bazi hesaplarda `orderLine.id`
   * bosuna gelebiliyor. Bu yuzden BIRDEN COK anahtar uzerinden indeksliyoruz
   * ve eslesmeyi en kesinden en gevsege dogru deniyoruz:
   *
   *   1) orderLineId          (siparis satiri kimligi - en kesin)
   *   2) orderLineItemId      (satir kalemi kimligi)
   *   3) orderNumber + barkod
   *   4) orderNumber + SKU
   *   5) kargo paketi no      (orderShipmentPackageId / outbound / takip no)
   *   6) orderNumber          (son care)
   *
   * Hangi stratejinin kullanildigi her eslesmede kaydedilir; oran
   * `applyClaimsToLines` istatistiklerinde raporlanir.
   */
  const byOrderLineId = new Map();
  const byOrderLineItemId = new Map();
  const byOrderAndBarcode = new Map();
  const byOrderAndSku = new Map();
  const byPackageId = new Map();
  const byOrderNumber = new Map();

  /** KATI TIP DONUSUMU: her anahtar normalize edilmis METINDIR. */
  const norm = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return '';
    const text = String(value).trim();
    if (!text || text === 'null' || text === 'undefined' || text === 'NaN') return '';
    return text;
  };

  const push = (map, key, row) => {
    const k = norm(key);
    if (!k) return;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  };

  for (const row of claimRows) {
    push(byOrderLineId, row.orderLineId, row);
    push(byOrderLineItemId, row.orderLineItemId, row);
    push(byOrderAndBarcode, `${norm(row.orderNumber)}::${norm(row.barcode)}`, row);
    push(byOrderAndSku, `${norm(row.orderNumber)}::${norm(row.merchantSku)}`, row);
    push(byPackageId, row.shipmentPackageId, row);
    push(byPackageId, row.outboundPackageId, row);
    push(byOrderNumber, row.orderNumber, row);
  }

  return {
    byOrderLineId,
    byOrderAndBarcode,
    byOrderNumber,
    /**
     * Bir siparis satirina ait iade kaydini bulur.
     * @returns {{rows:Array, matchedBy:string, keys:Array}|null}
     */
    match(line) {
      const pick = (list) => (Array.isArray(list) && list.length > 0 ? list : null);
      const result = (rows, matchedBy) => ({ rows, matchedBy, keys: rows.map(claimRowKey) });

      // 1) Satir kimligi - orders line.id == claims items[].orderLine.id
      //    (canli veride 998/1003 eslesme dogrulandi)
      for (const candidate of [line.orderLineId, line.lineId, line.id]) {
        const hit = pick(byOrderLineId.get(norm(candidate)));
        if (hit) return result(hit, 'orderLineId');
      }

      // 2) Satir kalemi kimligi
      for (const candidate of [line.orderLineId, line.lineId]) {
        const hit = pick(byOrderLineItemId.get(norm(candidate)));
        if (hit) return result(hit, 'orderLineItemId');
      }

      // 3) Siparis no + barkod
      const byBarcode = pick(byOrderAndBarcode.get(`${norm(line.orderNumber)}::${norm(line.barcode)}`));
      if (byBarcode) return result(byBarcode, 'orderNumber+barcode');

      // 4) Siparis no + stok kodu
      const bySku = pick(byOrderAndSku.get(`${norm(line.orderNumber)}::${norm(line.merchantSku)}`));
      if (bySku) return result(bySku, 'orderNumber+merchantSku');

      // 5) Kargo paketi numarasi
      for (const candidate of [line.packageId, line.shipmentPackageId, line.cargoTrackingNumber]) {
        const hit = pick(byPackageId.get(norm(candidate)));
        if (hit) {
          // Paket birden fazla urun icerebilir; ayni barkoda daralt
          const sameProduct = hit.filter(
            (r) => !norm(r.barcode) || !norm(line.barcode) || norm(r.barcode) === norm(line.barcode),
          );
          if (sameProduct.length > 0) return result(sameProduct, 'packageId');
        }
      }

      // 6) Son care: yalnizca siparis no (ayni barkoda daraltarak)
      const byOrder = pick(byOrderNumber.get(norm(line.orderNumber)));
      if (byOrder) {
        const sameProduct = byOrder.filter(
          (r) => !norm(r.barcode) || !norm(line.barcode) || norm(r.barcode) === norm(line.barcode),
        );
        if (sameProduct.length > 0) return result(sameProduct, 'orderNumber');
      }
      return null;
    },
  };
}

/**
 * IADELERI SIPARIS SATIRLARINA UYGULAR
 * =============================================================================
 * Iadeler siparis statusunden TURETILMEZ; kaynak /claims uc noktasidir.
 * Eslesme anahtari: claims -> items[].orderLine.id  ==  orders -> line.id
 * (canli veride 30 gunluk pencerede 998/1003 eslesme dogrulanmistir).
 *
 * Kurallar:
 *  - line.status === CANCELLED ise IADE ATANMAZ. Iptal ve iade birbirini disar;
 *    boylece bir adet asla iki kez sayilmaz.
 *  - Yalnizca ONAYLANMIS (Accepted) talepler ciroyu etkiler.
 *  - Onay bekleyen talepler (Created / WaitingInAction) ayri sayilir:
 *    `returnPendingQuantity`. Reddedilen/iptal edilen talepler yok sayilir.
 *  - Kismi iade: her claimItem 1 adettir; iade adedi satir adedini asamaz.
 *
 * @returns {{ lines: Array, stats: object }}
 */
export function applyClaimsToLines(orderLines, claimRows) {
  const index = indexClaims(claimRows);
  const usedClaimKeys = new Set();

  const stats = {
    cancelledLines: 0,
    returnedLines: 0,
    returnedAcceptedLines: 0,
    returnedInProgressLines: 0,
    returnPendingLines: 0,
    claimRowsTotal: claimRows.length,
    claimRowsMatched: 0,
    claimRowsUnmatched: 0,
    unsuppliedLines: 0,
    undeliveredWithoutClaim: 0,
    // Hangi eslesme stratejisinin kullanildigi (teshis icin)
    matchedBy: {},
    matchedByOrderLineId: 0,
    matchedByOtherKey: 0,
  };

  const lines = orderLines.map((line) => {
    // 1) IPTAL kesindir; iade talebi olsa bile iptal olarak kalir.
    if (line.status === LINE_STATUS.CANCELLED) {
      stats.cancelledLines += 1;
      return [{ ...line, returnedQuantity: 0, returnPendingQuantity: 0, claim: null, returnSource: null }];
    }
    if (line.status === LINE_STATUS.UNSUPPLIED) {
      stats.unsuppliedLines += 1;
      return [{ ...line, returnedQuantity: 0, returnPendingQuantity: 0, claim: null, returnSource: null }];
    }

    const match = index.match(line);
    const rows = match?.rows ?? [];
    for (const key of match?.keys ?? []) usedClaimKeys.add(key);
    if (match) {
      stats.matchedBy[match.matchedBy] = (stats.matchedBy[match.matchedBy] ?? 0) + 1;
      if (match.matchedBy === 'orderLineId') stats.matchedByOrderLineId += 1;
      else stats.matchedByOtherKey += 1;
    }

    /**
     * GERCEK IADE = reddedilmemis/iptal edilmemis her talep.
     * Onaylanmis olanlar ayrica sayilir ki mali musavir "kesinlesmis iade" ile
     * "sureci devam eden iade" ayrimini gorebilsin; ancak URUN her iki durumda
     * da geri gelmistir ve ciroya dahil EDILMEZ.
     */
    const realReturns = rows.filter((r) => r.isReturn);
    const acceptedReturns = realReturns.filter((r) => r.accepted);
    const inProgress = realReturns.filter((r) => !r.accepted);

    const returnedQuantity = Math.min(
      line.quantity,
      realReturns.reduce((total, r) => total + num(r.claimedQuantity, 1), 0),
    );
    // Bilgi amacli: iade edilen adedin ne kadari henuz onaylanmamis
    const returnPendingQuantity = Math.min(
      returnedQuantity,
      inProgress.reduce((total, r) => total + num(r.claimedQuantity, 1), 0),
    );

    const claim = acceptedReturns[0] ?? realReturns[0] ?? rows[0] ?? null;
    const common = {
      returnPendingQuantity,
      claim,
      claimMatchedBy: match?.matchedBy ?? null,
    };

    /**
     * TESLIM EDILEMEYEN ("UnDelivered" / "UnDeliveredAndReturned") SATIRLAR
     * -----------------------------------------------------------------------
     * Bunlar IADE OLARAK SAYILMAZ.
     *
     * Trendyol Satici Paneli "İade" sayisina yalnizca gercek iade TALEBI olan
     * kalemleri katiyor; kargonun teslim edilemeyip geri donmesi ayri bir
     * operasyonel durumdur. Bu satirlari da iade saymak, panelimizin iade
     * sayisini Trendyol'unkinden FAZLA gosteriyordu.
     *
     * Iade talebi olan bir satir zaten yukaridaki claims eslesmesiyle
     * yakalanir. Talebi olmayanlar `undeliveredLines` kovasinda AYRICA
     * raporlanir - kaybolmazlar, yalnizca iade sayisina karismazlar.
     */
    if (returnedQuantity === 0 && line.undelivered) {
      stats.undeliveredWithoutClaim += 1;
      if (returnPendingQuantity > 0) stats.returnPendingLines += 1;
      return [{
        ...line, ...common,
        returnSource: null,
        returnedQuantity: 0,
        undeliveredNoClaim: true,
      }];
    }

    if (returnedQuantity === 0) {
      if (returnPendingQuantity > 0) stats.returnPendingLines += 1;
      return [{ ...line, ...common, returnSource: null, returnedQuantity: 0 }];
    }

    stats.returnedLines += 1;
    if (acceptedReturns.length > 0) stats.returnedAcceptedLines += 1;
    if (inProgress.length > 0) stats.returnedInProgressLines += 1;
    if (returnPendingQuantity > 0) stats.returnPendingLines += 1;

    /**
     * KISMI IADE: satir burada IKIYE BOLUNUR.
     * 3 adetlik satirin 1 adedi iade edildiyse -> 1 adet IADE + 2 adet SATIS.
     * Bolmeyi burada yapmak, hem urun listesinin hem gunluk raporun ayni
     * sayilari uretmesini garanti eder (tek kaynak).
     */
    const unitGross = line.quantity > 0 ? line.grossAmount / line.quantity : line.grossAmount;
    const soldQuantity = line.quantity - returnedQuantity;

    const parts = [{
      ...line, ...common,
      status: LINE_STATUS.RETURNED,
      returnSource: 'claims',
      quantity: returnedQuantity,
      grossAmount: Math.round(unitGross * returnedQuantity * 100) / 100,
      returnedQuantity,
      splitFromQuantity: line.quantity,
    }];

    if (soldQuantity > 0) {
      parts.push({
        ...line, ...common,
        status: LINE_STATUS.SALE,
        returnSource: null,
        quantity: soldQuantity,
        grossAmount: Math.round(unitGross * soldQuantity * 100) / 100,
        returnedQuantity: 0,
        returnPendingQuantity: 0, // bekleyen adet yalnizca bir kez sayilsin
        claim: null,
        splitFromQuantity: line.quantity,
      });
    }
    return parts;
  });

  stats.claimRowsMatched = usedClaimKeys.size;
  stats.claimRowsUnmatched = Math.max(0, claimRows.length - usedClaimKeys.size);

  /**
   * HAM CLAIM STATU DENETIM KAYDI
   * Trendyol'dan GERCEKTE hangi talep statulerinin geldigini, normalize
   * hallerini ve hangi kovaya dustuklerini loga yazar.
   */
  const statusSummary = summarizeStatuses(claimRows.map((r) => r.status), classifyClaimStatus);
  stats.claimStatusBreakdown = statusSummary.map((r) => ({
    ham: r.raw,
    normalize: r.normalized,
    sinif: r.classified,
    adet: r.count,
  }));
  logger.info('claim status breakdown (RAW)', { statuses: stats.claimStatusBreakdown });

  const unknownStatuses = statusSummary.filter((r) => r.classified === 'UNKNOWN_COUNTED_AS_RETURN');
  if (unknownStatuses.length > 0) {
    logger.warn('BILINMEYEN iade talebi statusu - IADE SAYILDI', {
      statuses: unknownStatuses.map((r) => `${r.raw} (${r.count})`),
      not: 'Reddedilen bir statu ise lib/status.js CLAIM_REJECTED_PATTERNS listesine eklenmeli.',
    });
  }

  logger.info('claims applied to order lines', {
    talepSatiri: claimRows.length,
    eslesen: stats.claimRowsMatched,
    eslesmeyen: stats.claimRowsUnmatched,
    eslesmeStratejisi: stats.matchedBy,
    iadeSatiri: stats.returnedLines,
    iptalSatiri: stats.cancelledLines,
    teslimEdilemeyenClaimsiz: stats.undeliveredWithoutClaim,
  });

  if (stats.claimRowsUnmatched > 0) {
    logger.warn('ESLESMEYEN iade talepleri var', {
      adet: stats.claimRowsUnmatched,
      olasiNeden:
        'Siparis secili tarih araliginin disinda olabilir (bu normaldir) ya da ' +
        'eslesme anahtari tutmuyordur. Teshis: GET /api/diagnostics/statuses',
    });
  }

  return { lines: lines.flat(), stats, usedClaimKeys };
}
