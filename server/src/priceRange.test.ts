import assert from "node:assert/strict";
import { test } from "node:test";
import type { Product } from "../../shared/types.ts";
import {
  filterProductsByPriceRange,
  inPriceRange,
  pageHasOnlyAboveMax,
  parsePriceRangeFromQuery,
} from "./priceRange.ts";

test("parsePriceRangeFromQuery: geçerli min/max", () => {
  const out = parsePriceRangeFromQuery("100", "500");
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.range.min, 100);
    assert.equal(out.range.max, 500);
  }
});

test("parsePriceRangeFromQuery: min > max ise hata", () => {
  const out = parsePriceRangeFromQuery("600", "500");
  assert.equal(out.ok, false);
});

test("parsePriceRangeFromQuery: geçersiz sayı hata döner", () => {
  const out = parsePriceRangeFromQuery("abc", "500");
  assert.equal(out.ok, false);
});

test("inPriceRange: alt/üst sınır dahil", () => {
  const range = { min: 100, max: 200 };
  assert.equal(inPriceRange(100, range), true);
  assert.equal(inPriceRange(150, range), true);
  assert.equal(inPriceRange(200, range), true);
  assert.equal(inPriceRange(99, range), false);
  assert.equal(inPriceRange(201, range), false);
});

test("filterProductsByPriceRange: sadece aralık içini döner", () => {
  const rows: Product[] = [
    { store: "T", title: "A", price: 90, currency: "TRY", url: "u1" },
    { store: "T", title: "B", price: 120, currency: "TRY", url: "u2" },
    { store: "T", title: "C", price: 180, currency: "TRY", url: "u3" },
    { store: "T", title: "D", price: 240, currency: "TRY", url: "u4" },
  ];
  const out = filterProductsByPriceRange(rows, { min: 100, max: 200 });
  assert.deepEqual(
    out.map((x) => x.title),
    ["B", "C"],
  );
});

test("pageHasOnlyAboveMax: tüm ürünler max üstündeyse true", () => {
  const rows: Product[] = [
    { store: "T", title: "A", price: 510, currency: "TRY", url: "u1" },
    { store: "T", title: "B", price: 620, currency: "TRY", url: "u2" },
  ];
  assert.equal(pageHasOnlyAboveMax(rows, { max: 500 }), true);
});

test("pageHasOnlyAboveMax: en az bir ürün max altındaysa false", () => {
  const rows: Product[] = [
    { store: "T", title: "A", price: 480, currency: "TRY", url: "u1" },
    { store: "T", title: "B", price: 620, currency: "TRY", url: "u2" },
  ];
  assert.equal(pageHasOnlyAboveMax(rows, { max: 500 }), false);
});
