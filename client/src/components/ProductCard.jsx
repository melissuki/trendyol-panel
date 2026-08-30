import Spinner from './Spinner.jsx';
import { ProductBadges } from './SummaryCards.jsx';
import { formatCurrency, formatNumber } from '../lib/format.js';

const initials = (name) =>
  String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');

export default function ProductCard({ product, isDownloading, onDownload, onPreview }) {
  return (
    <article className="card flex flex-col gap-4 p-5 transition hover:border-trendyol-200 hover:shadow-md">
      <header className="flex items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-trendyol-50 text-sm font-bold text-trendyol-600">
          {initials(product.productName)}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-slate-800" title={product.productName}>
            {product.productName}
          </h3>
          <p className="mt-1 truncate text-xs text-slate-500">
            Barkod: <span className="font-mono">{product.barcode}</span>
            {product.merchantSku && <> · SKU: <span className="font-mono">{product.merchantSku}</span></>}
          </p>
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-3 border-y border-slate-100 py-3">
        <div>
          <dt className="text-xs text-slate-500">Brüt Ciro</dt>
          <dd className="mt-0.5 text-base font-bold tabular-nums text-slate-800">
            {formatCurrency(product.grossSales)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Tahmini Net Ciro</dt>
          <dd className="mt-0.5 text-base font-bold tabular-nums text-trendyol-600">
            {formatCurrency(product.estimatedNetRevenue)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Sipariş Sayısı</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-700">
            {formatNumber(product.orderCount)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Satılan Adet</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-700">
            {formatNumber(product.quantitySold)}
          </dd>
        </div>
      </dl>

      <ProductBadges product={product} />

      <footer className="mt-auto flex gap-2">
        <button
          type="button"
          className="btn-primary flex-1"
          onClick={() => onDownload(product)}
          disabled={isDownloading}
          aria-busy={isDownloading}
        >
          {isDownloading ? (
            <>
              <Spinner />
              Hazırlanıyor…
            </>
          ) : (
            <>
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M10 2a1 1 0 011 1v8.586l2.293-2.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 11.586V3a1 1 0 011-1z" />
                <path d="M3 15a1 1 0 011 1v1h12v-1a1 1 0 112 0v1a2 2 0 01-2 2H4a2 2 0 01-2-2v-1a1 1 0 011-1z" />
              </svg>
              Günlük Rapor İndir
            </>
          )}
        </button>
        <button
          type="button"
          className="btn-ghost px-3"
          onClick={() => onPreview(product)}
          title="Gün gün önizleme"
          aria-label={`${product.productName} için günlük önizleme`}
        >
          Önizle
        </button>
      </footer>
    </article>
  );
}
