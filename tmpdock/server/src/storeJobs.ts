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
] as const;

const KNOWN_SET = new Set<string>(KNOWN_STORE_NAMES);

/**
 * @param onlyStores — Verilirse yalnızca bu isimlerdeki mağazalar sorgulanır (boş veya yok = hepsi).
 */
export function createStoreJobs(q: string, searchType?: string, onlyStores?: string[]): StoreJob[] {
  const all: StoreJob[] = [
    { name: "Trendyol", fn: () => searchTrendyol(q) },
    { name: "Hepsiburada", fn: () => searchHepsiburada(q) },
    { name: "Amazon TR", fn: () => searchAmazonTr(q) },
    { name: "N11", fn: () => searchN11(q) },
    { name: "Pazarama", fn: () => searchPazarama(q) },
    { name: "İdefix", fn: () => searchIdefix(q) },
    { name: "Vatan", fn: () => searchVatan(q, searchType) },
    { name: "PTT Avm", fn: () => searchPttAvm(q) },
    { name: "MediaMarkt", fn: () => searchMediaMarkt(q) },
    { name: "Çiçeksepeti", fn: () => searchCiceksepeti(q) },
    { name: "Teknosa", fn: () => searchTeknosa(q) },
  ];

  if (!onlyStores?.length) return all;

  const allow = new Set(onlyStores.filter((n) => KNOWN_SET.has(n)));
  if (allow.size === 0) return [];
  return all.filter((j) => allow.has(j.name));
}
