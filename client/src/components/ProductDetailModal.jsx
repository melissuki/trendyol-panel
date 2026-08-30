import { useEffect, useState } from 'react';
import Spinner from './Spinner.jsx';
import { fetchProductDaily } from '../api/client.js';
import { formatCurrency, formatDay, formatNumber } from '../lib/format.js';

const STATUS_STYLES = {
  SALE: 'bg-emerald-50 text-emerald-700',
  CANCELLED: 'bg-red-50 text-red-700',
  RETURNED: 'bg-amber-50 text-amber-700',
};

/**
 * Excel'e yazılacak verinin ekrandaki birebir önizlemesi.
 * Kullanıcı indirmeden önce hangi günlerde ne olduğunu görebilir.
 */
export default function ProductDetailModal({ product, range, onClose, onDownload, isDownloading }) {
  const [report, setReport] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showEmptyDays, setShowEmptyDays] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    fetchProductDaily({ barcode: product.barcode, parentKey: product.parentKey, ...range }, { signal: controller.signal })
      .then((data) => !controller.signal.aborted && setReport(data))
      .catch((err) => err.name !== 'AbortError' && setError(err))
      .finally(() => !controller.signal.aborted && setIsLoading(false));

    return () => controller.abort();
  }, [product.barcode, product.parentKey, range.startDate, range.endDate]);

  useEffect(() => {
    const onKeyDown = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const days = (report?.days ?? []).filter((day) => showEmptyDays || day.rows.length > 0);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={`${product.productName} günlük detay`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="card my-auto w-full max-w-5xl overflow-hidden">
        <header className="flex items-start gap-4 border-b border-slate-200 bg-slate-50 p-5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-slate-800">{product.productName}</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {product.barcode ? (
                <span className="font-mono">{product.barcode}</span>
              ) : (
                <span>{product.variantCount} varyant</span>
              )}{' '}
              · {formatDay(range.startDate)} – {formatDay(range.endDate)}
            </p>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => onDownload(product)}
            disabled={isDownloading}
          >
            {isDownloading ? <><Spinner /> Hazırlanıyor…</> : 'Günlük Rapor İndir'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
            aria-label="Kapat"
          >
            ✕
          </button>
        </header>

        {isLoading && (
          <div className="flex flex-col items-center gap-3 p-16 text-slate-500">
            <Spinner className="h-7 w-7 text-trendyol-500" />
            <p className="text-sm">Günlük veriler hesaplanıyor…</p>
          </div>
        )}

        {error && (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-red-700">{error.message}</p>
          </div>
        )}

        {report && !isLoading && (
          <>
            <div className="grid grid-cols-2 gap-px border-b border-slate-200 bg-slate-200 sm:grid-cols-4">
              {[
                ['Satılan Adet', formatNumber(report.totals.quantitySold), 'text-slate-800'],
                ['Brüt Ciro', formatCurrency(report.totals.grossSales), 'text-slate-800'],
                ['Komisyon + Kargo', formatCurrency(report.totals.deductions), 'text-red-600'],
                ['Net Ciro', formatCurrency(report.totals.netRevenue), 'text-trendyol-600'],
              ].map(([label, value, color]) => (
                <div key={label} className="bg-white p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                  <p className={`mt-1 text-lg font-bold tabular-nums ${color}`}>{value}</p>
                </div>
              ))}
            </div>

            {report.meta.warnings.length > 0 && (
              <div className="border-b border-amber-200 bg-amber-50 px-5 py-3">
                {report.meta.warnings.map((warning, index) => (
                  <p key={index} className="text-xs text-amber-800">ⓘ {warning}</p>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between px-5 py-3">
              <p className="text-sm font-semibold text-slate-700">Gün Bazında Hareketler</p>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-500">
                <input
                  type="checkbox"
                  className="rounded border-slate-300 text-trendyol-500 focus:ring-trendyol-400"
                  checked={showEmptyDays}
                  onChange={(e) => setShowEmptyDays(e.target.checked)}
                />
                Hareketsiz günleri de göster
              </label>
            </div>

            <div className="max-h-[55vh] overflow-auto border-t border-slate-200">
              <table className="w-full min-w-[1080px] text-left text-sm">
                <thead className="sticky top-0 z-10 bg-slate-800 text-xs uppercase tracking-wide text-white">
                  <tr>
                    <th scope="col" className="px-3 py-3 font-semibold">#</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Gün</th>
                    <th scope="col" className="px-3 py-3 font-semibold">Saat</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Sipariş Durumu</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Sipariş No</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Müşteri Adı Soyadı</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Beden</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Adet</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Brüt Tutar</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Kesintiler</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Net Ciro</th>
                    <th scope="col" className="px-4 py-3 font-semibold">İptal/İade Nedeni</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((day) => (
                    <DayGroup key={day.date} day={day} />
                  ))}
                  {days.length === 0 && (
                    <tr>
                      <td colSpan={12} className="px-4 py-10 text-center text-slate-500">
                        Bu dönemde hareket bulunmuyor.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {report.reasons.length > 0 && (
              <div className="border-t border-slate-200 p-5">
                <h3 className="text-sm font-semibold text-slate-700">İptal / İade Nedenleri</h3>
                <ul className="mt-3 space-y-2">
                  {report.reasons.map((reason) => (
                    <li key={`${reason.status}-${reason.reason}`} className="flex items-center gap-3">
                      <span
                        className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[reason.status]}`}
                      >
                        {reason.statusLabel}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{reason.reason}</span>
                      <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-500">
                        {formatNumber(reason.quantity)} adet · {formatCurrency(reason.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DayGroup({ day }) {
  return (
    <>
      <tr className="bg-slate-100">
        <th colSpan={7} scope="colgroup" className="px-4 py-2 text-left text-xs font-bold text-slate-700">
          {formatDay(day.date)}
          {day.rows.length > 0 && (
            <span className="ml-2 font-normal text-slate-500">
              · {day.rows.length} hareket · {day.totals.orderCount} sipariş · {day.totals.customerCount} müşteri
            </span>
          )}
        </th>
        <td className="px-4 py-2 text-right text-xs font-semibold tabular-nums text-slate-600">
          {formatNumber(day.totals.quantitySold)}
        </td>
        <td className="px-4 py-2 text-right text-xs font-semibold tabular-nums text-slate-600">
          {formatCurrency(day.totals.grossSales)}
        </td>
        <td className="px-4 py-2 text-right text-xs font-semibold tabular-nums text-slate-600">
          {formatCurrency(day.totals.deductions)}
        </td>
        <td className="px-4 py-2 text-right text-xs font-bold tabular-nums text-trendyol-600">
          {formatCurrency(day.totals.netRevenue)}
        </td>
        <td className="px-4 py-2" />
      </tr>

      {day.rows.length === 0 && (
        <tr className="border-b border-slate-100">
          <td colSpan={12} className="px-4 py-2 text-xs italic text-slate-400">
            Hareket yok
          </td>
        </tr>
      )}

      {day.rows.map((row, index) => (
        <tr
          key={`${row.orderNumber}-${row.orderLineId ?? index}`}
          className={`border-b border-slate-100 ${
            row.status === 'CANCELLED' ? 'bg-red-50/60' : row.status === 'RETURNED' ? 'bg-amber-50/60' : ''
          }`}
        >
          <td className="px-3 py-2 text-xs tabular-nums text-slate-400">{row.sequence}</td>
          <td className="px-4 py-2 text-xs text-slate-500">{formatDay(row.day)}</td>
          <td className="px-3 py-2 text-xs tabular-nums text-slate-500">{row.eventTime || '—'}</td>
          <td className="px-4 py-2">
            <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[row.status]}`}>
              {row.statusLabel}
            </span>
          </td>
          <td className="px-4 py-2 font-mono text-xs text-slate-600">{row.orderNumber}</td>
          <td className="px-4 py-2 text-xs font-medium text-slate-700">{row.customerFullName || '—'}</td>
          <td className="px-4 py-2 text-xs text-slate-600">{row.variantLabel || row.productSize || '—'}</td>
          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(row.quantity)}</td>
          <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(row.grossAmount)}</td>
          <td className="px-4 py-2 text-right tabular-nums text-red-600">{formatCurrency(row.deductions)}</td>
          <td
            className={`px-4 py-2 text-right font-semibold tabular-nums ${
              row.netRevenue > 0 ? 'text-emerald-700' : row.netRevenue < 0 ? 'text-red-700' : 'text-slate-400'
            }`}
          >
            {formatCurrency(row.netRevenue)}
          </td>
          <td className="px-4 py-2 text-xs text-slate-600">{row.reason || '—'}</td>
        </tr>
      ))}
    </>
  );
}
