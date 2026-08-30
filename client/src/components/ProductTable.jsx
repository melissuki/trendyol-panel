import { useMemo, useState } from 'react';
import Spinner from './Spinner.jsx';
import { formatCurrency, formatNumber, formatPercent } from '../lib/format.js';

/**
 * ANA URUN TABLOSU (akordiyon)
 *
 * Ayni urunun bedenleri artik listeyi doldurmuyor: her satir bir ANA URUNu
 * temsil eder. Satira tiklaninca beden/varyant kirilimi acilir.
 * Excel'e hem ana urun hem tek varyant raporu indirilebilir; her iki durumda
 * da varyant kirilimi dosyada korunur.
 */

const SORT_OPTIONS = [
  { key: 'grossSales', label: 'Brüt ciroya göre' },
  { key: 'netRevenue', label: 'Net ciroya göre' },
  { key: 'quantitySold', label: 'Satış adedine göre' },
  { key: 'returnRate', label: 'İptal/iade oranına göre' },
  { key: 'productName', label: 'Ürün adına göre (A-Z)' },
];

function Chevron({ open }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7.293 4.293a1 1 0 011.414 0l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414-1.414L11.586 10 7.293 5.707a1 1 0 010-1.414z" />
    </svg>
  );
}

/**
 * Net cironun ne kadarinin KESINLESMIS ne kadarinin TAHMINI oldugunu gosterir.
 * Mali musavir hangi tutarin projeksiyon oldugunu tek bakista gormeli.
 */
function ValuationBadge({ settled = 0, estimated = 0 }) {
  if (!estimated) {
    if (!settled) return null;
    return (
      <span
        className="ml-1.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"
        title="Tüm tutarlar Trendyol mutabakat kaydından alınmıştır."
      >
        Kesinleşmiş
      </span>
    );
  }
  return (
    <span
      className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
      title={`${estimated} satır için mutabakat kaydı henüz oluşmadı; komisyon, siparişteki gerçek komisyon oranıyla hesaplandı. ${settled} satır kesinleşmiş.`}
    >
      {settled > 0 ? `${estimated} tahmini` : 'Tahmini'}
    </span>
  );
}

