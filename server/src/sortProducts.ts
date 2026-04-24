import type { Product } from "../../shared/types.ts";
import { parseTrPrice } from "./parsePrice.ts";

/** shared/sortProducts.ts ile aynı mantık; tsx giriş dosyasından ../shared çözümlemesinde yaşanan ESM hatasını önler. */

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

export function sortProductsByPriceAsc(products: Product[]): Product[] {
  return [...products].sort(compareProductPriceAsc);
}

export function compareProductPriceDesc(a: Product, b: Product): number {
  return -compareProductPriceAsc(a, b);
}

export function sortProductsByPriceDesc(products: Product[]): Product[] {
  return [...products].sort(compareProductPriceDesc);
}

/** Fiyata göre artan sıra; en fazla `max` ürün (mağaza başı limit için). */
export function takeCheapestProducts(products: Product[], max: number): Product[] {
  if (max <= 0) return [];
  return sortProductsByPriceAsc(products).slice(0, max);
}

/** Fiyata göre azalan sıra; en fazla `max` ürün. */
export function takeMostExpensiveProducts(products: Product[], max: number): Product[] {
  if (max <= 0) return [];
  return sortProductsByPriceDesc(products).slice(0, max);
}

/** Giriş sırasını koruyarak ilk `max` ürünü döndürür (relevance modu için). */
export function takeFirstProducts(products: Product[], max: number): Product[] {
  if (max <= 0) return [];
  return products.slice(0, max);
}
