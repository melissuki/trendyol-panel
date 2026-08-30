import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env, isProd } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

/**
 * YONETICI KIMLIK DOGRULAMA
 *
 * Tasarim kararlari:
 *  - Parola HICBIR yerde duz metin tutulmaz. .env yalnizca bcrypt ozeti icerir.
 *  - Varsayilan/gomulu parola YOKTUR. Yapilandirilmamis kurulumda giris
 *    reddedilir; bu sayede "admin/admin" tarzi arka kapi olusmaz.
 *  - Kullanici adi bulunamasa bile bcrypt karsilastirmasi yine calistirilir
 *    (sahte ozet uzerinde) - boylece yanit suresinden kullanici adi
 *    tahmin edilemez (timing attack).
 *  - Hata mesaji her durumda ayni: kullanici adi mi parola mi yanlis
 *    bilgisi sizdirilmaz (user enumeration).
 */

/** Kullanici bulunamadiginda da bcrypt maliyetini odemek icin sabit sahte ozet. */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.5Ka9Wj6mCJTFHxLbHVvUZQEO1eQ0Yfy';

/** Uretimde JWT_SECRET zorunlu (env.js dogrular). Gelistirmede efemeral uretilir. */
const jwtSecret = (() => {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  const ephemeral = crypto.randomBytes(48).toString('hex');
  logger.warn('JWT_SECRET tanimli degil - gelistirme icin gecici anahtar uretildi', {
    uyari: 'Sunucu her yeniden baslatildiginda oturumlar dusecek. .env icine JWT_SECRET ekleyin.',
  });
  return ephemeral;
})();

export function isAuthConfigured() {
  return Boolean(env.ADMIN_USERNAME && env.ADMIN_PASSWORD_HASH);
}

/** Zamanlama saldirilarina karsi sabit sureli metin karsilastirmasi. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  // timingSafeEqual esit uzunluk ister; once uzunlugu sabit hale getiriyoruz.
  const len = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bufA.copy(padA);
  bufB.copy(padB);
  return crypto.timingSafeEqual(padA, padB) && bufA.length === bufB.length;
}

/**
 * Kullanici adi + parolayi dogrular.
 * @returns {Promise<{ username: string } | null>} basarisizsa null
 */
export async function verifyCredentials(username, password) {
  const configured = isAuthConfigured();
  const expectedHash = configured ? env.ADMIN_PASSWORD_HASH : DUMMY_HASH;

  // Kullanici adi yanlis olsa bile bcrypt'i CALISTIR: yanit suresi ayni kalsin.
  const userMatches = configured && safeEqual(username, env.ADMIN_USERNAME);
  const passwordMatches = await bcrypt.compare(String(password ?? ''), expectedHash);

  if (!configured) {
    throw new AppError(
      'Yönetici hesabı henüz tanımlanmamış. Sunucuda `npm run auth:hash` çalıştırıp ' +
        'ADMIN_USERNAME ve ADMIN_PASSWORD_HASH değerlerini .env dosyasına ekleyin.',
      { status: 503, code: 'AUTH_NOT_CONFIGURED' },
    );
  }

  return userMatches && passwordMatches ? { username: env.ADMIN_USERNAME } : null;
}

/** Oturum jetonu uretir. */
export function issueToken(user) {
  const expiresIn = env.JWT_EXPIRES_IN;
  const token = jwt.sign(
    { sub: user.username, role: 'admin' },
    jwtSecret,
    { expiresIn, issuer: env.JWT_ISSUER, algorithm: 'HS256' },
  );
  const { exp } = jwt.decode(token);
  return { token, expiresAt: exp * 1000 };
}

/**
 * Jetonu dogrular.
 * @returns {{ username: string, role: string }}
 * @throws {AppError} gecersiz/suresi dolmus jetonda 401
 */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, jwtSecret, {
      issuer: env.JWT_ISSUER,
      algorithms: ['HS256'], // "alg: none" saldirisina karsi algoritma sabitlenir
    });
    // Jeton, .env'deki kullanici adi degistikten sonra gecersiz sayilmali
    if (!isAuthConfigured() || payload.sub !== env.ADMIN_USERNAME) {
      throw new AppError('Oturum artık geçerli değil. Lütfen tekrar giriş yapın.', {
        status: 401,
        code: 'AUTH_TOKEN_STALE',
      });
    }
    return { username: payload.sub, role: payload.role ?? 'admin' };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const expired = error?.name === 'TokenExpiredError';
    throw new AppError(
      expired ? 'Oturum süresi doldu. Lütfen tekrar giriş yapın.' : 'Oturum doğrulanamadı.',
      { status: 401, code: expired ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID' },
    );
  }
}

/** CLI yardimcisi: parola -> bcrypt ozeti (npm run auth:hash) */
export async function hashPassword(plain) {
  const password = String(plain ?? '');
  const problems = [];
  if (password.length < 12) problems.push('en az 12 karakter');
  if (!/[a-z]/.test(password)) problems.push('en az bir küçük harf');
  if (!/[A-Z]/.test(password)) problems.push('en az bir büyük harf');
  if (!/\d/.test(password)) problems.push('en az bir rakam');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('en az bir özel karakter');
  if (problems.length > 0) {
    throw new AppError(`Parola yeterince güçlü değil. Gerekli: ${problems.join(', ')}.`, {
      status: 400,
      code: 'WEAK_PASSWORD',
    });
  }
  // cost=12: modern donanimda ~250ms; kaba kuvvete karsi bilincli olarak yavas.
  return bcrypt.hash(password, 12);
}

export const authInfo = () => ({ configured: isAuthConfigured(), enforced: true, production: isProd });
