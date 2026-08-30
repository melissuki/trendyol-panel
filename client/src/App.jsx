import { useCallback, useState } from 'react';
import DateRangePicker from './components/DateRangePicker.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import ProductDetailModal from './components/ProductDetailModal.jsx';
import ProductTable from './components/ProductTable.jsx';
import Spinner from './components/Spinner.jsx';
import SummaryCards from './components/SummaryCards.jsx';
import Toast from './components/Toast.jsx';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { useProducts } from './hooks/useProducts.js';
import { useReportDownload } from './hooks/useReportDownload.js';
import { addDays, formatDay, toInputDate } from './lib/format.js';

const DEFAULT_RANGE = {
  startDate: toInputDate(addDays(new Date(), -29)),
  endDate: toInputDate(new Date()),
};

function Dashboard() {
  const { user, logout } = useAuth();
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [toast, setToast] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);

  const { data, isLoading, error, reload } = useProducts(range);

  const { download, isDownloading } = useReportDownload({
    onSuccess: ({ message, fileName }) => setToast({ type: 'success', message, fileName }),
    onError: ({ message }) => setToast({ type: 'error', message }),
  });

  /**
   * Excel indirmede aralik HER ZAMAN `range`ten (uygulanan aralik) alinir -
   * asla taslak formdan. Ekranda gorunen veri ile dosyadaki veri ayni olur.
   */
  const handleDownloadParent = useCallback(
    (parent) =>
      download({
        key: parent.parentKey,
        parentKey: parent.parentKey,
        productName: parent.productName,
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [download, range],
  );

  const handleDownloadVariant = useCallback(
    (variant, parent) =>
      download({
        key: variant.barcode,
        barcode: variant.barcode,
        productName: `${parent.productName} — ${variant.variantLabel}`,
        startDate: range.startDate,
        endDate: range.endDate,
      }),
    [download, range],
  );

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-4 sm:px-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-trendyol-500 text-lg font-black text-white">
            T
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-slate-800">Trendyol Satış Analiz Paneli</h1>
            <p className="text-xs text-slate-500">
              Ürün bazlı günlük satış, iptal/iade ve mutabakat doğrulamalı net ciro raporlaması
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-slate-500 sm:inline">
              <span className="font-semibold text-slate-700">{user?.username}</span>
            </span>
            <button
              type="button"
              onClick={logout}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-red-300 hover:text-red-600"
            >
              Çıkış Yap
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        <DateRangePicker value={range} onApply={setRange} isLoading={isLoading} />

        <SummaryCards totals={data?.totals} finance={data?.finance} isLoading={isLoading} />

        <ProductTable
          products={data?.products ?? []}
          isLoading={isLoading}
          error={error}
          onRetry={reload}
          onDownloadParent={handleDownloadParent}
          onDownloadVariant={handleDownloadVariant}
          onPreview={setSelectedProduct}
          isDownloading={isDownloading}
        />
      </main>

      <footer className="border-t border-slate-200 py-6 text-center text-xs text-slate-400">
        Komisyon ve kargo/hizmet kesintileri Trendyol Mutabakat (Settlement) API'sinden işlem bazında alınır;
        sabit oran tahmini kullanılmaz. Rapor aralığı: {formatDay(range.startDate)} – {formatDay(range.endDate)}.
      </footer>

      {selectedProduct && (
        <ProductDetailModal
          product={selectedProduct}
          range={range}
          onClose={() => setSelectedProduct(null)}
          onDownload={handleDownloadParent}
          isDownloading={isDownloading(selectedProduct.parentKey)}
        />
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

/** Oturum durumuna göre giriş ekranı ya da panel gösterilir. */
function Gate() {
  const { status } = useAuth();

  if (status === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-slate-500">
          <Spinner className="h-8 w-8 text-trendyol-500" />
          <p className="text-sm">Oturum doğrulanıyor…</p>
        </div>
      </div>
    );
  }

  return status === 'authenticated' ? <Dashboard /> : <LoginScreen />;
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
