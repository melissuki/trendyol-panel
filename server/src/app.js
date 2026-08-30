import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { env, isProd } from './config/env.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './routes/auth.js';
import { requireAuth } from './middleware/auth.js';
import { diagnosticsRouter } from './routes/diagnostics.js';
import { healthRouter } from './routes/health.js';
import { productsRouter } from './routes/products.js';
import { reportsRouter } from './routes/reports.js';

/**
 * EXPRESS UYGULAMASI (yalnizca yapilandirma - PORT DINLEMEZ)
 * =============================================================================
 * Bu dosya bilerek `listen()` CAGIRMAZ. Boylece ayni uygulama iki ortamda da
 * calisir:
 *   - Yerel/sunucu : src/index.js dosyasi bunu import edip listen() eder
 *   - Vercel       : api/[...path].js dosyasi bunu handler olarak disa aktarir
 *
 * Sunucusuz (serverless) ortamda port dinlemek HATADIR; fonksiyon her istekte
 * cagrilir, kalici bir soket yoktur.
 */

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));

/**
 * CORS - KENDINI YAPILANDIRAN
 * =============================================================================
 * Vercel'de frontend ve API AYNI alan adinda calisir, dolayisiyla aslinda
 * CORS'a hic gerek yoktur. Ancak tarayici POST isteklerinde ayni kaynakta bile
 * `Origin` basligi gonderir; eski kod bunu listede bulamayinca 403 donuyordu.
 *
 * Ayrica Vercel HER DAGITIMDA yeni bir alan adi uretir
 * (trendyol-panel-dk52latws-melissuky.vercel.app gibi), bu yuzden alan adini
 * elle .env'ye yazmak surdurulebilir degildir.
 *
 * Izin kurallari (sirayla):
 *   1) Origin YOK            -> izin ver (curl / sunucu-sunucu; CORS basligi gerekmez)
 *   2) Origin == istegin kendi host'u -> AYNI KAYNAK, izin ver (yapilandirma gerekmez)
 *   3) CORS_ORIGINS listesinde -> izin ver
 *   4) *.vercel.app onizleme adresi ve CORS_ALLOW_VERCEL=true -> izin ver
 *   5) aksi halde -> 403
 */
const VERCEL_HOST_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

/** Istegin gercek host'u (Vercel proxy arkasinda x-forwarded-host gelir). */
function requestHost(req) {
  return String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').toLowerCase();
}

function isOriginAllowed(origin, req) {
  if (!origin) return { allowed: true, reason: 'origin-yok' };

  let originHost = '';
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return { allowed: false, reason: 'gecersiz-origin' };
  }

  // 2) Ayni kaynak: frontend ve API ayni alan adinda (Vercel dagitimi)
  if (originHost && originHost === requestHost(req)) return { allowed: true, reason: 'ayni-kaynak' };

  // 3) Acikca izin verilen originler
  if (env.CORS_ORIGINS.includes(origin)) return { allowed: true, reason: 'listede' };

  // 4) Vercel onizleme adresleri (her dagitimda degistigi icin kalip ile)
  if (env.CORS_ALLOW_VERCEL && VERCEL_HOST_RE.test(origin)) {
    return { allowed: true, reason: 'vercel-onizleme' };
  }

  return { allowed: false, reason: 'izin-yok' };
}

/**
 * cors() secenekleri istek bazinda hesaplanir - boylece `req` uzerinden
 * ayni-kaynak kontrolu yapabiliyoruz (sabit secenek nesnesiyle mumkun degil).
 */
const corsDelegate = (req, callback) => {
  const origin = req.headers.origin;
  const { allowed, reason } = isOriginAllowed(origin, req);

  if (!allowed) {
    logger.warn('CORS reddedildi', { origin, host: requestHost(req), reason });
    return callback(
      new AppError(
        `CORS politikası bu kaynağa izin vermiyor: ${origin}. ` +
          'Sunucudaki CORS_ORIGINS değerine bu adresi ekleyin.',
        { status: 403, code: 'CORS_FORBIDDEN' },
      ),
    );
  }

  return callback(null, {
    // Origin yoksa CORS basligina gerek yok; varsa yalnizca o origin'e izin ver
    origin: origin ?? false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
    exposedHeaders: ['Content-Disposition', 'X-Report-Rows'],
    credentials: false,
    maxAge: 600,
  });
};

app.use(cors(corsDelegate));
app.options('*', cors(corsDelegate));

app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use(morgan(isProd ? 'combined' : 'dev'));

// Trendyol API'sini korumak icin istemci basina kaba bir sinir
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Çok fazla istek gönderildi, lütfen biraz bekleyin.' } },
  }),
);

// --- Kimlik dogrulama: giris ve durum uc noktalari HERKESE ACIK ------------
app.use('/api', authRouter);

/**
 * AUTH GUARD
 * Bu satirdan SONRA tanimlanan tum /api/* rotalari gecerli bir JWT ister.
 * /api/health (sunucu ayakta mi) bilerek disarida tutulur: yuk dengeleyici ve
 * izleme sistemleri kimlik dogrulamadan saglik kontrolu yapabilmeli.
 * Trendyol verisi donen HICBIR uc nokta korumasiz degildir.
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

app.use('/api', requireAuth);

app.use('/api', diagnosticsRouter);
app.use('/api', healthRouter);
app.use('/api', productsRouter);
app.use('/api', reportsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
