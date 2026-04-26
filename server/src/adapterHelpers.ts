import type { Product } from "../../shared/types.ts";
import type { SortMode } from "./sortMode.ts";
import {
  pageHasOnlyAboveMax,
  pageHasOnlyBelowMin,
  shouldStopByCheapestRelevantAboveMax,
  shouldStopByMostExpensiveRelevantBelowMin,
  type PriceRange,
} from "./priceRange.ts";
import {
  takeCheapestProducts,
  takeFirstProducts,
  takeMostExpensiveProducts,
} from "./sortProducts.ts";

/**
 * Sort moduna göre: sayfalama akışında fiyat-sınırı kontrollerinden "artık hiç aday
 * gelmeyecek" durumunu tespit eder. `relevance` modunda hep false döner.
 */
export function shouldStopBySortOrderedRange(
  relevantItems: Product[],
  priceRange: PriceRange | undefined,
  sort: SortMode,
): boolean {
  if (sort === "price-asc") return shouldStopByCheapestRelevantAboveMax(relevantItems, priceRange);
  if (sort === "price-desc") return shouldStopByMostExpensiveRelevantBelowMin(relevantItems, priceRange);
  return false;
}

/**
 * Bir sayfanın tüm kayıtları aralık dışı mı? (Sort garanti ise sonraki sayfalar
 * da aralık dışı olacak demektir → erken kes.)
 */
export function pageAllOutsideRange(
  pageItems: Product[],
  priceRange: PriceRange | undefined,
  sort: SortMode,
): boolean {
  if (sort === "price-asc") return pageHasOnlyAboveMax(pageItems, priceRange);
  if (sort === "price-desc") return pageHasOnlyBelowMin(pageItems, priceRange);
  return false;
}

/** Sort moduna göre adapter'ın son çıktısını kırpar ve sıralar. */
export function finalizeProductsForSort(
  products: Product[],
  max: number,
  sort: SortMode,
): Product[] {
  if (sort === "price-desc") return takeMostExpensiveProducts(products, max);
  if (sort === "relevance") return takeFirstProducts(products, max);
  return takeCheapestProducts(products, max);
}

export function buildNoMatchMessage(
  store: string,
  query: string,
  pagesScanned: number,
  candidateCount: number,
  elapsedMs: number,
  budgetMs: number,
): string {
  const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
  const budgetSec = Math.max(1, Math.round(budgetMs / 1000));
  const timedOut = elapsedMs >= budgetMs;
  if (timedOut) {
    return (
      `${store}: "${query}" için ${budgetSec} sn arama bütçesi doldu, eşleşen ürün bulunamadı ` +
      `(${pagesScanned} sayfa tarandı, ${candidateCount} aday ürün elendi, süre=${elapsedSec}s).`
    );
  }
  return (
    `${store}: "${query}" için eşleşen ürün bulunamadı ` +
    `(${pagesScanned} sayfa tarandı, ${candidateCount} aday ürün elendi, süre=${elapsedSec}s).`
  );
}
