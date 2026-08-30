import { z } from 'zod';
import { badRequest } from '../lib/errors.js';

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih formatı YYYY-MM-DD olmalıdır');

export const rangeSchema = z.object({
  startDate: dateSchema,
  endDate: dateSchema,
});

/**
 * Rapor ya tek varyant (barcode) ya da ana urun (parentKey) icin istenir.
 * Ikisinden EN AZ BIRI zorunludur.
 */
export const productReportSchema = rangeSchema
  .extend({
    barcode: z.string().trim().max(120).optional(),
    parentKey: z.string().trim().max(300).optional(),
  })
  .refine((v) => Boolean(v.barcode || v.parentKey), {
    message: 'barcode veya parentKey parametrelerinden biri zorunludur',
    path: ['barcode'],
  });

export function parseQuery(schema, query) {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw badRequest(
      'İstek parametreleri geçersiz.',
      result.error.issues.map((i) => ({ alan: i.path.join('.'), mesaj: i.message })),
    );
  }
  return result.data;
}
