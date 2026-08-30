# Trendyol Satış Analiz Paneli

Trendyol mağazanız için **ürün bazlı, gün gün** satış / iptal-iade / net ciro raporlaması.
Bir ürüne tıklayınca o ürünün seçili tarih aralığındaki tüm hareketleri günlere göre
gruplanmış, biçimlendirilmiş bir Excel dosyası olarak inilir.

```
trendyolapi/
├── server/                 # Node.js + Express API (Trendyol ile TEK konuşan taraf)
│   ├── src/
│   │   ├── index.js                    # Express uygulaması, sıkı CORS, rate limit
│   │   ├── config/env.js               # .env doğrulama (zod) — eksik anahtarda açılışta durur
│   │   ├── lib/                        # tarih, para, cache, log, hata yardımcıları
│   │   ├── services/
│   │   │   ├── trendyolClient.js       # Basic auth, retry/backoff, sayfalama
│   │   │   ├── ordersService.js        # Siparişler API + ürün kataloğu
│   │   │   ├── claimsService.js        # İade/İptal API + NEDEN çıkarımı
│   │   │   ├── financeService.js       # Mutabakat API (gerçek komisyon) / tahmin
│   │   │   ├── aggregationService.js   # Sipariş + iade birleştirme, gün gün gruplama
│   │   │   └── excelService.js         # exceljs ile 4 sayfalı rapor
│   │   ├── routes/                     # /api/products, /api/reports, /api/health
│   │   └── middleware/                 # doğrulama + merkezi hata yönetimi
│   └── .env.example
└── client/                 # React (Vite) + Tailwind — Trendyol'a ASLA doğrudan gitmez
    └── src/
        ├── App.jsx
        ├── api/client.js               # backend istemcisi + Excel indirme
        ├── components/                 # DateRangePicker, ProductList, ProductCard, Modal…
        └── hooks/                      # useProducts, useReportDownload
```

---

## 1. Kurulum

```bash
npm run install:all
```

> Alternatif: `npm --prefix server install && npm --prefix client install`

### Ortam değişkenleri (backend)

`server/.env.example` dosyasını `server/.env` olarak kopyalayın ve doldurun:

```bash
cp server/.env.example server/.env
```

| Değişken | Açıklama |
|---|---|
| `TRENDYOL_SELLER_ID` | Satıcı (Cari) ID'niz |
| `TRENDYOL_API_KEY` / `TRENDYOL_API_SECRET` | Trendyol Partner → Hesap Bilgileri → Entegrasyon Bilgileri |
| `TRENDYOL_BASE_URL` | `https://apigw.trendyol.com/integration` (eski: `https://api.trendyol.com/sapigw`) |
| `TRENDYOL_INTEGRATION_TAG` | User-Agent eki. Kendi entegrasyonunuz için `SelfIntegration` |
| `CORS_ORIGINS` | İzin verilen frontend adresleri, virgülle ayrılmış. **Üretimde sadece kendi domaininiz** |
| `USE_FINANCE_API` | `true` → komisyonlar Mutabakat API'sinden **gerçek** tutarla çekilir |
| `DEFAULT_COMMISSION_RATE` | Finans API kapalıyken kullanılacak oran (`0.185` = %18,5) |
| `SHIPPING_COST_PER_ORDER` | Satış başına sabit kargo/hizmet kesintisi (TL) |
| `RETURN_SHIPPING_COST` | İade başına üstlenilen kargo bedeli (TL) |
| `COMMISSION_REFUNDED_ON_RETURN` | İadede komisyon geri alınıyorsa `true` |
| `MAX_RANGE_DAYS` | Tek seferde sorgulanabilecek en uzun aralık (varsayılan 180 gün) |

### Ortam değişkenleri (frontend)

```bash
cp client/.env.example client/.env
```

```env
VITE_API_BASE_URL=http://localhost:4000
```

> **Güvenlik:** API Key/Secret **yalnızca** `server/.env` içinde durur ve sadece
> `trendyolClient.js` tarafından kullanılır. Frontend'e dönen hiçbir yanıtta yer almaz.
> `.env` dosyaları `.gitignore` içindedir.

---

## 2. Çalıştırma

```bash
npm run dev
```

- API → http://localhost:4000
- Arayüz → http://localhost:5173

Kimlik bilgilerinizi doğrulamak için:

```bash
curl http://localhost:4000/api/health/trendyol
```

---

## 3. API uç noktaları

| Uç nokta | Açıklama |
|---|---|
| `GET /api/products?startDate=&endDate=` | Aralıkta satılan tüm farklı ürünler + özet |
| `GET /api/products/daily?barcode=&startDate=&endDate=` | Bir ürünün gün gün detayı (JSON önizleme) |
| `GET /api/reports/product.xlsx?barcode=&startDate=&endDate=` | **Excel raporu** (indirme) |
| `GET /api/health` · `GET /api/health/trendyol` | Sağlık kontrolü |
| `POST /api/cache/clear` | Önbelleği temizler |

Tarihler `YYYY-MM-DD` biçimindedir ve **Europe/Istanbul** takvim gününe göre yorumlanır.

---

## 4. Veri birleştirme mantığı

1. **Siparişler** `GET /order/sellers/{sellerId}/orders` ile çekilir.
   Trendyol bu uçta **en fazla 2 haftalık** aralığa izin verdiği için uzun aralıklar
   otomatik olarak 14 günlük parçalara bölünüp birleştirilir (`chunkRange`).
