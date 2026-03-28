/**
 * Türk e-ticaret fiyat stringlerini sayıya çevirir (örn. "1.234,56 TL", "1234.56").
 * Birden fazla tutar varsa (taksit, eski fiyat vb.) makul ana fiyatı seçer.
 * (shared/parsePrice.ts ile aynı; tsx kök dizinden test çalışırken re-export yolu kırıldığı için kopya.)
 */
const TR_WITH_DECIMALS = /\d{1,3}(?:\.\d{3})*,\d{2}/g;

function parseTurkishAmount(chunk: string): number | null {
  const cleaned = chunk.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function amountsTurkishFormat(s: string): number[] {
  const out: number[] = [];
  const str = String(s);
  let m: RegExpExecArray | null;
  const re = new RegExp(TR_WITH_DECIMALS.source, "g");
  while ((m = re.exec(str)) !== null) {
    const n = parseTurkishAmount(m[0]);
    if (n != null) out.push(n);
  }
  return out;
}

function pickPrimaryAmount(amounts: number[]): number | null {
  if (!amounts.length) return null;
  const significant = amounts.filter((a) => a >= 100);
  if (significant.length) return Math.max(...significant);
  return Math.max(...amounts);
}

function legacySinglePass(s: string): number | null {
  const cleaned = s
    .replace(/\s/g, "")
    .replace(/TL|₺|try/gi, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function amountsFromMessyTrPriceString(s: string): number[] {
  const out: number[] = [];
  const str = String(s);
  const re = /\d{1,3}(?:\.\d{3})*,\d{2}|\d{1,3}(?:\.\d{3})+(?![\d,])/g;
  let m: RegExpExecArray | null;
  const r = new RegExp(re.source, "g");
  while ((m = r.exec(str)) !== null) {
    const chunk = m[0];
    if (/,/.test(chunk)) {
      const n = parseTurkishAmount(chunk);
      if (n != null) out.push(n);
    } else {
      const n = parseTurkishAmount(chunk.replace(/\./g, "") + ",00");
      if (n != null) out.push(n);
    }
  }
  return out;
}

export function parseTrPrice(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && !Number.isNaN(raw)) return raw >= 0 ? raw : null;
  const s = String(raw).trim();
  if (!s) return null;

  const fromTurkish = amountsTurkishFormat(s);
  if (fromTurkish.length > 0) {
    return pickPrimaryAmount(fromTurkish);
  }

  const fromMessy = amountsFromMessyTrPriceString(s);
  if (fromMessy.length > 0) {
    return pickPrimaryAmount(fromMessy);
  }

  const legacy = legacySinglePass(s);
  return legacy;
}
