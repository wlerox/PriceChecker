import type { Product } from "../../shared/types.ts";

export type PriceRange = {
  min?: number;
  max?: number;
};

type ParseOk = { ok: true; range: PriceRange };
type ParseErr = { ok: false; error: string };
export type ParsePriceRangeResult = ParseOk | ParseErr;

function parseBound(raw: string | undefined, label: string): number | undefined | string {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return `${label} geçersiz`;
  return n;
}

export function parsePriceRangeFromQuery(
  minRaw: string | undefined,
  maxRaw: string | undefined,
): ParsePriceRangeResult {
  const minParsed = parseBound(minRaw, "priceMin");
  if (typeof minParsed === "string") return { ok: false, error: minParsed };
  const maxParsed = parseBound(maxRaw, "priceMax");
  if (typeof maxParsed === "string") return { ok: false, error: maxParsed };
  if (minParsed != null && maxParsed != null && minParsed > maxParsed) {
    return { ok: false, error: "priceMin, priceMax değerinden büyük olamaz" };
  }
  const range: PriceRange = {};
  if (minParsed != null) range.min = minParsed;
  if (maxParsed != null) range.max = maxParsed;
  return { ok: true, range };
}

export function hasPriceRange(range: PriceRange | undefined): boolean {
  return range?.min != null || range?.max != null;
}

export function inPriceRange(price: number, range: PriceRange | undefined): boolean {
  if (!Number.isFinite(price)) return false;
  if (!range) return true;
  if (range.min != null && price < range.min) return false;
  if (range.max != null && price > range.max) return false;
  return true;
}

export function isAboveMax(price: number, range: PriceRange | undefined): boolean {
  if (!Number.isFinite(price)) return false;
  if (!range || range.max == null) return false;
  return price > range.max;
}

/** Artan fiyat sıralaması garantili sayfalarda erken kesme için. */
export function pageHasOnlyAboveMax(items: Product[], range: PriceRange | undefined): boolean {
  if (!range || range.max == null || items.length === 0) return false;
  return items.every((p) => isAboveMax(p.price, range));
}

export function cheapestProductPrice(items: Product[]): number | undefined {
  if (items.length === 0) return undefined;
  let min = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (Number.isFinite(item.price) && item.price < min) {
      min = item.price;
    }
  }
  return Number.isFinite(min) ? min : undefined;
}

/** Artan fiyat akışında, en ucuz ilgili ürün bile üst limiti aştıysa sayfalama durur. */
export function shouldStopByCheapestRelevantAboveMax(
  relevantItems: Product[],
  range: PriceRange | undefined,
): boolean {
  if (!range || range.max == null) return false;
  const cheapest = cheapestProductPrice(relevantItems);
  if (cheapest == null) return false;
  return cheapest > range.max;
}

export function filterProductsByPriceRange(items: Product[], range: PriceRange | undefined): Product[] {
  if (!hasPriceRange(range)) return items;
  return items.filter((p) => inPriceRange(p.price, range));
}
