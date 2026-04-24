# Site bazlı sıralama ve fiyat aralığı URL parametreleri

Bu dosya 15 mağaza için:

- **Sort token’ı**: `price-asc` (artan fiyat), `price-desc` (azalan fiyat), `relevance` (önerilen / varsayılan)
- **Fiyat aralığı parametresi**: `priceMin`, `priceMax` ya da birleşik tek parametre

değerlerini toplamak içindir. Aşağıdaki her tablo satırını doldurup PR’ye dahil ederseniz, adapter’lar bu tokenleri URL’lere enjekte edecek şekilde güncellenecektir.

## Yer tutucular

- `{Q}` → `encodeURIComponent(query)`
- `{N}` → sayfa numarası (1’den başlar; 1 için bazı sitelerde parametre eklenmez)
- `{KEYWORD}` → Vatan için slug (ör. `rtx-5080`)
- `{MIN}` / `{MAX}` → Türk Lirası tam sayı fiyat (örn. `1500`)
- `{MIN_KURUS}` / `{MAX_KURUS}` → Kuruş cinsinden (örn. Amazon `rh=p_36` 100 ile çarpar: 1500 TL = `150000`)

## Sıralama modları

| id | anlam |
|---|---|
| `price-asc` | Fiyat: düşükten yükseğe |
| `price-desc` | Fiyat: yüksekten düşüğe |
| `relevance` | Önerilen / varsayılan sıra |

Bir site `relevance` için URL’ye hiçbir şey eklemeyi gerektirmiyorsa hücreye `omit` yazın; ben de URL’den sort parametresini atarım.

## Fiyat aralığı formatı

Her site için aşağıdaki üç seçenekten birini kullanın:

1. **Ayrık** → `priceMinParam` ve `priceMaxParam` kolonlarını ayrı ayrı doldurun  
   Örn.: `minPrice={MIN}` ve `maxPrice={MAX}`
2. **Birleşik** → yalnızca `priceRangeCombinedParam`’ı doldurun  
   Örn.: `prc={MIN}-{MAX}` veya `fiyat={MIN},{MAX}`
3. **Desteklemiyor** → üçünü de boş bırakın (post-filter zaten devreye girecek)

Yalnızca `min` ya da yalnızca `max` verildiğinde davranış (boş bırak / 0–MAX / MIN–∞) **notes** kolonuna yazılabilir; aksi halde varsayılan: boşu `""` (parametreyi olduğu gibi sitede bırakırız).

---

## Doldurulacak tablo

| site | price-asc (mevcut) | price-desc | relevance | priceMinParam | priceMaxParam | priceRangeCombinedParam | notes |
|---|---|---|---|---|---|---|---|
| Trendyol | `sst=PRICE_BY_ASC` |  |  |  |  |  |  |
| Hepsiburada | `siralama=artanfiyat` |  |  |  |  |  |  |
| Amazon TR | `s=price-asc-rank` |  |  |  |  |  | `rh=p_36%3A{MIN_KURUS}-{MAX_KURUS}` ile birleşik fiyat filtresi alışılmıştır |
| N11 | `srt=PRICE_LOW` |  |  |  |  |  |  |
| Pazarama | `siralama=artan-fiyat` |  |  |  |  |  |  |
| İdefix | `siralama=asc_price` |  |  |  |  |  |  |
| Vatan | `srt=UP` |  |  |  |  |  | Path tabanlı arama; sort/price query parametreleri mümkün |
| PTT Avm | `order=price_asc` |  |  |  |  |  |  |
| MediaMarkt | `sort=currentprice+asc` |  |  |  |  |  |  |
| Çiçeksepeti | `choice=1&orderby=3` |  |  |  |  |  | `orderby` bayraklarını (2=yüksek fiyat?) gözlemleyerek doldurabilirsiniz |
| Teknosa | `sort=price-asc` |  |  |  |  |  |  |
| Koçtaş | `sort=price-asc` |  |  |  |  |  |  |
| Cimri | `sort=price,asc` |  |  |  |  |  |  |
| Akakçe | *(yok — varsayılan)* |  |  |  |  |  | URL’de sort parametresi gözlemlenmedi |
| Google Alışveriş | *(yok — varsayılan)* |  |  |  |  |  | `tbs=` birleşik parametresi kullanılır (ör. `tbs=mr:1,price:1,ppr_min:{MIN},ppr_max:{MAX}`) |

---

## Örnek doldurma (referans — gerçek değilse değiştirin)

| site | price-asc | price-desc | relevance | priceMinParam | priceMaxParam | priceRangeCombinedParam |
|---|---|---|---|---|---|---|
| Trendyol | `sst=PRICE_BY_ASC` | `sst=PRICE_BY_DESC` | `omit` |  |  | `prc={MIN}-{MAX}` |
| Hepsiburada | `siralama=artanfiyat` | `siralama=azalanfiyat` | `siralama=onerilen` |  |  | `fiyat={MIN}-{MAX}` |
| Amazon TR | `s=price-asc-rank` | `s=price-desc-rank` | `s=relevanceblender` |  |  | `rh=p_36%3A{MIN_KURUS}-{MAX_KURUS}` |
