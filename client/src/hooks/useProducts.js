import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchProducts } from '../api/client.js';

/**
 * Seçili tarih aralığındaki ürünleri getirir.
 * Aralık değişince önceki istek iptal edilir (yarış durumunu önler).
 */
export function useProducts(range) {
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const controllerRef = useRef(null);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (!range.startDate || !range.endDate) return undefined;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setIsLoading(true);
    setError(null);

    fetchProducts(range, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setError(err);
        setData(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [range.startDate, range.endDate, reloadToken]);

  return { data, isLoading, error, reload };
}
