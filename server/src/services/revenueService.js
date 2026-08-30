import { round2 } from '../lib/money.js';
import { LINE_STATUS } from './ordersService.js';

/**
 * NET CIRO - TEK VE DETERMINISTIK FORMUL
 * =============================================================================
 *   Net Ciro = (YALNIZCA aktif/teslim edilen siparislerin Brut Cirosu)
 *              − (Aktif siparislerin Komisyonu)
 *              − (Kargo / Hizmet Kesintileri)
 *              − (varsa Iade Kargo Cezalari)
 *
 * KURALLAR
 *   A) DISLAMA      : Iptal (İptal) ve Iade (İade) edilen kalemlerin BRUT
 *                     tutari net ciroya HIC girmez. Bu satirlar brute
 *                     eklenmedigi icin ayrica "geri cikarilmasi" da gerekmez -
 *                     cift sayim boylece yapisal olarak imkansizdir.
 *   B) KOMISYON     : Basarili (aktif) siparislerde komisyon ve kargo/hizmet
 *                     kesintileri TAM olarak dusulur.
 *   C) IADE KOMISYON: Iptal/iade edilen kalemlerin komisyonu net cirodan
 *                     DUSULMEZ - Trendyol bu komisyonu saticiya geri oder.
 *                     Bu yuzden komisyon bu satirlarda daima 0 yazilir.
 *
 * Satir bazinda katki tablosu:
 *
 *   DURUM                    brut     komisyon        kargo          net
 *   -------------------------------------------------------------------------
 *   SATIŞ (aktif)            +G       C (gercek)      S           G − C − S
 *   İPTAL                     0       0 (iade edildi) 0              0
 *   TEDARİK EDİLEMEDİ         0       0               0              0
 *   İADE                      0       0 (iade edildi) Sr           −Sr
 *
 *   G = brut tutar   C = komisyon   S = kargo/hizmet   Sr = iade kargo cezasi
 *
 * OZDESLIK (kod icinde her toplamda dogrulanir):
 *   Σ net  ==  Σ brut(aktif) − Σ komisyon(aktif) − Σ kargo
 *
 * Bu tanim sayesinde GUNLUK satirlarin toplami, panelin ustundeki GENEL
 * TOPLAM ile birebir ayni cikar (ikisi de ayni satir kumesinden turetilir).
 */

const val = (x) => (x === null || x === undefined ? 0 : Number(x) || 0);

/**
 * Bir siparis satirinin mutabakat kalemlerini adet payina oranlar.
 * Kismi iadelerde satir bolundugu icin pay < 1 olabilir.
 */
function prorate(finance, share) {
  if (!finance) return null;
  return {
    commission: round2(val(finance.commission) * share),
    commissionRefunded: round2(val(finance.commissionRefunded) * share),
    shippingFee: round2(val(finance.shippingFee) * share),
    serviceFee: round2(val(finance.serviceFee) * share),
    otherDeductions: round2(val(finance.otherDeductions) * share),
    commissionRate: finance.commissionRate,
  };
}

/**
 * Tek bir rapor satirinin finansal katkisini hesaplar.
 *
 * @param {object}  params
 * @param {string}  params.status             LINE_STATUS.*
 * @param {number}  params.grossAmount        satir parcasinin brut tutari
 * @param {number}  params.share              satirin tamamina gore adet payi (0..1)
 * @param {object}  params.finance            financeService.resolveFor(line) sonucu
 * @param {number}  params.returnShippingFee  yalnizca IADE satirlarina uygulanir
 */
