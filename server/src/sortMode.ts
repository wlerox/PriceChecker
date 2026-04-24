/**
 * Arama sıralama modu (API + adapter sözleşmesi).
 *
 * - `price-asc`    : fiyat artan (varsayılan — eski davranış)
 * - `price-desc`   : fiyat azalan
 * - `relevance`    : sitenin önerdiği / varsayılan sıra
 */
export type SortMode = "price-asc" | "price-desc" | "relevance";

export const DEFAULT_SORT_MODE: SortMode = "price-asc";

const SORT_VALUES: ReadonlySet<SortMode> = new Set<SortMode>([
  "price-asc",
  "price-desc",
  "relevance",
]);

export function isSortMode(v: unknown): v is SortMode {
  return typeof v === "string" && SORT_VALUES.has(v as SortMode);
}

/**
 * `?sort=...` query param'ını güvenle SortMode'a çözümler.
 * Tanınmayan / boş değerde {@link DEFAULT_SORT_MODE} döner.
 */
export function parseSortModeFromQuery(
  raw: string | string[] | undefined,
): SortMode {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null) return DEFAULT_SORT_MODE;
  const s = String(value).trim().toLocaleLowerCase("tr");
  if (s === "" ) return DEFAULT_SORT_MODE;
  if (s === "price-asc" || s === "asc" || s === "price_asc" || s === "artan") return "price-asc";
  if (s === "price-desc" || s === "desc" || s === "price_desc" || s === "azalan") return "price-desc";
  if (s === "relevance" || s === "default" || s === "onerilen" || s === "önerilen") return "relevance";
  return DEFAULT_SORT_MODE;
}
