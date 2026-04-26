import type { Product } from "../../shared/types.ts";
import { isRelevanceLoggingEnabled } from "./relevanceLoggingContext.ts";

/**
 * Arama sorgusundan anlamlı parçalar (2+ karakter; harf/rakam).
 * Örn. "rtx 5080" → ["rtx","5080"] — başlıkta hepsi geçmeli.
 * Tam sayı tokenlarında: "50" hem "5080" hem "5060" ön eki olarak geçmesin diye,
 * sorguda daha uzun bir rakam tokenı varsa kısa önek atılır.
 */
export function queryTokensForMatch(query: string): string[] {
  const raw = query
    .toLocaleLowerCase("tr")
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .flatMap((w) => {
      // "128gb" -> ["128","gb"], "5060ti" -> ["5060","ti"].
      // Böylece bitişik/ayrık yazımlar aynı şekilde eşleşebilir.
      const parts = w.match(/\p{N}+|\p{L}+/gu) ?? [w];
      return parts.filter((part) => part.length >= 2);
    });
  const uniq = [...new Set(raw)];
  return uniq.filter((t) => {
    if (!/^\d+$/.test(t)) return true;
    for (const o of uniq) {
      if (o === t || !/^\d+$/.test(o)) continue;
      if (o.length > t.length && o.startsWith(t)) return false;
    }
    return true;
  });
}

/** i/ı, ğ/g vb. farklarında eşleşmeyi gevşetir (ASCII klavye ile yazılan sorgu için). */
export function foldForMatch(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/â/g, "a")
    .replace(/î/g, "i")
    .replace(/û/g, "u");
}


function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Token için sınır karakterlerini look-behind/look-ahead ile doğrulayan RegExp üretir.
 * Yan karakterleri tüketmediğinden "128gb" gibi bitişik yazımda sıradaki token
 * ("gb") da aynı harflerin üstünde eşleşebilir.
 */
function buildTokenRegex(tok: string, flags = "u"): RegExp {
  const esc = escapeRegExp(tok);
  if (/\d/.test(tok)) {
    const isAllDigits = /^\d+$/.test(tok);
    // Rakamdan sonra rakam gelmemeli; tümüyle rakam olmayan token için ek olarak alfanümerik de gelmemeli.
    const afterBound = isAllDigits ? `(?=$|[^\\d])` : `(?=$|[^\\p{L}\\p{N}])`;
    // Önce gelen: satır başı, alfanümerik olmayan bir karakter ya da bir harf (RTX5050 gibi bitişik yazım için).
    return new RegExp(`(?<=^|[^\\p{L}\\p{N}]|\\p{L})${esc}${afterBound}`, flags);
  }
  // "ti", "se" gibi kısa tokenlar "karti", "bit" içinde yanlış eşleşmesin → kelime sınırı iste
  if (tok.length <= 2) {
    return new RegExp(`(?<=^|[^\\p{L}])${esc}(?=$|[^\\p{L}])`, flags);
  }
  return new RegExp(esc, flags);
}

function titleMatchesQueryTokensInOrder(foldedTitle: string, foldedTokens: string[]): boolean {
  let from = 0;
  for (const tok of foldedTokens) {
    const re = buildTokenRegex(tok, "gu");
    re.lastIndex = from;
    const found = re.exec(foldedTitle);
    if (!found) return false;
    // Look-behind/look-ahead tüketmediğinden match uzunluğu token ile aynı; sıradaki arama
    // bu noktadan devam ederse "128gb" gibi bitişik örneklerde "gb" de eşleşebilir.
    from = re.lastIndex;
  }
  return true;
}

