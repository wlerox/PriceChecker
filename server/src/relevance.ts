import type { Product } from "../../shared/types.ts";

/**
 * Arama sorgusundan anlamlı parçalar (2+ karakter; harf/rakam).
 * Örn. "rtx 5080" → ["rtx","5080"] — başlıkta hepsi geçmeli.
 */
export function queryTokensForMatch(query: string): string[] {
  return query
    .toLocaleLowerCase("tr")
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
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
 * Uzun sorgularda (4+ anlamlı parça) tüm kelimeleri başlıkta aramak ucuz/kısa ilanları düşürür;
 * en fazla bir kelime eksik kalabilir. 1–3 parçada sıkı eşleşme korunur.
 */
function titleMatchesQueryTokens(foldedTitle: string, foldedTokens: string[]): boolean {
  if (foldedTokens.length === 0) return true;
  const matched = foldedTokens.filter((tok) => {
    if (/\d/.test(tok)) {
      const esc = escapeRegExp(tok);
      const isAllDigits = /^\d+$/.test(tok);
      const afterBound = isAllDigits ? `(?:$|[^\\d])` : `(?:$|[^\\p{L}\\p{N}])`;
      const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc}${afterBound}`, "u");
      if (re.test(foldedTitle)) return true;
      const glued = new RegExp(`\\p{L}${esc}(?:$|[^\\d])`, "u");
      return glued.test(foldedTitle);
    }
    // "ti", "se" gibi kısa tokenlar "karti", "bit" içinde yanlış eşleşmesin → kelime sınırı iste
    if (tok.length <= 2) {
      const esc = escapeRegExp(tok);
      const re = new RegExp(`(?:^|[^\\p{L}])${esc}(?:$|[^\\p{L}])`, "u");
      return re.test(foldedTitle);
    }
    return foldedTitle.includes(tok);
  }).length;
  if (foldedTokens.length <= 3) return matched === foldedTokens.length;
  const need = Math.max(2, foldedTokens.length - 1);
  return matched >= need;
}

/**
 * Ürün başlığında arama terimleri yeterince geçmiyorsa ele (geniş mağaza araması gürültüsünü keser).
 */
export function filterProductsByQuery(
  query: string,
  products: Product[],
  pageMap?: Map<string, number>,
): Product[] {
  const tokens = [...new Set(queryTokensForMatch(query))];
  if (tokens.length === 0) return products;
  const foldedTokens = tokens.map(foldForMatch);
  return products.filter((p) => {
    const t = foldForMatch(p.title);
    const ok = titleMatchesQueryTokens(t, foldedTokens);
    const pg = pageMap?.get(p.url);
    const pgTag = pg != null ? ` sayfa=${pg}` : "";
    if (ok) {
      console.info(`[relevance] ✓ alındı: [${p.store}]${pgTag} ${p.price} TL "${p.title.slice(0, 80)}" | tokens=${foldedTokens.join(",")}`);
    } else {
      console.info(`[relevance] ✗ elendi: [${p.store}]${pgTag} ${p.price} TL "${p.title.slice(0, 80)}" | tokens=${foldedTokens.join(",")}`);
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

/**
 * API yanıtı için: başlık + kategori süzgeçleri birlikte tüm satırları silerse,
 * ham mağaza sonuçlarını döndür (ekranda hiç veri kalmamasın).
 */
export function applyRelevanceFilters(
  query: string,
  searchType: string | undefined,
  products: Product[]
): Product[] {
  if (products.length === 0) return [];
  let relevant = filterProductsByQuery(query, products);
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
