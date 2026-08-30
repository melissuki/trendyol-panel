import { formatCurrency, formatNumber, formatPercent } from '../lib/format.js';

/**
 * MALI MUSAVIR (CPA) DENETIM SELALESI
 * =============================================================================
 * Iptal/iade edilen tutar ARTIK GORUNMEZ SEKILDE dusulmuyor. Denetimde
 * izlenebilmesi icin her adim ayri bir kart olarak gosterilir:
 *
 *   1) İlk Brüt Ciro        TUM siparisler (iptal ve iade DAHIL)
 *   2) İptal/İade Edilen  − kaybedilen brut ciro
 *   3) Net Satış          = (1) − (2)
 *   4) Komisyon ve Kargo  − yalnizca basarili siparislerin kesintileri
 *   5) Net Ciro           = (3) − (4)
 */
const WATERFALL = [
  {
    key: 'totalGrossRevenue',
    label: 'İlk Brüt Ciro',
    hint:
      'Seçilen aralıktaki TÜM siparişlerin brüt tutarı — iptal ve iadeler DAHİL. ' +
      'DİKKAT: Trendyol Satıcı Paneli’ndeki ciro rakamı iptal/iadeleri içermez, ' +
      'bu yüzden panelle karşılaştırma için bu kartı DEĞİL "Net Satış" kartını kullanın.',
    accent: 'text-slate-800',
    op: null,
  },
  {
    key: 'cancelledReturnedGross',
    label: 'İptal / İade Edilen',
    hint: 'İptal ve iade nedeniyle kaybedilen brüt ciro.',
    accent: 'text-red-600',
    op: '−',
  },
  {
    key: 'netSales',
    label: 'Net Satış',
    hint:
      'İlk Brüt Ciro − İptal/İade Edilen. ' +
      'TRENDYOL SATICI PANELİ’NDEKİ CİRO RAKAMIYLA KARŞILAŞTIRILACAK ALAN BUDUR.',
    badge: 'Trendyol paneli ile karşılaştırın',
    accent: 'text-slate-800',
    op: '=',
    strong: true,
  },
  {
    key: 'deductions',
    label: 'Komisyon ve Kargo',
    hint:
      'Yalnızca başarılı siparişlerin komisyon + kargo/hizmet kesintileri. ' +
      'İptal/iade edilen kalemlerin komisyonu Trendyol tarafından iade edildiği için düşülmez.',
    accent: 'text-red-600',
    op: '−',
  },
  {
    key: 'netRevenue',
    label: 'Net Ciro',
    hint: 'Net Satış − Komisyon ve Kargo',
    accent: 'text-trendyol-600',
    op: '=',
    strong: true,
  },
];

/**
 * Adet kartlari.
 * "Sipariş"      = benzersiz siparis numarasi adedi (Trendyol panelindeki sayac)
 * "Satılan Adet" = urun/satir adedi - ayri bir kavramdir.
 */
const COUNTS = [
  {
    key: 'orderCount',
    label: 'Sipariş',
    hint:
      'Benzersiz sipariş numarası adedi — Trendyol Satıcı Paneli’ndeki "Sipariş" sayacı ile aynı mantık. ' +
      'Bir sipariş birden fazla ürün satırı ve birden fazla kargo paketi içerebilir.',
    accent: 'text-slate-800',
  },
  {
    key: 'quantitySold',
    label: 'Satılan Adet',
    hint: 'Satılan ürün adedi. Sipariş sayısı DEĞİLDİR — bir siparişte birden çok ürün olabilir.',
    accent: 'text-emerald-600',
  },
  {
    key: 'quantityCancelled',
    label: 'İptal Adedi',
    hint: 'Sipariş satırı statüsü "Cancelled" olan ürün adedi.',
    accent: 'text-red-600',
  },
  {
    key: 'quantityReturned',
    label: 'İade Adedi',
    hint:
      'Trendyol /claims iade talebi bulunan ürün adedi. ' +
      'Teslim edilemeyip geri dönen kargolar buraya DAHİL DEĞİLDİR (Trendyol da bunları iade saymaz).',
    accent: 'text-amber-600',
  },
];