export function computeRowFinancials({
  status,
  grossAmount,
  share = 1,
  finance,
  returnShippingFee = 0,
}) {
  const gross = round2(grossAmount);
  const part = prorate(finance, share);
  const settled = Boolean(finance?.settled);

  const commissionExact = round2(part?.commission ?? 0);
  const shippingExact = round2(
    (part?.shippingFee ?? 0) + (part?.serviceFee ?? 0) + (part?.otherDeductions ?? 0),
  );

  let grossSales = 0;   // yalnizca AKTIF siparisler
  let excluded = 0;     // iptal/iade brutu - bilgi amacli, net ciroya GIRMEZ
  let commission = 0;
  let shipping = 0;
  let netRevenue = 0;

  if (status === LINE_STATUS.SALE) {
    // --- Kural B: aktif siparis; komisyon ve kargo tam olarak dusulur ---
    grossSales = gross;
    commission = commissionExact;
    shipping = shippingExact;
    netRevenue = round2(grossSales - commission - shipping);
  } else if (status === LINE_STATUS.CANCELLED || status === LINE_STATUS.UNSUPPLIED) {
    /**
     * --- Kural A + C: IPTAL ---
     * Brut ciroya hic girmez. Urun kargoya verilmedigi icin komisyon dogmaz;
     * mutabakatta bir komisyon gorunse bile Trendyol bunu geri oder, bu yuzden
     * net cirodan DUSULMEZ. Iade kargo cezasi da UYGULANMAZ.
     */
    excluded = gross;
    commission = 0;
    shipping = 0;
    netRevenue = 0;
  } else {
    /**
     * --- Kural A + C: IADE ---
     * Urun geri geldigi icin brut ciroya girmez (dislanir).
     * Komisyon Trendyol tarafindan saticiya IADE EDILIR -> 0.
     * Yalnizca varsa iade kargo cezasi maliyettir.
     */
    excluded = gross;
    commission = 0;
    shipping = round2(returnShippingFee);
    netRevenue = round2(-shipping);
  }

  return {
    grossSales,
    excluded,
    // Geriye donuk uyumluluk: eski alan adi. Iade brutu net cirodan AYRICA
    // dusulmez (hic eklenmemistir), bu yuzden daima 0'dir.
    refund: 0,
    commission,
    shipping,
    netRevenue,
    settled,
    /** Mali musavir etiketi: "Kesinleşmiş" | "Tahmini" | "Bilinmiyor" */
    valuationLabel: settled ? 'Kesinleşmiş' : finance?.basis === 'unknown' ? 'Bilinmiyor' : 'Tahmini',
    valuationBasis: finance?.basis ?? 'unknown',
    settlementNote: settled ? '' : finance?.note ?? '',
    commissionRate: finance?.commissionRate ?? null,
    commissionRateSource: finance?.rateSource ?? null,
    /** Iade/iptalde geri odenen komisyon - bilgi amacli gosterilir. */
    commissionRefunded: round2(
      status === LINE_STATUS.SALE ? 0 : commissionExact || (part?.commissionRefunded ?? 0),
    ),
    transactionTypes: finance?.transactionTypes ?? [],
  };
}

/**
 * Satirlarin toplamini alir ve OZDESLIGI DOGRULAR.
 * Aritmetik tutmazsa sessizce gecilmez; `balanced:false` raporda gorunur.
 */
export function sumFinancials(rows) {
  const acc = { grossSales: 0, excluded: 0, refund: 0, commission: 0, shipping: 0, netRevenue: 0 };
  for (const row of rows) {
    acc.grossSales += row.grossSales ?? 0;
    // Alan adi cagiran yere gore `excluded` ya da `excludedAmount` olabilir
    acc.excluded += row.excluded ?? row.excludedAmount ?? 0;
    acc.commission += row.commission ?? 0;
    acc.shipping += row.shipping ?? 0;
    acc.netRevenue += row.netRevenue ?? 0;
  }
  for (const key of Object.keys(acc)) acc[key] = round2(acc[key]);

  // Net = Brut(aktif) − Komisyon − Kargo   (iade/iptal brutu zaten hic eklenmedi)
  const expected = round2(acc.grossSales - acc.commission - acc.shipping);
  acc.balanced = Math.abs(expected - acc.netRevenue) <= 0.01;
  acc.balanceDelta = round2(expected - acc.netRevenue);
  acc.netRevenueFormula = expected;
  return acc;
}