function DownloadButton({ onClick, isBusy, label, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isBusy}
      aria-busy={isBusy}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-trendyol-400 hover:text-trendyol-600 disabled:opacity-60 ${className}`}
    >
      {isBusy ? (
        <>
          <Spinner className="h-3.5 w-3.5" />
          Hazırlanıyor…
        </>
      ) : (
        <>
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 2a1 1 0 011 1v8.586l2.293-2.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 11.586V3a1 1 0 011-1z" />
            <path d="M3 15a1 1 0 011 1v1h12v-1a1 1 0 112 0v1a2 2 0 01-2 2H4a2 2 0 01-2-2v-1a1 1 0 011-1z" />
          </svg>
          {label}
        </>
      )}
    </button>
  );
}

export default function ProductTable({
  products,
  isLoading,
  error,
  onRetry,
  onDownloadParent,
  onDownloadVariant,
  onPreview,
  isDownloading,
}) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('grossSales');
  const [expanded, setExpanded] = useState(() => new Set());

  const toggle = (parentKey) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(parentKey)) next.delete(parentKey);
      else next.add(parentKey);
      return next;
    });

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('tr-TR');
    const matches = (value) => String(value ?? '').toLocaleLowerCase('tr-TR').includes(term);

    // Arama ana urun adinda VE varyantlarin barkod/SKU'sunda calisir
    const filtered = term
      ? products.filter(
          (p) =>
            matches(p.productName) ||
            (p.variants ?? []).some((v) => matches(v.barcode) || matches(v.merchantSku) || matches(v.productName)),
        )
      : products;

    return [...filtered].sort((a, b) =>
      sortKey === 'productName'
        ? String(a.productName).localeCompare(String(b.productName), 'tr')
        : (b[sortKey] ?? 0) - (a[sortKey] ?? 0),
    );
  }, [products, search, sortKey]);

  if (isLoading) {
    return (
      <div className="card flex flex-col items-center justify-center gap-3 p-16 text-slate-500">
        <Spinner className="h-8 w-8 text-trendyol-500" />
        <p className="text-sm font-medium">Trendyol siparişleri ve mutabakat kayıtları getiriliyor…</p>
        <p className="text-xs text-slate-400">Geniş tarih aralıklarında bu işlem biraz sürebilir.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card border-red-200 bg-red-50 p-8 text-center">
        <p className="text-2xl">⚠️</p>
        <h3 className="mt-2 text-base font-semibold text-red-800">Veriler alınamadı</h3>
        <p className="mx-auto mt-1 max-w-xl text-sm text-red-700">{error.message}</p>
        {Array.isArray(error.details) && (
          <ul className="mx-auto mt-2 max-w-xl list-inside list-disc text-left text-xs text-red-600">
            {error.details.map((detail, index) => (
              <li key={index}>{detail.alan ? `${detail.alan}: ${detail.mesaj}` : JSON.stringify(detail)}</li>
            ))}
          </ul>
        )}
        <button type="button" className="btn-ghost mt-4" onClick={onRetry}>
          Tekrar Dene
        </button>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="card p-16 text-center">
        <p className="text-3xl">📦</p>
        <h3 className="mt-3 text-base font-semibold text-slate-700">Bu tarih aralığında satış bulunamadı</h3>
        <p className="mt-1 text-sm text-slate-500">Farklı bir tarih aralığı seçmeyi deneyin.</p>
      </div>
    );
  }

  const totalVariants = visible.reduce((sum, p) => sum + (p.variantCount ?? 0), 0);

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Satılan Ürünler</h2>
          <p className="text-sm text-slate-500">
            {formatNumber(visible.length)} ana ürün · {formatNumber(totalVariants)} varyant
            {visible.length !== products.length && ` (toplam ${formatNumber(products.length)} ana ürün)`}
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="search"
            className="input sm:w-64"
            placeholder="Ürün adı, barkod veya SKU ara…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Ürün ara"
          />
          <select
            className="input sm:w-56"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value)}
            aria-label="Sıralama ölçütü"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="card p-12 text-center text-sm text-slate-500">Aramanızla eşleşen ürün bulunamadı.</div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 text-left font-semibold">Ürün</th>
                  <th className="px-3 py-3 text-right font-semibold">Satış</th>
                  <th className="px-3 py-3 text-right font-semibold" title="Sipariş satırı statüsü 'Cancelled' olanlar">
                    İptal
                  </th>
                  <th className="px-3 py-3 text-right font-semibold" title="Trendyol /claims iade talebi onaylanmış olanlar">
                    İade
                  </th>
                  <th className="px-3 py-3 text-right font-semibold">Brüt Ciro</th>
                  <th className="px-3 py-3 text-right font-semibold">Komisyon</th>
                  <th className="px-3 py-3 text-right font-semibold">Net Ciro</th>
                  <th className="px-4 py-3 text-right font-semibold">İşlem</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {visible.map((parent) => {
                  const isOpen = expanded.has(parent.parentKey);
                  const rowId = `variants-${parent.parentKey}`;
                  return [
                    // --- ANA URUN SATIRI ---
                    <tr
                      key={parent.parentKey}
                      className="cursor-pointer transition hover:bg-slate-50"
                      onClick={() => toggle(parent.parentKey)}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-start gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(parent.parentKey);
                            }}
                            aria-expanded={isOpen}
                            aria-controls={rowId}
                            aria-label={`${parent.productName} varyantlarını ${isOpen ? 'gizle' : 'göster'}`}
                            className="mt-0.5"
                          >
                            <Chevron open={isOpen} />
                          </button>
                          <div className="min-w-0">
                            <p className="font-semibold leading-snug text-slate-800" title={parent.productName}>
                              {parent.productName}
                            </p>
                            <p className="mt-0.5 text-xs text-slate-500">
                              {formatNumber(parent.variantCount)} varyant · {formatNumber(parent.orderCount)} sipariş
                              {parent.cancelRate > 0 && <> · iptal {formatPercent(parent.cancelRate)}</>}
                              {parent.returnOnlyRate > 0 && <> · iade {formatPercent(parent.returnOnlyRate)}</>}
                              {parent.quantityReturnPending > 0 && (
                                <> · {formatNumber(parent.quantityReturnPending)} iade onayı bekliyor</>
                              )}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-semibold tabular-nums text-emerald-700">
                        {formatNumber(parent.quantitySold)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-500">
                        {parent.quantityCancelled ? formatNumber(parent.quantityCancelled) : '—'}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-500">
                        {parent.quantityReturned ? formatNumber(parent.quantityReturned) : '—'}
                      </td>
                      <td className="px-3 py-3 text-right font-semibold tabular-nums text-slate-800">
                        {formatCurrency(parent.grossSales)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-600">
                        {formatCurrency(parent.commission)}
                      </td>
                      <td className="px-3 py-3 text-right font-bold tabular-nums text-trendyol-600">
                        <span className="inline-flex items-center">
                          {formatCurrency(parent.netRevenue)}
                          <ValuationBadge settled={parent.settledLines} estimated={parent.estimatedLines} />
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-2">
                          <DownloadButton
                            onClick={() => onDownloadParent(parent)}
                            isBusy={isDownloading(parent.parentKey)}
                            label="Excel"
                          />
                          <button
                            type="button"
                            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-trendyol-400 hover:text-trendyol-600"
                            onClick={() => onPreview(parent)}
                          >
                            Önizle
                          </button>
                        </div>
                      </td>
                    </tr>,

                    // --- VARYANT SATIRLARI (akordiyon) ---
                    isOpen && (
                      <tr key={`${parent.parentKey}-variants`} id={rowId} className="bg-slate-50/60">
                        <td colSpan={8} className="px-4 py-0">
                          <table className="w-full text-xs">
                            <tbody className="divide-y divide-slate-200/70">
                              {parent.variants.map((variant) => (
                                <tr key={variant.barcode}>
                                  <td className="py-2.5 pl-6 pr-3">
                                    <span className="inline-flex items-center gap-2">
                                      <span className="rounded bg-white px-2 py-0.5 font-semibold text-slate-700 ring-1 ring-slate-200">
                                        {variant.variantLabel || '—'}
                                      </span>
                                      <span className="font-mono text-[11px] text-slate-400">{variant.barcode}</span>
                                    </span>
                                  </td>
                                  <td className="w-[8%] py-2.5 text-right tabular-nums text-emerald-700">
                                    {formatNumber(variant.quantitySold)}
                                  </td>
                                  <td className="w-[8%] py-2.5 text-right tabular-nums text-slate-400">
                                    {variant.quantityCancelled || '—'}
                                  </td>
                                  <td className="w-[8%] py-2.5 text-right tabular-nums text-slate-400">
                                    {variant.quantityReturned || '—'}
                                  </td>
                                  <td className="w-[12%] py-2.5 text-right tabular-nums text-slate-700">
                                    {formatCurrency(variant.grossSales)}
                                  </td>
                                  <td className="w-[12%] py-2.5 text-right tabular-nums text-slate-500">
                                    {formatCurrency(variant.commission)}
                                  </td>
                                  <td className="w-[12%] py-2.5 text-right font-semibold tabular-nums text-slate-800">
                                    <span className="inline-flex items-center">
                                      {formatCurrency(variant.netRevenue)}
                                      <ValuationBadge settled={variant.settledLines} estimated={variant.estimatedLines} />
                                    </span>
                                  </td>
                                  <td className="w-[14%] py-2.5 pl-3 text-right">
                                    <DownloadButton
                                      onClick={() => onDownloadVariant(variant, parent)}
                                      isBusy={isDownloading(variant.barcode)}
                                      label="Excel"
                                    />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