function Card({ label, hint, value, accent, op, strong, badge, isLoading }) {
  return (
    <div className={`card relative p-4 ${strong ? 'ring-1 ring-slate-300' : ''}`} title={hint}>
      {op && (
        <span
          aria-hidden="true"
          className="absolute -left-2.5 top-1/2 hidden -translate-y-1/2 rounded-full bg-white px-1 text-sm font-bold text-slate-400 xl:block"
        >
          {op}
        </span>
      )}
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      {isLoading ? (
        <div className="mt-2 h-7 w-24 animate-pulse rounded bg-slate-200" />
      ) : (
        <p className={`mt-1.5 text-xl font-bold tabular-nums ${accent}`}>{value}</p>
      )}
      {badge && !isLoading && (
        <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-trendyol-600">{badge}</p>
      )}
    </div>
  );
}

export default function SummaryCards({ totals, finance, isLoading }) {
  const values = {
    ...totals,
    deductions: totals?.deductions ?? (totals?.commission ?? 0) + (totals?.shippingFee ?? 0),
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {COUNTS.map((card) => (
          <Card
            key={card.key}
            label={card.label}
            hint={card.hint}
            accent={card.accent}
            isLoading={isLoading}
            value={formatNumber(values?.[card.key] ?? 0)}
          />
        ))}
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Net Ciro Hesabı — adım adım kırılım
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {WATERFALL.map((card) => (
            <Card
              key={card.key}
              label={card.label}
              hint={card.hint}
              accent={card.accent}
              op={card.op}
              strong={card.strong}
              badge={card.badge}
              isLoading={isLoading}
              value={formatCurrency(values?.[card.key] ?? 0)}
            />
          ))}
        </div>
      </div>

      {!isLoading && totals && (
        <p className="text-xs text-slate-500">
          <strong>İlk Brüt Ciro</strong> {formatCurrency(totals.totalGrossRevenue ?? 0)} −{' '}
          <strong>İptal/İade</strong> {formatCurrency(totals.cancelledReturnedGross ?? 0)} ={' '}
          <strong>Net Satış</strong> {formatCurrency(totals.netSales ?? 0)} −{' '}
          <strong>Komisyon/Kargo</strong> {formatCurrency(values.deductions)} ={' '}
          <strong>Net Ciro</strong> {formatCurrency(totals.netRevenue ?? 0)}. İptal/iade edilen kalemlerin
          komisyonu Trendyol tarafından iade edildiği için düşülmez.{' '}
          <strong>Trendyol Satıcı Paneli’ndeki ciro rakamı iptal/iadeleri içermez</strong> — panelle
          karşılaştırırken “Net Satış” değerini esas alın.
          {totals.quantityReturnPending > 0 && (
            <> · {formatNumber(totals.quantityReturnPending)} iade talebi onay bekliyor.</>
          )}
        </p>
      )}

      {!isLoading && totals?.waterfallBalanced === false && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">
          ⚠ Kırılım tutarlılığı doğrulanamadı — bu rapor mali müşavire verilmeden önce incelenmelidir.
        </p>
      )}

      {!isLoading && finance?.estimatedLines > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <strong>{formatNumber(finance.estimatedLines)}</strong> satır <strong>TAHMİNİ</strong>,{' '}
          <strong>{formatNumber(finance.settledLines ?? 0)}</strong> satır <strong>KESİNLEŞMİŞ</strong>.
          Tahmini satırlarda mutabakat kaydı henüz oluşmadığı için komisyon, siparişin
          <strong> kendi gerçek komisyon oranı</strong> ile hesaplanmıştır.
        </p>
      )}

      {!isLoading && finance && finance.available === false && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          Trendyol Finans/Mutabakat API'sine erişilemedi. Komisyon ve kargo tutarları okunamadığı için net ciro
          eksik olabilir — finans API yetkinizi kontrol edin.
        </p>
      )}
    </div>
  );
}

export function ProductBadges({ product }) {
  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      <span className="rounded-md bg-emerald-50 px-2 py-1 font-medium text-emerald-700">
        {formatNumber(product.quantitySold)} satış
      </span>
      {product.quantityCancelled > 0 && (
        <span className="rounded-md bg-red-50 px-2 py-1 font-medium text-red-700">
          {formatNumber(product.quantityCancelled)} iptal
        </span>
      )}
      {product.quantityReturned > 0 && (
        <span className="rounded-md bg-amber-50 px-2 py-1 font-medium text-amber-700">
          {formatNumber(product.quantityReturned)} iade
        </span>
      )}
      {product.returnRate > 0 && (
        <span className="rounded-md bg-slate-100 px-2 py-1 font-medium text-slate-600">
          İptal/iade oranı {formatPercent(product.returnRate)}
        </span>
      )}
    </div>
  );
}
