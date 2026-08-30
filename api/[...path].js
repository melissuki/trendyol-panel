/**
 * VERCEL SUNUCUSUZ (SERVERLESS) GIRIS NOKTASI
 * =============================================================================
 * Vercel yalnizca PROJE KOKUNDEKI `/api` klasorunu otomatik olarak sunucusuz
 * fonksiyona cevirir. `/server/...` altindaki bir dosya, `rewrites` ile
 * hedeflense bile fonksiyon olarak DERLENMEZ - istek statik dosya araninca
 * 404 doner. Yasadiginiz sorunun asil sebebi budur.
 *
 * Dosya adindaki `[...path]` bir "catch-all" (hepsini yakala) yonlendiricidir:
 *   /api/products, /api/auth/login, /api/reports/product.xlsx ...
 * hepsi bu tek fonksiyona duser. Vercel istegin ORIJINAL yolunu (`/api/...`)
 * oldugu gibi aktardigi icin Express'teki `app.use('/api', ...)` mount'lari
 * hicbir degisiklik gerektirmez.
 *
 * NOT: `module.exports = app` KULLANILAMAZ - server/package.json `"type":
 * "module"` oldugu icin bu dosyalar ES modulu olarak yorumlanir ve `module`
 * tanimli degildir (ReferenceError). Dogru bicim `export default`tir.
 */
export { default } from '../server/src/app.js';

/**
 * Trendyol'dan sayfali veri cekmek uzun surebiliyor (genis tarih araliklarinda
 * onlarca istek). Vercel'de varsayilan sure sinirini yukseltiyoruz.
 *
 * DIKKAT: ust sinir plana baglidir - Hobby 60sn, Pro 300sn. Excel raporu gibi
 * uzun islerde bu sinir yetmezse rapor ucu 504 dondurur; bkz. README'deki
 * "Vercel kisitlari" notu.
 */
export const config = {
  maxDuration: 60,
};
