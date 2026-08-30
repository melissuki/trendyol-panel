import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { parseQuery, productReportSchema } from '../middleware/validate.js';
import { badRequest } from '../lib/errors.js';
import { buildProductDailyReport } from '../services/aggregationService.js';
import { EXCEL_MIME, buildFileName, buildProductWorkbook } from '../services/excelService.js';
import { logger } from '../lib/logger.js';

export const reportsRouter = Router();

/**
 * GET /api/reports/product.xlsx?barcode=...&startDate=...&endDate=...
 * Ürünün gün gün raporunu .xlsx olarak akıtır.
 */
reportsRouter.get(
  '/reports/product.xlsx',
  asyncHandler(async (req, res) => {
    const { startDate, endDate, barcode, parentKey } = parseQuery(productReportSchema, req.query);

    let report;
    try {
      report = await buildProductDailyReport({ startDate, endDate, barcode, parentKey });
    } catch (error) {
      if (error?.status) throw error;
      throw badRequest(error.message);
    }

    const workbook = await buildProductWorkbook(report);
    const { pretty, ascii } = buildFileName(report);

    res.setHeader('Content-Type', EXCEL_MIME);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(pretty)}`,
    );
    res.setHeader('Cache-Control', 'no-store');
    // Frontend'in dosya adını okuyabilmesi için CORS'ta expose edilir (bkz. index.js)
    res.setHeader('X-Report-Rows', String(report.rows.length));

    await workbook.xlsx.write(res);
    logger.info('excel streamed', { barcode, rows: report.rows.length, file: ascii });
    res.end();
  }),
);
