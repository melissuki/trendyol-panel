import { useEffect, useMemo, useState } from 'react';
import { addDays, formatDay, toInputDate } from '../lib/format.js';

/**
 * TARIH ARALIGI SECICI - SIKI DOGRULAMA
 *
 * Kritik kural: ekranda gosterilen veri HER ZAMAN `value` ile birebir ayni
 * araliga aittir. Kullanici tarihleri duzenlerken (draft) rapor degismez;
 * yalnizca "Raporu Getir" ile uygulanir. Boylece "ekranda gorunen tarih" ile
 * "veriyi getiren tarih" hicbir an birbirinden ayrilmaz.
 */
const PRESETS = [
  { key: 'today', label: 'Bugün', days: 0 },
  { key: 'last7', label: 'Son 7 Gün', days: 6 },
  { key: 'last30', label: 'Son 30 Gün', days: 29 },
  { key: 'thisMonth', label: 'Bu Ay', month: true },
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function DateRangePicker({ value, onApply, isLoading, maxRangeDays = 180 }) {
  const [draft, setDraft] = useState(value);
  const today = toInputDate(new Date());

  // Ust bilesen araligi disaridan degistirirse (or. onizleme, geri tusu)
  // taslak formu onunla senkron kalir.
  useEffect(() => setDraft(value), [value.startDate, value.endDate]);

  const validation = useMemo(() => {
    const { startDate, endDate } = draft;
    if (!startDate || !endDate) return 'Lütfen başlangıç ve bitiş tarihi seçin.';
    if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) return 'Tarih biçimi geçersiz (YYYY-AA-GG bekleniyor).';
    if (endDate < startDate) return 'Bitiş tarihi, başlangıç tarihinden önce olamaz.';
    if (endDate > today) return 'Gelecek bir tarih seçilemez.';
    const diff = Math.round((new Date(endDate) - new Date(startDate)) / 86_400_000) + 1;
    if (diff > maxRangeDays) return `Tarih aralığı en fazla ${maxRangeDays} gün olabilir (seçilen: ${diff} gün).`;
    return null;
  }, [draft, maxRangeDays, today]);

  const isDirty = draft.startDate !== value.startDate || draft.endDate !== value.endDate;

  const applyPreset = (preset) => {
    const now = new Date();
    const next = preset.month
      ? { startDate: toInputDate(new Date(now.getFullYear(), now.getMonth(), 1)), endDate: toInputDate(now) }
      : { startDate: toInputDate(addDays(now, -preset.days)), endDate: toInputDate(now) };
    setDraft(next);
    onApply(next);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (validation) return;
    onApply(draft);
  };

  return (
    <form onSubmit={handleSubmit} className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-full sm:w-auto">
          <label htmlFor="startDate" className="label">
            Başlangıç Tarihi
          </label>
          <input
            id="startDate"
            type="date"
            className="input sm:w-44"
            value={draft.startDate}
            max={draft.endDate || today}
            onChange={(e) => setDraft((d) => ({ ...d, startDate: e.target.value }))}
          />
        </div>

        <div className="w-full sm:w-auto">
          <label htmlFor="endDate" className="label">
            Bitiş Tarihi
          </label>
          <input
            id="endDate"
            type="date"
            className="input sm:w-44"
            value={draft.endDate}
            min={draft.startDate}
            max={today}
            onChange={(e) => setDraft((d) => ({ ...d, endDate: e.target.value }))}
          />
        </div>

        <button
          type="submit"
          className="btn-primary h-[42px] w-full sm:w-auto"
          disabled={Boolean(validation) || isLoading}
        >
          {isLoading ? 'Yükleniyor…' : isDirty ? 'Raporu Getir' : 'Yenile'}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Hızlı Seçim</span>
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            onClick={() => applyPreset(preset)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-trendyol-400 hover:text-trendyol-600"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {validation ? (
        <p className="mt-3 text-sm font-medium text-red-600">{validation}</p>
      ) : (
        <p className="mt-3 text-sm text-slate-500">
          Ekrandaki tüm veriler şu aralığa aittir:{' '}
          <span className="font-semibold text-slate-700">
            {formatDay(value.startDate)} – {formatDay(value.endDate)}
          </span>
          {isDirty && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-700">
              Yeni aralık için “Raporu Getir”e basın
            </span>
          )}
        </p>
      )}
    </form>
  );
}
