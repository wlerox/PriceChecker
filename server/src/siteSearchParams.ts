import type { SortMode } from "./sortMode.ts";
import type { PriceRange } from "./priceRange.ts";

/**
 * Mağaza bazlı arama URL'si inşa etmek için merkezi yapılandırma tablosu.
 *
 * Kullanıcı tarafından `docs/site-sort-price-params.md` / `.csv` şablonunda sağlanan
 * değerler burada tek bir yerde kodlanır. Adapter'lar yalnızca {@link buildStoreSearchUrl}
 * fonksiyonunu çağırır; URL detayları, sort tokenleri ve fiyat aralığı parametreleri
 * sitenin gerçek arama formatına eşlenir.
 *
 * Yer tutucu semantiği (URL template'lerinde):
 *   {Q}        -> encodeURIComponent(query)
 *   {KEYWORD}  -> Vatan için slug (ör. "rtx 5080" -> "rtx-5080")
 *   {N}        -> sayfa numarası
 *
 * Fiyat aralığı şablonlarında (ör. `prc={MIN}-{MAX}`):
 *   {MIN}       -> alt sınır (ya da `fallbackMin` / öntanımlı "min" / "*" / "0")
 *   {MAX}       -> üst sınır (ya da `fallbackMax` / öntanımlı "max" / "*")
 *   {MIN_KURUS} / {MAX_KURUS} -> TL değerini kuruşa çevirir (×100, Amazon `rh=p_36` için)
 */

export type SortTokenMap = {
  /** Artan fiyat: URL'ye eklenecek "name=value" parçası. Boş string = hiç eklenmez. */
  "price-asc": string;
  /** Azalan fiyat. Boş string = hiç eklenmez. */
  "price-desc": string;
  /** Önerilen / sitenin varsayılan sırası. Boş = parametre hiç eklenmez. */
  relevance: string;
};

export type PriceRangeTemplates = {
  /** Yalnızca min sınır verildiğinde (ör. "prc={MIN}-*") */
  onlyMin?: string;
  /** Yalnızca max sınır verildiğinde (ör. "prc=0-{MAX}") */
  onlyMax?: string;
  /** Her iki sınır verildiğinde (ör. "prc={MIN}-{MAX}") */
  both?: string;
  /**
   * Açık uçlarda kullanılacak varsayılan sayısal değerler. Bazı siteler
   * (ör. MediaMarkt) "min" / "*" gibi kelime kabul etmez; böyle yerlerde
   * fallback sayıyla boş uç doldurulur.
   */
  fallbackMin?: number;
  fallbackMax?: number;
};

export type SiteSearchConfig = {
  /** Ör. "https://www.trendyol.com" (sonunda slash yok) */
  base: string;
  /**
   * Tek-sayfa arama path template'i (ör. `/sr?q={Q}`). Başta `/` olmalı.
   * Sayfa 1 için kullanılır; sonraki sayfalarda pageParamTemplate eklenir.
   */
  searchPathTemplate: string;
  /**
   * Sayfa parametresi (ör. `pi={N}` veya `sayfa={N}`). Yoksa (tek sayfalı)
   * boş bırakılır. Sayfa 1 için eklenmez.
   */
  pageParamTemplate?: string;
  sort: SortTokenMap;
  priceRange?: PriceRangeTemplates;
  /**
   * URL param'ları `?` veya `&` ile ekleyen helper: searchPathTemplate kendisi `?`
   * içeriyorsa `&`, içermiyorsa `?`. Adapter bunu yöneteceği için burada config yok.
   */
};

/** URL template'inden {Q} ve {N} yer tutucularını doldurur. */
function renderPath(template: string, query: string, page: number): string {
  const q = encodeURIComponent(query.trim().toLocaleLowerCase("tr"));
  return template.replace(/\{Q\}/g, q).replace(/\{N\}/g, String(page));
}

