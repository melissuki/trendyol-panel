import { useMemo, useState } from 'react';
import ProductCard from './ProductCard.jsx';
import Spinner from './Spinner.jsx';
import { formatNumber } from '../lib/format.js';

const SORT_OPTIONS = [
  { key: 'grossSales', label: 'Brüt ciroya göre' },
  { key: 'quantitySold', label: 'Satış adedine göre' },
  { key: 'estimatedNetRevenue', label: 'Net ciroya göre' },
  { key: 'returnRate', label: 'İptal/iade oranına göre' },
  { key: 'productName', label: 'Ürün adına göre (A-Z)' },
];

export default function ProductList({ products, isLoading, error, onRetry, onDownload, onPreview, isDownloading }) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('grossSales');

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('tr-TR');
    const filtered = term
      ? products.filter((p) =>
          [p.productName, p.barcode, p.merchantSku]
            .filter(Boolean)
            .some((field) => String(field).toLocaleLowerCase('tr-TR').includes(term)),
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
        <p className="text-sm font-medium">Trendyol siparişleri getiriliyor…</p>
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

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Satılan Ürünler</h2>
          <p className="text-sm text-slate-500">
            {formatNumber(visible.length)} ürün listeleniyor
            {visible.length !== products.length && ` (toplam ${formatNumber(products.length)})`}
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
        <div className="card p-12 text-center text-sm text-slate-500">
          Aramanızla eşleşen ürün bulunamadı.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((product) => (
            <ProductCard
              key={product.barcode}
              product={product}
              isDownloading={isDownloading(product.barcode)}
              onDownload={onDownload}
              onPreview={onPreview}
            />
          ))}
        </div>
      )}
    </section>
  );
}
