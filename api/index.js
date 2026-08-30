import app from '../server/src/app.js';

/**
 * VERCEL SUNUCUSUZ (SERVERLESS) GIRIS NOKTASI
 * =============================================================================
 * Vercel yalnizca PROJE KOKUNDEKI `/api` klasorunu sunucusuz fonksiyona cevirir.
 * `/server/...` altindaki bir dosya, rewrite ile hedeflense bile fonksiyon
 * olarak DERLENMEZ; istek statik dosya araninca Vercel'in 404 sayfasi doner.
 *
 * Yonlendirme `vercel.json` icinde ACIKCA tanimlanmistir:
 *   /api/:path*  ->  /api/index.js
 * Boylece otomatik alglamaya ya da regex desteklerine bagimli kalmiyoruz.
 *
 * NOT: `module.exports = app` KULLANILAMAZ - bu dosyalar ES modulu olarak
 * yorumlanir ve `module` tanimli degildir (ReferenceError).
 */

/**
 * Express uygulamasindaki rotalar `/api` altina mount edilmistir
 * (or. app.use('/api', productsRouter)).
 *
 * Vercel bazi yonlendirme bicimlerinde istegi fonksiyona `/api` onekiyle,
 * bazilarinda ONEKI KIRPARAK iletir. Iki durumda da calismasi icin `req.url`i
 * burada normallestiriyoruz; boylece Express her zaman `/api/...` gorur.
 */
export default function handler(req, res) {
  const url = req.url ?? '/';
  if (!url.startsWith('/api')) {
    req.url = `/api${url.startsWith('/') ? '' : '/'}${url}`;
  }
  return app(req, res);
}
