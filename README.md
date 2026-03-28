# TR fiyat karşılaştırma (yerel)

Arama kutusuna yazdığınız sorgu için **Trendyol**, **Hepsiburada**, **Amazon TR** ve **N11** üzerinde sunucu tarafında paralel arama yapar; sonuçları fiyata göre sıralar ve **en düşük fiyatlı** satırı vurgular. Veritabanı yok; sonuçlar yalnızca o anki istek için bellekte tutulur.

## Gereksinimler

- [Node.js](https://nodejs.org/) 18+ (npm ile birlikte)

## Kurulum

Proje kökünde:

```bash
npm install
```

## Çalıştırma

İki süreç birden (API + Vite ön yüz, `/api` proxy):

```bash
npm run dev
```

- Arayüz: http://localhost:5173  
- API: http://localhost:3001 (isteğe bağlı ortam değişkeni: `PORT`)

API doğrudan: `GET http://localhost:3001/api/search?q=kulaklik`

`concurrently` veya workspace kullanmak istemezseniz iki ayrı terminalde:

```bash
npm run dev:server
npm run dev:client
```

## Test

```bash
npm run test --workspace=tr-price-compare-server
```

## Notlar

- Mağaza siteleri yapı veya koruma değişikliklerinde adapter’ların güncellenmesi gerekebilir.
- Kişisel kullanım için düşünülmüştür; çok sık istek atmayın. Sunucuda dakikada ~40 istek sınırı vardır (`express-rate-limit`).
