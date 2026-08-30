import { useCallback, useState } from 'react';
import { downloadProductReport } from '../api/client.js';

/**
 * Ürün bazlı Excel indirme durumunu yönetir.
 * Aynı anda birden fazla ürün indirilebilsin diye durum barkod bazında tutulur.
 */
export function useReportDownload({ onSuccess, onError } = {}) {
  const [downloading, setDownloading] = useState({});

  const download = useCallback(
    async ({ key, barcode, parentKey, startDate, endDate, productName }) => {
      // Indirme durumu ana urun icin parentKey, varyant icin barkod ile izlenir
      const trackingKey = key ?? barcode ?? parentKey;
      setDownloading((prev) => ({ ...prev, [trackingKey]: true }));
      try {
        const result = await downloadProductReport({ barcode, parentKey, startDate, endDate });
        onSuccess?.({
          message: `"${productName}" ürününün günlük raporu indirildi.`,
          fileName: result.fileName,
        });
        return result;
      } catch (error) {
        onError?.({
          message: error.message || 'Rapor oluşturulurken bir hata oluştu.',
          details: error.details,
        });
        return null;
      } finally {
        setDownloading((prev) => {
          const next = { ...prev };
          delete next[trackingKey];
          return next;
        });
      }
    },
    [onSuccess, onError],
  );

  return { download, downloading, isDownloading: (key) => Boolean(downloading[key]) };
}