function titleMatchesQueryTokensExactly(foldedTitle: string, foldedTokens: string[]): boolean {
  if (foldedTokens.length === 0) return true;
  const escaped = foldedTokens.map(escapeRegExp);
  const joined = escaped
    .map((tok, idx) => {
      if (idx === 0) return tok;
      const prev = foldedTokens[idx - 1]!;
      const curr = foldedTokens[idx]!;
      const prevIsDigits = /^\d+$/.test(prev);
      const currIsDigits = /^\d+$/.test(curr);
      const between =
        prevIsDigits !== currIsDigits ? "[^\\p{L}\\p{N}]*" : "[^\\p{L}\\p{N}]+";
      return `${between}${tok}`;
    })
    .join("");
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${joined}(?:$|[^\\p{L}\\p{N}])`, "u");
  return re.test(foldedTitle);
}

/**
 * Ürün başlığında arama terimleri yeterince geçmiyorsa ele (geniş mağaza araması gürültüsünü keser).
 * `onlyNew` true ise başlıkta "yenilenmiş / teşhir / sıfırdan farksız" vb. geçen satırlar da elenir.
 */
export function filterProductsByQuery(
  query: string,
  products: Product[],
  pageMap?: Map<string, number>,
  exactMatch = false,
  onlyNew = false,
): Product[] {
  const tokens = [...new Set(queryTokensForMatch(query))];
  const foldedTokens = tokens.map(foldForMatch);
  const loggingOn = isRelevanceLoggingEnabled();
  return products.filter((p) => {
    const t = foldForMatch(p.title);
    let ok: boolean;
    if (tokens.length === 0) {
      ok = true;
    } else {
      ok = exactMatch
        ? titleMatchesQueryTokensExactly(t, foldedTokens)
        : titleMatchesQueryTokensInOrder(t, foldedTokens);
    }
    if (ok && onlyNew && isNonNewTitle(p.title)) {
      if (loggingOn) {
        const pg = pageMap?.get(p.url);
        const pgTag = pg != null ? ` sayfa=${pg}` : "";
        console.info(
          `[relevance] ✗ sıfır-değil elendi: [${p.store}]${pgTag} ${p.price} TL "${p.title.slice(0, 80)}"`,
        );
      }
      return false;
    }
    if (loggingOn && tokens.length > 0) {
      const pg = pageMap?.get(p.url);
      const pgTag = pg != null ? ` sayfa=${pg}` : "";
      if (ok) {
        console.info(
          `[relevance] ✓ alındı: [${p.store}]${pgTag} ${p.price} TL "${p.title.slice(0, 80)}" | tokens=${foldedTokens.join(",")}`,
        );
      } else {
        console.info(
          `[relevance] ✗ elendi: [${p.store}]${pgTag} ${p.price} TL "${p.title.slice(0, 80)}" | tokens=${foldedTokens.join(",")}`,
        );
      }
    }
    return ok;
  });
}

/** Alt kategori metni (API `type`) — client `apiValue` ile aynı normalizasyon. */
function normalizeSearchTypeLabel(raw: string): string {
  return raw.trim().toLocaleLowerCase("tr");
}

/**
 * Sadece Vatan mağaza aramasında `type` kullanılıyor; diğer siteler düz metin arıyor.
 * Alt kategori (ör. dizüstü) seçildiğinde başlıkta net laptop olmayan aksesuarları ele.
 */
export function filterProductsBySearchType(searchType: string | undefined, products: Product[]): Product[] {
  if (!searchType?.trim()) return products;
  const label = normalizeSearchTypeLabel(searchType);
  if (label === "dizüstü bilgisayar") {
    return products.filter((p) => !isLikelyLaptopAccessoryTitle(p.title));
  }
  return products;
}

/** "Sadece sıfır" filtresi açıkken elenen başlık anahtar ifadeleri (foldForMatch normalize edilmiş). */
const NON_NEW_TITLE_NEEDLES: readonly string[] = [
  "yenilenmiş",
  "yenilenmis",
  "yenilenme",
  "yenilio",
  "refurbished",
  "teşhir",
  "teshir",
  "sıfırdan farksız",
  "sifirdan farksiz",
  "ikinci el",
  "2.el",
  "2 el",
  "kullanılmış",
  "kullanilmis",
  "açık kutu",
  "acik kutu",
  "outlet",
  "iade",
].map(foldForMatch);

/** Başlık "yenilenmiş / teşhir / sıfırdan farksız" vb. ifade içeriyorsa elenir. */
export function isNonNewTitle(title: string): boolean {
  const folded = foldForMatch(title);
  for (const needle of NON_NEW_TITLE_NEEDLES) {
    if (folded.includes(needle)) return true;
  }
  return false;
}

export function filterOutNonNewProducts(products: Product[]): Product[] {
  return products.filter((p) => {
    const drop = isNonNewTitle(p.title);
    if (drop && isRelevanceLoggingEnabled()) {
      console.info(
        `[relevance] ✗ sıfır-değil elendi: [${p.store}] "${p.title.slice(0, 80)}"`,
      );
    }
    return !drop;
  });
}

/**
 * Önce sorgu terimleri, sonra isteğe bağlı alt kategori süzgeci.
 * Sorgu hiçbir satırla eşleşmezse boş döner (alakasız ürün göstermez).
 * Kategori süzgeci tek başına her şeyi silerse yalnızca sorguyla eşleşenler kalır.
 * `onlyNew` açıksa "yenilenmiş / teşhir / sıfırdan farksız" vb. içeren başlıklar elenir.
 */
export function applyRelevanceFilters(
  query: string,
  searchType: string | undefined,
  products: Product[],
  exactMatch = false,
  onlyNew = false,
): Product[] {
  if (products.length === 0) return [];
  let relevant = filterProductsByQuery(query, products, undefined, exactMatch, onlyNew);
  relevant = filterProductsBySearchType(searchType, relevant);
  return relevant;
}

/** Şarj, adaptör, kablo vb. — başlıkta "laptop" geçse bile genelde aksesuar. */
function hasLaptopPowerOrCableAccessoryPhrase(folded: string): boolean {
  const needles = [
    "adaptör",
    "adaptor",
    "adapter",
    "şarj aleti",
    "şarj cihazı",
    "sarj aleti",
    "sarj cihazi",
    "laptop adaptör",
    "notebook adaptör",
    "dizüstü adaptör",
    "bilgisayar adaptör",
    "şarj adaptör",
    "sarj adaptor",
    "güç adaptör",
    "guc adaptor",
    "powerbank",
    "power bank",
    "usb hub",
    "usb-c hub",
    "type-c hub",
  ];
  for (const ph of needles) {
    if (folded.includes(foldForMatch(ph))) return true;
  }
  return false;
}

function isLikelyScreenReplacementTitle(folded: string): boolean {
  const needles = [
    "notebook ekran",
    "dizustu ekran",
    "dizüstü ekran",
    "lcd ekran",
    "lcd panel",
    "ekran panel",
    "ekran lcd",
    "notebook lcd",
  ];
  for (const ph of needles) {
    if (folded.includes(foldForMatch(ph))) return true;
  }
  return false;
}

/** "İle uyumlu" aksesuar; başlıkta notebook/laptop/dizüstü yoksa (yalnızca ROG model adı) elenir. */
function hasUyumluAccessoryWithoutLaptopNoun(folded: string): boolean {
  if (!/uyumlu|uyumluk/i.test(folded)) return false;
  const spaced = ` ${folded} `;
  if (
    /\b(notebook|laptop|dizustu|macbook|chromebook|ultrabook|bilgisayar)\b/.test(spaced) ||
    /\bgaming\s+(laptop|notebook|dizustu|bilgisayar)\b/.test(folded)
  ) {
    return false;
  }
  return true;
}

/** Dizüstü kategorisi için: çanta, fare, klavye vb. ürünleri başlıktan ayıklar. */
function isLikelyLaptopAccessoryTitle(title: string): boolean {
  const folded = foldForMatch(title);
  const t = ` ${folded} `;

  const bagNeedles = [
    "laptop çantası",
    "notebook çantası",
    "bilgisayar çantası",
    "sırt çantası",
    "laptop ve evrak",
    "evrak çantası",
    "laptop ve evrak çantası",
  ];
  for (const ph of bagNeedles) {
    if (folded.includes(foldForMatch(ph))) return true;
  }
  if (/\bçanta\b/.test(folded) && /(evrak|shadowline|noirflex|obsidian)/i.test(folded)) return true;

  // Fare / klavye / kulaklık tam bilgisayar değil; ThinkPad klavye gibi durumlar da elenir.
  if (/\b(mouse|fare|klavye|keyboard|kulaklik|headset)\b/.test(t)) return true;

  // LCD / ekran panel satışları (Notebook Ekran vb.) — dizüstü değil
  if (isLikelyScreenReplacementTitle(folded)) return true;

  // Adaptör / şarj / hub: N11 vb. "Laptop Adaptörü" diye listeler; "laptop" kelimesi yüzünden yanlışlıkla tutulmasın.
  if (hasLaptopPowerOrCableAccessoryPhrase(folded)) return true;

  // "İle uyumlu" kılıf/koruyucu; başlıkta yalnızca ROG markası geçince laptop sanılmasın (PRICE_LOW ile üstte gelir)
  if (hasUyumluAccessoryWithoutLaptopNoun(folded)) return true;

  const laptopProductHint =
    /\b(notebook|laptop|dizustu|macbook|chromebook|ultrabook|thinkpad|ideapad|vivobook|zenbook|surface\s+laptop|surface\s+book)\b/.test(
      t
    ) ||
    /\b(nitro|predator|omen|victus|legion|swift|aspire|pavilion|elitebook|latitude|inspiron|xps|alienware|vostro|yoga|slim)\b/.test(
      t
    ) ||
    /\b(i3|i5|i7|i9|ryzen\s*[3579]|r3\b|r5\b|r7\b|r9\b)\b/i.test(t);

  if (laptopProductHint) return false;

  if (/\bmonitor\b/.test(t)) return true;

  const accessoryPhrases = [
    "docking",
    "mousepad",
    "mouse pad",
    "webcam",
    "ekran koruyucu",
    "temperli cam",
    "soğutucu",
    "cooling pad",
    "notebook stand",
    "laptop stand",
    "ssd",
    "nvme",
    "hdd",
    " ram ",
    "ddr4",
    "ddr5",
    "ekran kartı",
  ];
  for (const ph of accessoryPhrases) {
    if (folded.includes(foldForMatch(ph))) return true;
  }

  return false;
}
