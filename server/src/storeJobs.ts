import type { Product } from "../../shared/types.ts";
import { searchTrendyol } from "./adapters/trendyol.ts";
import { searchHepsiburada } from "./adapters/hepsiburada.ts";
import { searchAmazonTr } from "./adapters/amazonTr.ts";
import { searchN11 } from "./adapters/n11.ts";
import { searchPazarama } from "./adapters/pazarama.ts";
import { searchIdefix } from "./adapters/idefix.ts";
import { searchVatan } from "./adapters/vatan.ts";
import { searchPttAvm } from "./adapters/pttavm.ts";
import { searchMediaMarkt } from "./adapters/mediamarkt.ts";
import { searchCiceksepeti } from "./adapters/ciceksepeti.ts";
import { searchTeknosa } from "./adapters/teknosa.ts";
import { searchKoctas } from "./adapters/koctas.ts";
import { searchCimri } from "./adapters/cimri.ts";
import { searchAkakce } from "./adapters/akakce.ts";
import { searchGoogleShopping } from "./adapters/googleShopping.ts";
import { searchEpey } from "./adapters/epey.ts";
import type { PriceRange } from "./priceRange.ts";
import type { SortMode } from "./sortMode.ts";

export type StoreJob = { name: string; fn: () => Promise<Product[]> };

/** Bilinen mağaza adları (istemci checkbox değerleri ile aynı olmalı). */
export const KNOWN_STORE_NAMES = [
  "Trendyol",
  "Hepsiburada",
  "Amazon TR",
  "N11",
  "Pazarama",
  "İdefix",
  "Vatan",
  "PTT Avm",
  "MediaMarkt",
  "Çiçeksepeti",
  "Teknosa",
  "Koçtaş",
  "Cimri",
  "Akakçe",
  "Epey",
  "Google Alışveriş",
] as const;

const KNOWN_SET = new Set<string>(KNOWN_STORE_NAMES);

/**
 * @param onlyStores — Verilirse yalnızca bu isimlerdeki mağazalar sorgulanır (boş veya yok = hepsi).
 */
export function createStoreJobs(
  q: string,
  searchType?: string,
  onlyStores?: string[],
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): StoreJob[] {
  const all: StoreJob[] = [
    { name: "Trendyol", fn: () => searchTrendyol(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "Hepsiburada", fn: () => searchHepsiburada(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "Amazon TR", fn: () => searchAmazonTr(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "N11", fn: () => searchN11(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "Pazarama", fn: () => searchPazarama(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "İdefix", fn: () => searchIdefix(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "Vatan", fn: () => searchVatan(q, searchType, priceRange, exactMatch, onlyNew, sort) },
    { name: "PTT Avm", fn: () => searchPttAvm(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "MediaMarkt", fn: () => searchMediaMarkt(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "Çiçeksepeti", fn: () => searchCiceksepeti(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "Teknosa", fn: () => searchTeknosa(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "Koçtaş", fn: () => searchKoctas(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "Cimri", fn: () => searchCimri(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "Akakçe", fn: () => searchAkakce(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "Epey", fn: () => searchEpey(q, priceRange, exactMatch, onlyNew, sort) },
    { name: "Google Alışveriş", fn: () => searchGoogleShopping(q, priceRange, exactMatch, onlyNew, sort) },
  ];

  if (!onlyStores?.length) return all;

  const allow = new Set(onlyStores.filter((n) => KNOWN_SET.has(n)));
  if (allow.size === 0) return [];
  return all.filter((j) => allow.has(j.name));
}
