import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { parseQuery, productReportSchema, rangeSchema } from '../middleware/validate.js';
import { badRequest } from '../lib/errors.js';
import { buildProductDailyReport, getProductCatalog } from '../services/aggregationService.js';

export const productsRouter = Router();

/**
 * GET /api/products?startDate=2026-08-01&endDate=2026-08-29
 * Seçilen aralıkta satılan tüm farklı ürünleri döner.
 */
productsRouter.get(
  '/products',
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = parseQuery(rangeSchema, req.query);
    try {
      const data = await getProductCatalog({ startDate, endDate });
      res.json(data);
    } catch (error) {
      if (error?.status) throw error;
      throw badRequest(error.message);
    }
  }),
);

/**
 * GET /api/products/daily?barcode=...&startDate=...&endDate=...
 * Excel'e yazılan verinin JSON önizlemesi (ekranda detay göstermek için).
 */
productsRouter.get(
  '/products/daily',
  asyncHandler(async (req, res) => {
    const { startDate, endDate, barcode, parentKey } = parseQuery(productReportSchema, req.query);
    try {
      const report = await buildProductDailyReport({ startDate, endDate, barcode, parentKey });
      res.json(report);
    } catch (error) {
      if (error?.status) throw error;
      throw badRequest(error.message);
    }
  }),
);