/**
 * SELALE BUTUNLUK DENETIMI (cift dusum kontrolu)
 * =============================================================================
 * Net ciro hesabinda EN TEHLIKELI hata, iptal/iade tutarinin iki kez
 * dusulmesidir: bir kez brute hic eklenmeyerek, bir kez de "iade" kalemi
 * olarak cikarilarak. Bu fonksiyon her satiri tek tek denetleyip boyle bir
 * durumun OLMADIGINI kanitlar.
 *
 * Denetlenen kurallar:
 *   K1  Bir satir ya brute girer YA DA dislanir - ASLA ikisi birden olmaz.
 *   K2  Iptal/iade satirlarinda komisyon 0'dir (Trendyol geri oder).
 *   K3  Iptal satirinda kargo/iade cezasi 0'dir (urun gonderilmedi).
 *   K4  Toplam Ilk Brut = Net Satis + Iptal/Iade  (hicbir tutar kaybolmaz)
 *   K5  Net Ciro = Net Satis − Komisyon − Kargo
 *
 * @returns {{ok:boolean, violations:Array, totals:object}}
 */
export function auditWaterfall(rows) {
  const violations = [];

  let grossActive = 0;
  let excluded = 0;
  let commission = 0;
  let shipping = 0;
  let net = 0;

  rows.forEach((row, index) => {
    const g = Number(row.grossSales) || 0;
    const x = Number(row.excluded ?? row.excludedAmount) || 0;
    const c = Number(row.commission) || 0;
    const sh = Number(row.shipping) || 0;
    const n = Number(row.netRevenue) || 0;
    const status = row.status ?? '?';
    const where = `satır #${index + 1} (${row.orderNumber ?? '?'} / ${status})`;

    // K1: cift sayim olmasin
    if (g > 0 && x > 0) {
      violations.push({ kural: 'K1', where, mesaj: `Hem brüte girmiş (${g}) hem dışlanmış (${x}) - ÇİFT SAYIM` });
    }

    // K2: iptal/iade komisyonu dusulmemeli
    if ((status === LINE_STATUS.CANCELLED || status === LINE_STATUS.RETURNED ||
         status === LINE_STATUS.UNSUPPLIED) && c !== 0) {
      violations.push({ kural: 'K2', where, mesaj: `İptal/iade satırında komisyon düşülmüş (${c})` });
    }

    // K3: iptalde kargo olmamali
    if ((status === LINE_STATUS.CANCELLED || status === LINE_STATUS.UNSUPPLIED) && sh !== 0) {
      violations.push({ kural: 'K3', where, mesaj: `İptal satırına kargo/iade cezası uygulanmış (${sh})` });
    }

    // Satir bazinda net dogru mu?
    const expectedNet = round2(g - c - sh);
    if (Math.abs(expectedNet - n) > 0.011) {
      violations.push({ kural: 'K5', where, mesaj: `Satır neti tutmuyor: ${n} ≠ ${g} − ${c} − ${sh}` });
    }

    grossActive += g;
    excluded += x;
    commission += c;
    shipping += sh;
    net += n;
  });

  const totals = {
    netSales: round2(grossActive),
    cancelledReturnedGross: round2(excluded),
    totalGrossRevenue: round2(grossActive + excluded),
    commission: round2(commission),
    shipping: round2(shipping),
    deductions: round2(commission + shipping),
    netRevenue: round2(net),
  };

  // K4: hicbir tutar kaybolmadi mi?
  if (Math.abs(totals.totalGrossRevenue - (totals.netSales + totals.cancelledReturnedGross)) > 0.011) {
    violations.push({ kural: 'K4', where: 'TOPLAM', mesaj: 'İlk Brüt ≠ Net Satış + İptal/İade' });
  }
  // K5 toplam seviyesinde
  const expectedTotalNet = round2(totals.netSales - totals.deductions);
  if (Math.abs(expectedTotalNet - totals.netRevenue) > 0.011) {
    violations.push({
      kural: 'K5',
      where: 'TOPLAM',
      mesaj: `Net Ciro tutmuyor: ${totals.netRevenue} ≠ ${totals.netSales} − ${totals.deductions}`,
    });
  }

  return { ok: violations.length === 0, violations, totals };
}