2. **İade/İptal talepleri** `GET /order/sellers/{sellerId}/claims` ile çekilir.
   Bir iade, siparişten **günler sonra** açılabildiği için claims sorgusu aralığın
   30 gün öncesinden 15 gün sonrasına kadar genişletilir.
3. **Eşleştirme** şu öncelikle yapılır: `orderLineId` → `siparişNo + barkod` → `siparişNo`.
4. **Neden çıkarımı** (`H` sütunu):
   `claimItems[].customerClaimItemReason.name` → `trendyolClaimItemReason.name` →
   müşteri notu → sipariş paketindeki iptal gerekçesi → "Belirtilmemiş".
5. **Kısmi iadeler bölünür:** 3 adetlik bir satırın 1 adedi iade edildiyse satır,
   sipariş gününe 2 adet **Satış** + talep gününe 1 adet **İade** olarak iki kayda ayrılır.
6. **Gün ataması:** satışlar sipariş gününe, iadeler **talep (claim) gününe** yazılır —
   para o gün çıktığı için net ciro böyle doğru olur.

### Net ciro kuralları

| Durum | Brüt | Kesinti | Net |
|---|---|---|---|
| **Satış** | satır tutarı | komisyon + kargo/hizmet | brüt − kesinti |
| **İptal** | bilgi amaçlı gösterilir | 0 | **0** (kargoya verilmediği için ciro oluşmaz) |
| **İade** | bilgi amaçlı gösterilir | iade kargo (+ iade edilmeyen komisyon) | **negatif** |

---

## 5. Excel dosyası

| Sayfa | İçerik |
|---|---|
| **Günlük Özet** | Ürün künyesi, KPI kutusu, gün gün satış/iptal/iade/net ciro tablosu |
| **Günlük Detay** | İstenen **A–H** yapısı, güne göre bantlanmış, gün ara toplamlı |
| **İptal & İade Nedenleri** | Neden bazında adet, tutar ve yüzde dağılımı |
| **Ham Veri** | 27 sütunlu, filtrelenebilir tam döküm (denetim için) |

**Günlük Detay** sayfası — gün gün, sipariş sipariş:

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| Sıra | Gün | Saat | Sipariş Durumu | Sipariş No | Müşteri Adı Soyadı | Adet |

| H | I | J | K | L | M | N |
|---|---|---|---|---|---|---|
| Birim Fiyat | Brüt Tutar | Komisyon | Kargo/Hizmet | Kesintiler | Net Ciro | İptal/İade Nedeni |

Her satır **tek bir sipariş hareketidir**. Bir günün içindeki siparişler şu sırayla listelenir:

1. **İşlem saati** (satışlarda sipariş saati, iadelerde talep saati)
2. Sipariş numarası
3. Durum (Satış → İptal → İade)

Her satır gün içinde **1'den başlayarak numaralanır** (`Sıra` sütunu), böylece mutabakatta
satır saymak kolaylaşır. Gün başlığı bandı o günün `x hareket · y sipariş · z müşteri`
özetini taşır; hemen altındaki satırlardan sonra canlı `SUM()` formüllü **Gün Toplamı** gelir.

Kesintiler kırılarak verilir: **Komisyon + Kargo/Hizmet = Kesintiler** eşitliği her satırda
korunur. İptal edilen siparişte komisyon doğmadığı, iade edilen siparişte
(`COMMISSION_REFUNDED_ON_RETURN=true` iken) komisyon satıcıya geri döndüğü için bu
satırlarda kesilen komisyon `0` yazar — hesaplanan komisyon tutarı **Ham Veri** sayfasında
`Komisyon (Hesaplanan)` sütununda ayrıca durur.

Müşteri adı `customerFirstName` + `customerLastName` alanlarından çekilir; bu alanlar boş
gelirse sırasıyla `shipmentAddress` ve `invoiceAddress` içindeki ad bilgisine düşülür
(`extractCustomer`, [ordersService.js](server/src/services/ordersService.js)).
**Ham Veri** sayfasında ad ve soyad ayrıca iki bağımsız sütun olarak da yer alır (pivot/filtre için).

> **KVKK notu:** Rapor artık müşteri ad-soyad bilgisi içerdiğinden kişisel veri barındırır.
> Dosyayı paylaşırken ve saklarken buna göre davranın.

Biçimlendirme: kalın koyu başlık satırı (dondurulmuş), `#,##0.00 ₺` para formatı,
**iptal satırları kırmızı**, **iade satırları sarı** zeminli, gün başlıkları mavi bantlı,
gün ara toplamları canlı `SUM()` formülü, otomatik sütun genişliği ve otomatik filtre.

---

## 6. Üretim notları

- `NODE_ENV=production` yapın ve `CORS_ORIGINS` içinde **yalnızca** kendi domaininizi bırakın.
- Sunucu bellek içi TTL cache kullanır (`CACHE_TTL_SECONDS`). Birden fazla instance
  çalıştıracaksanız bu katmanı Redis'e taşıyın (`server/src/lib/cache.js`).
- Trendyol 429 döndürdüğünde istemci `Retry-After` başlığına uyarak üstel geri çekilme yapar.
- `USE_FINANCE_API=false` iken komisyonlar **tahminidir**; bu uyarı hem arayüzde hem
  Excel'in altında açıkça yazar.