/**
 * Çoğu sitenin kullandığı "q tabanlı path + sort + sayfa + price" URL'sini üretir.
 * Vatan/Teknosa/Koçtaş gibi path-gömülü siteler için özel fonksiyonlar var.
 */
function appendParam(url: string, param: string): string {
  if (!param) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${param}`;
}

function renderPriceRangeParam(
  templates: PriceRangeTemplates | undefined,
  range: PriceRange | undefined,
): string {
  if (!templates || !range) return "";
  const hasMin = range.min != null && Number.isFinite(range.min);
  const hasMax = range.max != null && Number.isFinite(range.max);
  if (!hasMin && !hasMax) return "";

  let template: string | undefined;
  if (hasMin && hasMax) template = templates.both ?? templates.onlyMin ?? templates.onlyMax;
  else if (hasMin) template = templates.onlyMin ?? templates.both;
  else template = templates.onlyMax ?? templates.both;
  if (!template) return "";

  const min = hasMin ? Number(range.min) : (templates.fallbackMin ?? 0);
  const max = hasMax ? Number(range.max) : (templates.fallbackMax ?? 0);
  return template
    .replace(/\{MIN_KURUS\}/g, String(Math.round(min * 100)))
    .replace(/\{MAX_KURUS\}/g, String(Math.round(max * 100)))
    .replace(/\{MIN\}/g, String(min))
    .replace(/\{MAX\}/g, String(max));
}

export function buildStoreSearchUrl(
  cfg: SiteSearchConfig,
  opts: {
    query: string;
    page?: number;
    sort?: SortMode;
    priceRange?: PriceRange;
  },
): string {
  const page = Math.max(1, opts.page ?? 1);
  const sort: SortMode = opts.sort ?? "price-asc";
  let url = cfg.base + renderPath(cfg.searchPathTemplate, opts.query, page);

  if (page > 1 && cfg.pageParamTemplate) {
    url = appendParam(url, cfg.pageParamTemplate.replace(/\{N\}/g, String(page)));
  }

  const sortParam = cfg.sort[sort] ?? "";
  if (sortParam) url = appendParam(url, sortParam);

  const priceParam = renderPriceRangeParam(cfg.priceRange, opts.priceRange);
  if (priceParam) url = appendParam(url, priceParam);

  return url;
}

/** 16 mağaza için merkezi parametre tablosu. */
export const SITE_SEARCH_PARAMS = {
  Trendyol: {
    base: "https://www.trendyol.com",
    searchPathTemplate: "/sr?q={Q}",
    pageParamTemplate: "pi={N}",
    sort: {
      "price-asc": "sst=PRICE_BY_ASC",
      "price-desc": "sst=PRICE_BY_DESC",
      relevance: "",
    },
    priceRange: {
      onlyMin: "prc={MIN}-*",
      onlyMax: "prc=0-{MAX}",
      both: "prc={MIN}-{MAX}",
    },
  },
  Hepsiburada: {
    base: "https://www.hepsiburada.com",
    searchPathTemplate: "/ara?q={Q}",
    pageParamTemplate: "sayfa={N}",
    sort: {
      "price-asc": "siralama=artanfiyat",
      "price-desc": "siralama=azalanfiyat",
      relevance: "",
    },
    priceRange: {
      onlyMin: "filtreler=fiyat:{MIN}-max",
      onlyMax: "filtreler=fiyat:min-{MAX}",
      both: "filtreler=fiyat:{MIN}-{MAX}",
    },
  },
  "Amazon TR": {
    base: "https://www.amazon.com.tr",
    searchPathTemplate: "/s?k={Q}",
    pageParamTemplate: "page={N}&ref=sr_pg_{N}",
    sort: {
      "price-asc": "s=price-asc-rank",
      "price-desc": "s=price-desc-rank",
      relevance: "",
    },
    priceRange: {
      onlyMin: "low-price={MIN}",
      onlyMax: "high-price={MAX}",
      both: "low-price={MIN}&high-price={MAX}",
    },
  },
  N11: {
    base: "https://www.n11.com",
    searchPathTemplate: "/arama?q={Q}",
    pageParamTemplate: "pg={N}",
    sort: {
      "price-asc": "srt=PRICE_LOW",
      "price-desc": "srt=PRICE_HIGH",
      relevance: "",
    },
    priceRange: {
      onlyMin: "minp={MIN}",
      onlyMax: "maxp={MAX}",
      both: "minp={MIN}&maxp={MAX}",
    },
  },
  Pazarama: {
    base: "https://www.pazarama.com",
    searchPathTemplate: "/arama?q={Q}",
    pageParamTemplate: "sayfa={N}",
    sort: {
      "price-asc": "siralama=artan-fiyat",
      "price-desc": "siralama=azalan-fiyat",
      relevance: "",
    },
    priceRange: {
      onlyMin: "fiyat={MIN}-max",
      onlyMax: "fiyat=min-{MAX}",
      both: "fiyat={MIN}-{MAX}",
    },
  },
  "İdefix": {
    base: "https://www.idefix.com",
    searchPathTemplate: "/arama?q={Q}",
    pageParamTemplate: "sayfa={N}",
    sort: {
      "price-asc": "siralama=asc_price",
      "price-desc": "siralama=desc_price",
      relevance: "",
    },
    priceRange: {
      onlyMin: "fiyat={MIN}-",
      onlyMax: "fiyat=-{MAX}",
      both: "fiyat={MIN}-{MAX}",
    },
  },
  // Vatan: path tabanlı (keyword URL içinde). URL'yi adapter özel builder ile üretir.
  Vatan: {
    base: "https://www.vatanbilgisayar.com",
    searchPathTemplate: "/arama/{KEYWORD}/",
    pageParamTemplate: "PageNo={N}",
    sort: {
      "price-asc": "srt=UP",
      "price-desc": "srt=PU",
      relevance: "",
    },
    priceRange: {
      onlyMin: "min={MIN}&max=",
      onlyMax: "min=&max={MAX}",
      both: "min={MIN}&max={MAX}",
    },
  },
  "PTT Avm": {
    base: "https://www.pttavm.com",
    searchPathTemplate: "/arama?q={Q}",
    pageParamTemplate: "page={N}",
    sort: {
      "price-asc": "order=price_asc",
      "price-desc": "order=price_desc",
      relevance: "",
    },
    priceRange: {
      onlyMin: "min_price={MIN}",
      onlyMax: "max_price={MAX}",
      both: "min_price={MIN}&max_price={MAX}",
    },
  },
  MediaMarkt: {
    base: "https://www.mediamarkt.com.tr",
    searchPathTemplate: "/tr/search.html?query={Q}",
    pageParamTemplate: "page={N}",
    sort: {
      "price-asc": "sort=currentprice+asc",
      "price-desc": "sort=currentprice+desc",
      relevance: "",
    },
    // MediaMarkt her iki ucu ister; tek uç verildiğinde fallback ile tamamlıyoruz.
    priceRange: {
      onlyMin: "currentprice={MIN}.0-{MAX}.0",
      onlyMax: "currentprice={MIN}.0-{MAX}.0",
      both: "currentprice={MIN}.0-{MAX}.0",
      fallbackMin: 1,
      fallbackMax: 100000,
    },
  },
  "Çiçeksepeti": {
    base: "https://www.ciceksepeti.com",
    searchPathTemplate: "/arama?qt={Q}&query={Q}",
    pageParamTemplate: "sayfa={N}",
    sort: {
      // Çiçeksepeti'de sort filtresi site arayüzünde "choice=1" bayrağı ile birlikte
      // URL'e eklenir; `orderby` tek başına çoğu listeleme yolunda yok sayılıyor ve
      // sayfa içi arama sonuç düzenini bozuyor (boş HTML). O yüzden choice=1'i
      // sort tokenine gömüyoruz.
      "price-asc": "choice=1&orderby=3",
      "price-desc": "choice=1&orderby=2",
      relevance: "",
    },
    priceRange: {
      onlyMin: "prc={MIN}-*",
      onlyMax: "prc=0-{MAX}",
      both: "prc={MIN}-{MAX}",
    },
  },
  Teknosa: {
    base: "https://www.teknosa.com",
    searchPathTemplate: "/arama?s={Q}",
    pageParamTemplate: "page={N}",
    sort: {
      "price-asc": "sort=price-asc",
      "price-desc": "sort=price-desc",
      relevance: "",
    },
    priceRange: {
      // Teknosa URL-encoded ":" (%3A) ile anahtar/değer ayırıyor; `min`/`max` literal
      onlyMin: "priceValue%3A{MIN}-max",
      onlyMax: "priceValue%3Amin-{MAX}",
      both: "priceValue%3A{MIN}-{MAX}",
    },
  },
  // Koçtaş: tüm parametreler `q` / `sp` değerine ":foo" parçası olarak eklenir.
  // Adapter özel builder kullanır.
  "Koçtaş": {
    base: "https://www.koctas.com.tr",
    searchPathTemplate: "/search?q={Q}&sp={Q}",
    pageParamTemplate: "page={N}",
    sort: {
      "price-asc": ":price-asc",
      "price-desc": ":price-desc",
      relevance: "",
    },
    priceRange: {
      onlyMin: ":priceValue:{MIN}-max",
      onlyMax: ":priceValue:min-{MAX}",
      both: ":priceValue:{MIN}-{MAX}",
    },
  },
  Cimri: {
    base: "https://www.cimri.com",
    searchPathTemplate: "/arama?q={Q}",
    pageParamTemplate: "page={N}",
    sort: {
      "price-asc": "sort=price%2Casc",
      "price-desc": "sort=price%2Cdesc",
      relevance: "",
    },
    priceRange: {
      onlyMin: "minPrice={MIN}",
      onlyMax: "maxPrice={MAX}",
      both: "minPrice={MIN}&maxPrice={MAX}",
    },
  },
  "Akakçe": {
    base: "https://www.akakce.com",
    searchPathTemplate: "/arama/?q={Q}",
    pageParamTemplate: "p={N}",
    sort: {
      "price-asc": "s=2",
      "price-desc": "s=4",
      relevance: "",
    },
    priceRange: {
      onlyMin: "p1={MIN}",
      onlyMax: "p2={MAX}",
      both: "p1={MIN}&p2={MAX}",
    },
  },
  // Epey: Arama URL'i `/arama/e/{BASE64(PHP_SERIALIZED)}/{N}/?sirala=...` biçimindedir.
  // `buildStoreSearchUrl` bu özel şemayı üretemediği için adapter kendi URL
  // kurucusunu kullanır (bkz. `adapters/epey.ts`). Bu tablo yalnızca sort
  // tokenlerini paylaşmak için tutuluyor. Fiyat aralığı site filtresinde ayrı
  // bir PHP serialized segment gerektirdiği için sunucu tarafında uygulanır.
  Epey: {
    base: "https://www.epey.com",
    searchPathTemplate: "/arama/e/{Q}/",
    pageParamTemplate: "{N}/",
    sort: {
      "price-asc": "sirala=fiyat:ASC",
      "price-desc": "sirala=fiyat:DESC",
      relevance: "",
    },
  },
  "Google Alışveriş": {
    base: "https://www.google.com.tr",
    searchPathTemplate: "/search?q={Q}&udm=28&hl=tr&gl=tr",
    sort: {
      "price-asc": "",
      "price-desc": "",
      relevance: "",
    },
    // TODO: tbs=mr:1,price:1,ppr_min:{MIN},ppr_max:{MAX} gibi birleşik parametre
    // için adapter içinde özel üretim gerekir (SITE_SEARCH_PARAMS yalnızca referans).
  },
} as const satisfies Record<string, SiteSearchConfig>;

export type StoreName = keyof typeof SITE_SEARCH_PARAMS;
