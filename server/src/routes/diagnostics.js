import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { parseQuery, rangeSchema } from '../middleware/validate.js';
import { env } from '../config/env.js';
import { zonedDayEnd, zonedDayStart } from '../lib/dates.js';
import { classifyClaimStatus, classifyLineStatus, summarizeStatuses } from '../lib/status.js';
import { fetchOrderLines } from '../services/ordersService.js';
import { applyClaimsToLines, fetchClaims } from '../services/claimsService.js';
import { buildFinanceLedger } from '../services/financeService.js';

export const diagnosticsRouter = Router();

/**
 * GET /api/diagnostics/statuses?startDate=...&endDate=...
 *
 * TRENDYOL'DAN GELEN HAM STATU DEGERLERINI DOKER.
 * Mali musavir denetiminde "hangi statu string'i hangi kovaya dustu"
 * sorusunun tek cevabi budur. Ciktida her statu icin:
 *   ham deger | normalize edilmis hali | dustugu sinif | adet
 *
 * Ayrica iade taleplerinin siparis satirlariyla hangi ANAHTAR uzerinden
 * eslestigini ve kac talebin eslesmedigini gosterir.
 */
diagnosticsRouter.get(
  '/diagnostics/statuses',
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = parseQuery(rangeSchema, req.query);
    const tz = env.REPORT_TIMEZONE;
    const range = {
      startMs: zonedDayStart(startDate, tz),
      endMs: zonedDayEnd(endDate, tz),
      timeZone: tz,
      startDate,
      endDate,
    };

    const [rawLines, claimRows] = await Promise.all([fetchOrderLines(range), fetchClaims(range)]);
    const { lines, stats } = applyClaimsToLines(rawLines, claimRows);

    const lineStatuses = summarizeStatuses(rawLines.map((l) => l.rawLineStatus), classifyLineStatus);
    const claimStatuses = summarizeStatuses(claimRows.map((c) => c.status), classifyClaimStatus);

    // Siniflandirma sonrasi nihai kova dagilimi
    const finalBuckets = lines.reduce((acc, line) => {
      acc[line.status] = (acc[line.status] ?? 0) + 1;
      return acc;
    }, {});

    res.json({
      range: { startDate, endDate, timeZone: tz },

      siparisSatiriStatuleri: {
        aciklama:
          'Trendyol /orders -> orderLineItemStatusName ham degerleri. ' +
          '"sinif" alani bu değerin hangi kovaya düştüğünü gösterir.',
        toplamSatir: rawLines.length,
        statuler: lineStatuses.map((r) => ({
          ham: r.raw,
          normalize: r.normalized,
          sinif: r.classified,
          adet: r.count,
        })),
        siniflandirilamayan: lineStatuses
          .filter((r) => r.classified === 'UNKNOWN')
          .map((r) => ({ ham: r.raw, adet: r.count, etki: 'SATIŞ sayıldı' })),
      },

      iadeTalebiStatuleri: {
        aciklama:
          'Trendyol /claims -> claimItems[].claimItemStatus.name ham degerleri. ' +
          'YALNIZCA "REJECTED" sınıfı iade sayılmaz; diğerlerinin tamamı gerçek iadedir.',
        toplamTalepSatiri: claimRows.length,
        statuler: claimStatuses.map((r) => ({
          ham: r.raw,
          normalize: r.normalized,
          sinif: r.classified,
          adet: r.count,
          iadeSayildiMi: r.classified !== 'REJECTED' && r.classified !== 'EMPTY',
        })),
        siniflandirilamayan: claimStatuses
          .filter((r) => r.classified === 'UNKNOWN_COUNTED_AS_RETURN')
          .map((r) => ({ ham: r.raw, adet: r.count, etki: 'İADE sayıldı' })),
      },

      eslesme: {
        aciklama: 'İade taleplerinin sipariş satırlarıyla hangi anahtar üzerinden eşleştiği.',
        talepSatiri: stats.claimRowsTotal,
        eslesen: stats.claimRowsMatched,
        eslesmeyen: stats.claimRowsUnmatched,
        eslesmeOrani:
          stats.claimRowsTotal > 0
            ? `%${Math.round((stats.claimRowsMatched / stats.claimRowsTotal) * 1000) / 10}`
            : '-',
        stratejiDagilimi: stats.matchedBy,
        not: 'Eşleşmeyen talepler genelde siparişi seçili aralık DIŞINDA olan taleplerdir.',
      },

      saatDagilimi: {
        aciklama:
          'Siparişlerin Europe/Istanbul saatine göre saat bazlı dağılımı. ' +
          'Günün ilk saatleri (00:00-03:00) beklenmedik şekilde BOŞSA, yukarı akış ' +
          'tarih filtresi günü kırpıyor demektir.',
        saatler: (() => {
          const h = new Array(24).fill(0);
          for (const l of rawLines) {
            const hour = Number(
              new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
                .format(new Date(l.orderDate)),
            );
            if (Number.isFinite(hour)) h[hour] += 1;
          }
          return h.reduce((acc, n, i) => ({ ...acc, [`${String(i).padStart(2, '0')}:00`]: n }), {});
        })(),
        gunler: (() => {
          const m = new Map();
          for (const l of rawLines) {
            const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(l.orderDate));
            m.set(d, (m.get(d) ?? 0) + 1);
          }
          return Object.fromEntries([...m.entries()].sort());
        })(),
      },

      nihaiKovalar: {
        aciklama: 'Statü + claims eşleşmesi sonrası satırların nihai dağılımı.',
        ...finalBuckets,
        teslimEdilemeyenClaimsiz: stats.undeliveredWithoutClaim,
        iptalSatiri: stats.cancelledLines,
        iadeSatiri: stats.returnedLines,
        iadeOnayli: stats.returnedAcceptedLines,
        iadeSurecDevam: stats.returnedInProgressLines,
      },
    });
  }),
);

/**
 * GET /api/diagnostics/finance?startDate=...&endDate=...
 * Mutabakat tarafinda hangi alanlarin/islem tiplerinin geldigini gosterir.
 */
diagnosticsRouter.get(
  '/diagnostics/finance',
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = parseQuery(rangeSchema, req.query);
    const tz = env.REPORT_TIMEZONE;
    const finance = await buildFinanceLedger({
      startMs: zonedDayStart(startDate, tz),
      endMs: zonedDayEnd(endDate, tz),
    });
    res.json({
      range: { startDate, endDate },
      erisilebilir: finance.available,
      uyarilar: finance.warnings,
      teshis: finance.diagnostics,
    });
  }),
);
