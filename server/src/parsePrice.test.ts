import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTrPrice } from "./parsePrice.ts";

test("TL ve binlik nokta", () => {
  assert.equal(parseTrPrice("1.234,56 TL"), 1234.56);
});

test("sadece sayı", () => {
  assert.equal(parseTrPrice("999"), 999);
});

test("number geçişi", () => {
  assert.equal(parseTrPrice(42.5), 42.5);
});

test("geçersiz", () => {
  assert.equal(parseTrPrice(""), null);
  assert.equal(parseTrPrice("abc"), null);
});

test("aynı metinde küçük ve büyük tutar — küçük tutar anlamlı değilse yüksek kalır", () => {
  assert.equal(parseTrPrice("15,00 TL 12.595,50 TL"), 12595.5);
});

test("iki yakın yüksek tutar — indirimli (düşük) seçilir", () => {
  assert.equal(parseTrPrice("15.860,00 TL Sepette 15.699,99 TL"), 15699.99);
});

test("çoklu tutarda anlamlı olan (>=100) tercih", () => {
  assert.equal(parseTrPrice("99,50 TL"), 99.5);
});

test("Trendyol: etiket ile birleşik binlik fiyat", () => {
  assert.equal(parseTrPrice("Kargo Bedava148.999 TL"), 148999);
});
