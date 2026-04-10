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
import type { PriceRange } from "./priceRange.ts";

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
): StoreJob[] {
  const all: StoreJob[] = [
    { name: "Trendyol", fn: () => searchTrendyol(q, priceRange) },
    { name: "Hepsiburada", fn: () => searchHepsiburada(q, priceRange) },
    { name: "Amazon TR", fn: () => searchAmazonTr(q, priceRange) },
    { name: "N11", fn: () => searchN11(q, priceRange) },
    { name: "Pazarama", fn: () => searchPazarama(q, priceRange) },
    { name: "İdefix", fn: () => searchIdefix(q, priceRange) },
    { name: "Vatan", fn: () => searchVatan(q, searchType, priceRange) },
    { name: "PTT Avm", fn: () => searchPttAvm(q, priceRange) },
    { name: "MediaMarkt", fn: () => searchMediaMarkt(q, priceRange) },
    { name: "Çiçeksepeti", fn: () => searchCiceksepeti(q, priceRange) },
    { name: "Teknosa", fn: () => searchTeknosa(q, priceRange) },
    { name: "Koçtaş", fn: () => searchKoctas(q, priceRange) },
  ];

  if (!onlyStores?.length) return all;

  const allow = new Set(onlyStores.filter((n) => KNOWN_SET.has(n)));
  if (allow.size === 0) return [];
  return all.filter((j) => allow.has(j.name));
}
