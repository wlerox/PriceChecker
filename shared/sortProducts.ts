import { parseTrPrice } from "./parsePrice";
import type { Product } from "./types";

/** Fiyat sıralaması ve tablo için tutar (parse edilemezse NaN). */
export function productNumericPrice(p: Product): number {
  const n = parseTrPrice(p.price as string | number | null | undefined);
  return n ?? Number.NaN;
}

export function compareProductPriceAsc(a: Product, b: Product): number {
  const na = productNumericPrice(a);
  const nb = productNumericPrice(b);
  const aBad = Number.isNaN(na);
  const bBad = Number.isNaN(nb);
  if (aBad && bBad) return a.title.localeCompare(b.title, "tr") || a.store.localeCompare(b.store, "tr");
  if (aBad) return 1;
  if (bBad) return -1;
  if (na !== nb) return na - nb;
  return a.title.localeCompare(b.title, "tr") || a.store.localeCompare(b.store, "tr");
}

export function compareProductPriceDesc(a: Product, b: Product): number {
  const na = productNumericPrice(a);
  const nb = productNumericPrice(b);
  const aBad = Number.isNaN(na);
  const bBad = Number.isNaN(nb);
  if (aBad && bBad) return a.title.localeCompare(b.title, "tr") || a.store.localeCompare(b.store, "tr");
  if (aBad) return 1;
  if (bBad) return -1;
  if (na !== nb) return nb - na;
  return a.title.localeCompare(b.title, "tr") || a.store.localeCompare(b.store, "tr");
}

export function sortProductsByPriceAsc(products: Product[]): Product[] {
  return [...products].sort(compareProductPriceAsc);
}
