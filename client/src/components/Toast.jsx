import { useEffect } from 'react';

/** Sağ altta beliren bildirim. Başarı yeşil, hata kırmızı. */
export default function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(onClose, toast.type === 'error' ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;

  const isError = toast.type === 'error';

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-50 w-[min(24rem,calc(100vw-3rem))] animate-[fadeIn_.2s_ease-out]"
    >
      <div
        className={`card flex items-start gap-3 border-l-4 p-4 ${
          isError ? 'border-l-red-500 bg-red-50' : 'border-l-emerald-500 bg-emerald-50'
        }`}
      >
        <span className="text-lg leading-none">{isError ? '⚠️' : '✅'}</span>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${isError ? 'text-red-800' : 'text-emerald-800'}`}>
            {isError ? 'Hata' : 'Başarılı'}
          </p>
          <p className={`mt-0.5 break-words text-sm ${isError ? 'text-red-700' : 'text-emerald-700'}`}>
            {toast.message}
          </p>
          {toast.fileName && <p className="mt-1 truncate text-xs text-emerald-600">{toast.fileName}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-1.5 text-slate-400 transition hover:bg-white hover:text-slate-600"
          aria-label="Bildirimi kapat"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
