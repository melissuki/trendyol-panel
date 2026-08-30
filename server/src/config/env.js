import 'dotenv/config';
import { z } from 'zod';

/**
 * Tum ortam degiskenleri tek yerden, tipli ve dogrulanmis sekilde okunur.
 * Eksik/yanlis bir kimlik bilgisi varsa uygulama ACILISTA patlar -
 * yarim yamalak calisan bir raporlama sunucusundan iyidir.
 */

const boolish = (fallback) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v)));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  TRENDYOL_SELLER_ID: z.string().min(1, 'TRENDYOL_SELLER_ID zorunlu'),
  TRENDYOL_API_KEY: z.string().min(1, 'TRENDYOL_API_KEY zorunlu'),
  TRENDYOL_API_SECRET: z.string().min(1, 'TRENDYOL_API_SECRET zorunlu'),
  TRENDYOL_BASE_URL: z.string().url().default('https://apigw.trendyol.com/integration'),
  TRENDYOL_INTEGRATION_TAG: z.string().default('SelfIntegration'),
  TRENDYOL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  TRENDYOL_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(4),

  USE_FINANCE_API: boolish(false),
  DEFAULT_COMMISSION_RATE: z.coerce.number().min(0).max(1).default(0.185),
  SHIPPING_COST_PER_ORDER: z.coerce.number().min(0).default(0),
  RETURN_SHIPPING_COST: z.coerce.number().min(0).default(0),
  COMMISSION_REFUNDED_ON_RETURN: boolish(true),

  /**
   * IADE KARGO BEDELI (TL/adet).
   * Trendyol mutabakat kayitlari iade kargosunu SATIR BAZINDA dondurmuyor
   * (Sale kaydinda boyle bir alan yok - canli olarak dogrulandi). Bu yuzden
   * iade kargosu tek yapilandirilabilir kalemdir ve YALNIZCA IADELERE
   * uygulanir; iptallerde uygulanmaz. 0 birakilirsa hic uygulanmaz.
   * Bu kalemi kullanan satirlar raporda "Tahmini" olarak etiketlenir.
   */
  RETURN_SHIPPING_FEE: z.coerce.number().min(0).default(0),

  REPORT_TIMEZONE: z.string().default('Europe/Istanbul'),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
  MAX_RANGE_DAYS: z.coerce.number().int().positive().default(180),

  // -------------------------------------------------------------------------
  // YONETICI GIRISI / OTURUM
  // Parola ASLA duz metin saklanmaz; yalnizca bcrypt ozeti (.env icinde).
  // Ozet uretmek icin:  npm run auth:hash
  // -------------------------------------------------------------------------
  ADMIN_USERNAME: z.string().trim().min(3, 'ADMIN_USERNAME en az 3 karakter olmali').optional(),
  ADMIN_PASSWORD_HASH: z
    .string()
    .trim()
    .regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, 'ADMIN_PASSWORD_HASH gecerli bir bcrypt ozeti olmali')
    .optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET en az 32 karakter olmali').optional(),
  JWT_EXPIRES_IN: z.string().default('8h'),
  JWT_ISSUER: z.string().default('trendyol-analytics'),
  AUTH_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  AUTH_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
});

const parsed = schema
  .superRefine((value, ctx) => {
    // Uretimde kimlik dogrulama YAPILANDIRILMAK ZORUNDA. Aksi halde panel
    // ve Trendyol verisi internete acik kalir.
    if (value.NODE_ENV !== 'production') return;
    for (const key of ['ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'JWT_SECRET']) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} uretim ortaminda zorunludur (npm run auth:hash ile olusturun)`,
        });
      }
    }
  })
  .safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`\n[config] Ortam degiskenleri gecersiz:\n${details}\n\n.env dosyanizi .env.example ile karsilastirin.\n`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);

// Base URL gercek Trendyol gateway'ini gostermiyorsa (or. yerel bir mock)
// acilista uyar - aksi halde tum istekler anlasilmaz bir 502 ile doner.
if (!/(^|\.)trendyol\.com$/i.test(new URL(env.TRENDYOL_BASE_URL).hostname)) {
  // eslint-disable-next-line no-console
  console.warn(
    `[config] UYARI: TRENDYOL_BASE_URL bir Trendyol adresi degil -> ${env.TRENDYOL_BASE_URL}\n` +
      `          Gercek veri icin: https://apigw.trendyol.com/integration`,
  );
}

export const isProd = env.NODE_ENV === 'production';
