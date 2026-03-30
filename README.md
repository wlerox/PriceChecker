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

## Firebase Hosting + Cloud Run (yayın, tek origin — önerilen)

Ön yüz **Firebase Hosting** (`client/dist`). API **Google Cloud Run**’da aynı GCP projesinde; [`firebase.json`](firebase.json) içinde `/api/**` istekleri Cloud Run hizmetine yönlendirilir. İstemci `fetch('/api/...')` kullanır; üretim build’inde **`VITE_API_BASE` tanımlama** (göreli yol kalsın).

**Önkoşullar**

- Firebase **Blaze** (ücretli kota) ve faturalandırma bağlı GCP projesi.
- Cloud Run’da servis: örnek ad `tr-price-api`, bölge `europe-west1` — [`firebase.json`](firebase.json) içindeki `run.serviceId` / `run.region` ile aynı olmalı.
- [Firebase CLI](https://firebase.google.com/docs/cli): `npm i -g firebase-tools`

**1) API (Docker Hub veya Artifact Registry imajı)**

```bash
gcloud run deploy tr-price-api --image docker.io/KULLANICI/tr-price-api:latest --region europe-west1 --allow-unauthenticated --port 8080
```

`GET https://...run.app/api/health` → `{"ok":true}`.

**2) İstemci üretimi** (`VITE_API_BASE` yok — önemli)

```bash
npm install
npm run build -w tr-price-compare-client
```

**3) Hosting**

```bash
firebase login
firebase deploy --only hosting
```

Site: `https://<proje-id>.web.app` — `/api/health` aynı kökten çalışır (rewrite).

---

## Alternatif: Harici API (Railway vb., Cloud Run yok)

API Railway / Render vb. ise Hosting’de `/api` rewrite kullanma; [`firebase.json`](firebase.json) içinden Cloud Run `run` bloğunu kaldırıp yalnızca SPA rewrite bırak veya ayrı dal kullan. Üretim build:

```bash
$env:VITE_API_BASE="https://SENIN-API-URL"; npm run build -w tr-price-compare-client
```

Sunucu `*.web.app` için **CORS** açık; özel domain için `CORS_ORIGINS`. Örnek: [client/.env.example](client/.env.example).

## Notlar

- Mağaza siteleri yapı veya koruma değişikliklerinde adapter’ların güncellenmesi gerekebilir.
- Kişisel kullanım için düşünülmüştür; çok sık istek atmayın. Sunucuda dakikada ~40 istek sınırı vardır (`express-rate-limit`).
