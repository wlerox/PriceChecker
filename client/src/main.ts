import type { Product } from "../../shared/types";
import {
  compareProductPriceAsc,
  compareProductPriceDesc,
  productNumericPrice,
} from "../../shared/sortProducts";
import "./style.css";

/** Boş: geliştirmede Vite `/api` proxy; üretimde `VITE_API_BASE=https://api.example.com` (sonunda / yok). */
function apiUrl(path: string): string {
  const base = String(import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}

const STORE_OPTIONS = [
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
  "Google Alışveriş",
] as const;

/** Üst kategori → alt kategori; API `type` için alt satırın apiValue’su veya üst varsayılanı kullanılır. */
type CategorySub = { apiValue: string; label: string };
type CategoryBranch = {
  id: string;
  label: string;
  /** Alt seçili değilken gönderilen `type` (boş = kategori kullanılmaz). */
  defaultType: string;
  subs: readonly CategorySub[];
};

const CATEGORY_TREE: readonly CategoryBranch[] = [
  { id: "_none", label: "Yok (sadece arama sözcüğü)", defaultType: "", subs: [] },
  {
    id: "elektronik",
    label: "Elektronik",
    defaultType: "Elektronik",
    subs: [
      { apiValue: "TV & görüntü", label: "TV & görüntü" },
      { apiValue: "Ses sistemleri & hoparlör", label: "Ses sistemleri & hoparlör" },
      { apiValue: "Kulaklık", label: "Kulaklık" },
      { apiValue: "Monitör", label: "Monitör" },
      { apiValue: "Bilgisayar & tablet", label: "Bilgisayar & tablet" },
      { apiValue: "Dizüstü bilgisayar", label: "Dizüstü bilgisayar" },
      { apiValue: "Masaüstü bilgisayar", label: "Masaüstü bilgisayar" },
      { apiValue: "Tablet", label: "Tablet" },
      { apiValue: "Ekran kartı", label: "Ekran kartı" },
      { apiValue: "Bilgisayar bileşenleri", label: "Bilgisayar bileşenleri" },
      { apiValue: "Depolama (SSD / HDD)", label: "Depolama (SSD / HDD)" },
      { apiValue: "Klavye & mouse", label: "Klavye & mouse" },
      { apiValue: "Çevre birimleri", label: "Çevre birimleri" },
      { apiValue: "Ağ & modem & router", label: "Ağ & modem & router" },
      { apiValue: "Yazıcı & tarayıcı", label: "Yazıcı & tarayıcı" },
      { apiValue: "Telefon & aksesuar", label: "Telefon & aksesuar" },
      { apiValue: "Akıllı saat & bileklik", label: "Akıllı saat & bileklik" },
      { apiValue: "Powerbank & şarj", label: "Powerbank & şarj" },
      { apiValue: "Kablo & adaptör", label: "Kablo & adaptör" },
      { apiValue: "Fotoğraf & kamera", label: "Fotoğraf & kamera" },
      { apiValue: "Oyun konsolu & aksesuar", label: "Oyun konsolu & aksesuar" },
      { apiValue: "Drone", label: "Drone" },
      { apiValue: "Projeksiyon", label: "Projeksiyon" },
      { apiValue: "Akıllı ev", label: "Akıllı ev" },
      { apiValue: "Beyaz eşya", label: "Beyaz eşya" },
      { apiValue: "Küçük ev aletleri", label: "Küçük ev aletleri" },
    ],
  },
  {
    id: "giyim",
    label: "Giyim",
    defaultType: "Giyim",
    subs: [
      { apiValue: "Mont / kaban", label: "Mont / kaban" },
      { apiValue: "Ayakkabı", label: "Ayakkabı" },
    ],
  },
  {
    id: "ev",
    label: "Ev & yaşam",
    defaultType: "Ev & yaşam",
    subs: [],
  },
  {
    id: "spor",
    label: "Spor & outdoor",
    defaultType: "Spor & outdoor",
    subs: [],
  },
];

type SortOption = "price-asc" | "price-desc" | "default";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app yok");

app.innerHTML = `
  <main class="layout">
    <header class="header">
      <h1>TR fiyat karşılaştırma</h1>
      <p class="sub">Trendyol, Hepsiburada, Amazon TR, N11, Pazarama, İdefix, Vatan, PTT Avm, MediaMarkt, Çiçeksepeti, Teknosa, Koçtaş, Cimri, Akakçe, Google Alışveriş — yerelde çalışır, veri saklanmaz.</p>
    </header>

    <aside class="filters filters--bar" id="filters" aria-label="Filtreler">
      <div class="filters-head">
        <h2 class="filters-title">Filtreler</h2>
        <button type="button" class="btn-text" id="filter-reset">Sıfırla</button>
      </div>

      <div class="filters-columns">
        <!--<details class="filter-section" open>
          <summary class="filter-summary">Kategori / ürün tipi</summary>
          <div class="filter-body category-stack">
            <div>
              <label class="field-label" for="category-parent">Üst kategori</label>
              <select id="category-parent" class="select-input" aria-controls="category-sub"></select>
            </div>
            <div>
              <label class="field-label" for="category-sub">Alt kategori</label>
              <select id="category-sub" class="select-input"></select>
            </div>
            <p class="field-hint">Üst/alt kategori sunucuya gider: Vatan gibi sitelerde kategoriyle arar; diğerlerinde düz metin aranır. Dizüstü seçiliyken başlıkta net laptop olmayan aksesuar benzeri satırlar süzülür.</p>
          </div>
        </details>-->

        <details class="filter-section" open>
          <summary class="filter-summary">Satıcı / mağaza</summary>
          <div class="filter-body">
            <div class="store-bulk-actions" role="group" aria-label="Satıcıları toplu seç">
              <button type="button" class="btn-text" id="store-select-all">Tümünü seç</button>
              <button type="button" class="btn-text" id="store-clear-all">Tümünü kaldır</button>
            </div>
            <div class="filter-stores">
            ${STORE_OPTIONS.map(
              (s) => `
              <label class="check-row">
                <input type="checkbox" name="filter-store" value="${s}" checked />
                <span>${s}</span>
              </label>`
            ).join("")}
            </div>
          </div>
        </details>

        <details class="filter-section" open>
          <summary class="filter-summary">Fiyat (TL)</summary>
          <div class="filter-body">
            <div class="price-inputs">
              <input type="number" id="price-min" min="0" step="1" placeholder="En az" inputmode="numeric" aria-label="Minimum fiyat" />
              <span class="price-sep">—</span>
              <input type="number" id="price-max" min="0" step="1" placeholder="En çok" inputmode="numeric" aria-label="Maksimum fiyat" />
            </div>
            <div class="price-chips" role="group" aria-label="Hızlı fiyat aralığı">
              <button type="button" class="chip" data-pmin="" data-pmax="500">0 – 500</button>
              <button type="button" class="chip" data-pmin="500" data-pmax="1500">500 – 1.500</button>
              <button type="button" class="chip" data-pmin="1500" data-pmax="5000">1.500 – 5.000</button>
              <button type="button" class="chip" data-pmin="5000" data-pmax="">5.000+</button>
            </div>
          </div>
        </details>

        <!--<details class="filter-section" open>
          <summary class="filter-summary">Sonuç görünümü</summary>
          <div class="filter-body">
            <label class="check-row">
              <input type="checkbox" id="only-cheapest" />
              <span>Yalnızca en ucuz teklifi göster</span>
            </label>
            <p class="field-hint">Varsayılan: tüm mağaza sonuçları fiyata göre sıralı. Açıksa yalnızca en düşük fiyatlı tek satır gösterilir (akışta önce gelen pahalı teklif yanıltıcı olmasın diye tam listeyi tercih edin).</p>
          </div>
        </details>

        <details class="filter-section">
          <summary class="filter-summary">Ürün adında ara</summary>
          <div class="filter-body">
            <label class="field-label" for="title-filter">Listeyi daralt</label>
            <input type="search" id="title-filter" placeholder="Kelime (örn. bluetooth, ASUS)…" autocomplete="off" />
          </div>
        </details> -->
      </div>
    </aside>

    <form class="search-toolbar" id="form">
      <label class="sr-only" for="q">Ürün ara</label>
      <input
        type="search"
        id="q"
        name="q"
        placeholder="Ne arıyorsunuz? Örn: kulaklık, ekran kartı, mont…"
        autocomplete="off"
        required
      />
      <select id="sort-by" aria-label="Sonuç sıralaması">
        <option value="price-asc" selected>Fiyat: Düşükten yükseğe</option>
        <option value="price-desc">Fiyat: Büyükten düşüğe</option>
        <option value="default">Fiyat: Varsayılan</option>
      </select>
      <label class="check-row search-exact-row" title="Açıkken sorgu başlıkta bitişik/sıkı eşleşir">
        <input type="checkbox" id="exact-match" />
        <span>Tam eşleşme</span>
      </label>
      <button type="submit" id="btn">Ara</button>
    </form>

    <div class="results-area" id="content-grid">
      <div class="results-column">
        <p class="hint" id="hint">Arama kutusuna yazıp <strong>Ara</strong>’ya basın; üstteki filtrelerle mağaza ve fiyat daraltabilirsiniz.</p>
        <p class="filter-active-note hidden" id="filter-note" aria-live="polite"></p>
        <div class="loading hidden" id="loading" aria-live="polite">Aranıyor…</div>
        <section class="errors hidden" id="errors"></section>
        <section class="table-wrap hidden" id="wrap">
          <table class="results">
            <thead>
              <tr>
                <th>#</th>
                <th>Mağaza</th>
                <th>Ürün</th>
                <th>Fiyat</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody id="tbody"></tbody>
          </table>
        </section>
      </div>
    </div>
  </main>
`;

const form = document.getElementById("form") as HTMLFormElement;
const qInput = document.getElementById("q") as HTMLInputElement;
const categoryParent = document.getElementById("category-parent") as HTMLSelectElement | null;
const categorySub = document.getElementById("category-sub") as HTMLSelectElement | null;
const btn = document.getElementById("btn") as HTMLButtonElement;
const loading = document.getElementById("loading") as HTMLDivElement;
const errorsEl = document.getElementById("errors") as HTMLDivElement;
const wrap = document.getElementById("wrap") as HTMLDivElement;
const tbody = document.getElementById("tbody") as HTMLTableSectionElement;
const hint = document.getElementById("hint") as HTMLParagraphElement;
const filterNote = document.getElementById("filter-note") as HTMLParagraphElement;

const priceMinEl = document.getElementById("price-min") as HTMLInputElement;
const priceMaxEl = document.getElementById("price-max") as HTMLInputElement;
const sortByEl = document.getElementById("sort-by") as HTMLSelectElement;
const exactMatchEl = document.getElementById("exact-match") as HTMLInputElement;
const titleFilterEl = document.getElementById("title-filter") as HTMLInputElement | null;
const onlyCheapestEl = document.getElementById("only-cheapest") as HTMLInputElement | null;
const filterResetBtn = document.getElementById("filter-reset") as HTMLButtonElement;
const storeSelectAllBtn = document.getElementById("store-select-all") as HTMLButtonElement;
const storeClearAllBtn = document.getElementById("store-clear-all") as HTMLButtonElement;
const filtersEl = document.getElementById("filters") as HTMLElement;

function populateCategorySub(): void {
  if (!categoryParent || !categorySub) return;
  const branch = CATEGORY_TREE.find((b) => b.id === categoryParent.value);
  if (!branch) return;
  categorySub.replaceChildren();
  if (branch.id === "_none") {
    categorySub.disabled = true;
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "—";
    categorySub.appendChild(o);
    return;
  }
  categorySub.disabled = false;
  const o0 = document.createElement("option");
  o0.value = "";
  o0.textContent = `Genel (${branch.label})`;
  categorySub.appendChild(o0);
  for (const s of branch.subs) {
    const o = document.createElement("option");
    o.value = s.apiValue;
    o.textContent = s.label;
    categorySub.appendChild(o);
  }
}

function getSearchTypeForApi(): string | undefined {
  if (!categoryParent || !categorySub) return undefined;
  const branch = CATEGORY_TREE.find((b) => b.id === categoryParent.value);
  if (!branch || branch.id === "_none") return undefined;
  const sub = categorySub.value.trim();
  if (!sub) return branch.defaultType || undefined;
  return sub;
}

function getCategoryDisplayLabel(): string | undefined {
  if (!categoryParent || !categorySub) return undefined;
  const branch = CATEGORY_TREE.find((b) => b.id === categoryParent.value);
  if (!branch || branch.id === "_none") return undefined;
  const sub = categorySub.value.trim();
  if (!sub) return branch.label;
  const subObj = branch.subs.find((s) => s.apiValue === sub);
  return `${branch.label} › ${subObj?.label ?? sub}`;
}

function initCategorySelects(): void {
  if (!categoryParent || !categorySub) return;
  categoryParent.replaceChildren();
  for (const b of CATEGORY_TREE) {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = b.label;
    categoryParent.appendChild(o);
  }
  categoryParent.selectedIndex = 0;
  populateCategorySub();
  categoryParent.addEventListener("change", populateCategorySub);
}

let rawResults: Product[] = [];
let lastMeta: { query: string; searchType?: string } = { query: "" };

function formatTry(n: number): string {
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(n);
}

const priceNum = productNumericPrice;

function setFiltersDisabled(on: boolean): void {
  filtersEl.querySelectorAll("input, select, button").forEach((el) => {
    if (el instanceof HTMLInputElement && el.name === "filter-store") return;
    (el as HTMLInputElement | HTMLButtonElement).disabled = on;
  });
}

function setLoading(on: boolean): void {
  loading.classList.toggle("hidden", !on);
  btn.disabled = on;
  qInput.disabled = on;
  sortByEl.disabled = on;
  setFiltersDisabled(on);
}

function getSelectedStores(): Set<string> {
  const set = new Set<string>();
  document.querySelectorAll<HTMLInputElement>('input[name="filter-store"]:checked').forEach((el) => {
    set.add(el.value);
  });
  return set;
}

function getSort(): SortOption {
  const v = sortByEl.value;
  if (v === "price-desc" || v === "default") return v;
  return "price-asc";
}

function applyFilters(products: Product[]): Product[] {
  const stores = new Set([...getSelectedStores()].map((s) => s.trim()));
  const pmin = priceMinEl.value.trim() === "" ? null : Number(priceMinEl.value);
  const pmax = priceMaxEl.value.trim() === "" ? null : Number(priceMaxEl.value);
  const titleNeedle = (titleFilterEl?.value ?? "").trim().toLocaleLowerCase("tr");

  let out = products.filter((p) => stores.has(p.store.trim()));

  if (pmin != null && Number.isFinite(pmin)) {
    out = out.filter((p) => {
      const n = priceNum(p);
      return Number.isFinite(n) && n >= pmin;
    });
  }
  if (pmax != null && Number.isFinite(pmax)) {
    out = out.filter((p) => {
      const n = priceNum(p);
      return Number.isFinite(n) && n <= pmax;
    });
  }
  if (titleNeedle) {
    const fold = (s: string) => s.toLocaleLowerCase("tr");
    out = out.filter((p) => fold(p.title).includes(titleNeedle));
  }

  const sort = getSort();
  out = [...out];
  if (sort === "price-asc") out.sort(compareProductPriceAsc);
  else if (sort === "price-desc") out.sort(compareProductPriceDesc);

  return out;
}

/** Filtrelenmiş listeden en düşük fiyatlı tek ürün (eşit fiyatta deterministik seçim). */
function pickCheapest(products: Product[]): Product {
  let best = products[0];
  let bestN = priceNum(best);
  for (let i = 1; i < products.length; i++) {
    const p = products[i];
    const pn = priceNum(p);
    if (!Number.isFinite(pn)) continue;
    if (!Number.isFinite(bestN) || pn < bestN) {
      best = p;
      bestN = pn;
    } else if (pn === bestN && p.title.localeCompare(best.title, "tr") < 0) {
      best = p;
      bestN = pn;
    }
  }
  return best;
}

function renderErrors(errors: { store: string; message: string }[] | undefined): void {
  if (!errors?.length) {
    errorsEl.classList.add("hidden");
    errorsEl.innerHTML = "";
    return;
  }
  errorsEl.classList.remove("hidden");
  errorsEl.innerHTML = `<h2 class="err-title">Bazı mağazalar yanıt vermedi</h2><ul>${errors
    .map((e) => `<li><strong>${escapeHtml(e.store)}:</strong> ${escapeHtml(e.message)}</li>`)
    .join("")}</ul>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHttpUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "#";
    return u.href;
  } catch {
    return "#";
  }
}

function updateFilterNote(shown: number, total: number): void {
  if (total === 0) {
    filterNote.classList.add("hidden");
    filterNote.textContent = "";
    return;
  }
  if (shown < total) {
    filterNote.classList.remove("hidden");
    filterNote.textContent = `Filtreler nedeniyle ${shown} / ${total} ürün gösteriliyor.`;
  } else {
    filterNote.classList.add("hidden");
    filterNote.textContent = "";
  }
}

function renderTable(): void {
  const pool = applyFilters(rawResults);
  tbody.innerHTML = "";
  const meta = lastMeta;

  if (!rawResults.length) {
    wrap.classList.add("hidden");
    filterNote.classList.add("hidden");
    const typePart = meta.searchType ? ` · Tip: ${meta.searchType}` : "";
    hint.textContent = meta.query
      ? `“${meta.query}”${typePart} için sonuç bulunamadı. Farklı bir arama deneyin.`
      : "Arama yaparak mağazalardan fiyatları karşılaştırın.";
    return;
  }

  if (!pool.length) {
    wrap.classList.add("hidden");
    updateFilterNote(0, rawResults.length);
    hint.textContent = `Filtrelere uygun ürün yok (${rawResults.length} sonuçtan). Fiyat aralığını veya mağaza seçimini kontrol edin.`;
    return;
  }

  const onlyCheapest = onlyCheapestEl?.checked ?? false;
  const filtered = onlyCheapest ? [pickCheapest(pool)] : pool;

  wrap.classList.remove("hidden");
  updateFilterNote(filtered.length, rawResults.length);

  const priceNums = filtered.map((r) => priceNum(r)).filter((n) => Number.isFinite(n));
  const minPrice = onlyCheapest ? null : priceNums.length ? Math.min(...priceNums) : null;
  filtered.forEach((r, i) => {
    const tr = document.createElement("tr");
    if (onlyCheapest) tr.classList.add("cheapest");
    else if (minPrice != null && Number.isFinite(minPrice) && priceNum(r) === minPrice) tr.classList.add("cheapest");
    const href = safeHttpUrl(r.url);
    const n = priceNum(r);
    const priceCell = Number.isFinite(n) ? formatTry(n) : "—";
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(r.store)}</td>
      <td>${escapeHtml(r.title)}</td>
      <td class="price">${priceCell}</td>
      <td><a href="${href}" target="_blank" rel="noopener noreferrer">Aç</a></td>
    `;
    tbody.appendChild(tr);
  });

  const typePart = meta.searchType ? ` · Tip: ${meta.searchType}` : "";
  if (onlyCheapest) {
    hint.textContent = `“${meta.query}”${typePart} — Tüm mağazalardan ${rawResults.length} sonuç içinden en düşük fiyatlı teklif.`;
  } else {
    const suffix = filtered.length ? " Tabloda en düşük fiyat vurgulandı." : "";
    hint.textContent = `“${meta.query}”${typePart} — ${filtered.length} ürün listeleniyor.${suffix}`;
  }
}

function resetFilters(): void {
  document.querySelectorAll<HTMLInputElement>('input[name="filter-store"]').forEach((el) => {
    el.checked = true;
  });
  if (categoryParent) categoryParent.selectedIndex = 0;
  populateCategorySub();
  priceMinEl.value = "";
  priceMaxEl.value = "";
  sortByEl.value = "price-asc";
  exactMatchEl.checked = false;
  if (titleFilterEl) titleFilterEl.value = "";
  if (onlyCheapestEl) onlyCheapestEl.checked = false;
  if (rawResults.length) renderTable();
}

function setAllStoreCheckboxes(checked: boolean): void {
  document.querySelectorAll<HTMLInputElement>('input[name="filter-store"]').forEach((el) => {
    el.checked = checked;
  });
}

function wireFilterListeners(): void {
  const rerender = () => {
    if (rawResults.length) renderTable();
  };
  storeSelectAllBtn.addEventListener("click", () => {
    setAllStoreCheckboxes(true);
    rerender();
  });
  storeClearAllBtn.addEventListener("click", () => {
    setAllStoreCheckboxes(false);
    rerender();
  });
  document.querySelectorAll('input[name="filter-store"]').forEach((el) => {
    el.addEventListener("change", rerender);
  });
  priceMinEl.addEventListener("input", rerender);
  priceMaxEl.addEventListener("input", rerender);
  sortByEl.addEventListener("change", rerender);
  onlyCheapestEl?.addEventListener("change", rerender);
  titleFilterEl?.addEventListener("input", rerender);

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const pmin = (chip as HTMLElement).dataset.pmin ?? "";
      const pmax = (chip as HTMLElement).dataset.pmax ?? "";
      priceMinEl.value = pmin;
      priceMaxEl.value = pmax;
      rerender();
    });
  });

  filterResetBtn.addEventListener("click", () => resetFilters());
}

initCategorySelects();
wireFilterListeners();

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = qInput.value.trim();
  if (!q) return;
  const selectedStores = [...getSelectedStores()];
  if (selectedStores.length === 0) {
    hint.textContent = "En az bir satıcı seçin (üstteki Satıcı / mağaza filtresi).";
    return;
  }
  const typeRaw = getSearchTypeForApi();
  const typeLabel = getCategoryDisplayLabel();
  rawResults = [];
  hint.textContent = "";
  filterNote.classList.add("hidden");
  renderErrors(undefined);
  setLoading(true);
  wrap.classList.add("hidden");
  const errorsAcc: { store: string; message: string }[] = [];

  try {
    const params = new URLSearchParams({ q });
    if (typeRaw !== undefined && typeRaw !== "") params.set("type", typeRaw);
    if (exactMatchEl.checked) params.set("exactMatch", "1");
    params.set("stores", selectedStores.join(","));
    if (priceMinEl.value.trim() !== "") params.set("priceMin", priceMinEl.value.trim());
    if (priceMaxEl.value.trim() !== "") params.set("priceMax", priceMaxEl.value.trim());
    const res = await fetch(apiUrl(`/api/search/stream?${params.toString()}`));
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error ?? res.statusText);
    }
    const body = res.body;
    if (!body) {
      throw new Error("Yanıt gövdesi okunamadı");
    }

    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    type NdjsonMsg = {
      type: string;
      store?: string;
      products?: Product[];
      message?: string;
      query?: string;
      searchType?: string;
    };

    const processNdjsonLine = (trimmed: string): void => {
      if (!trimmed) return;
      let msg: NdjsonMsg;
      try {
        msg = JSON.parse(trimmed) as NdjsonMsg;
      } catch {
        return;
      }
      if (msg.type === "store" && Array.isArray(msg.products)) {
        rawResults.push(...msg.products);
        lastMeta = { query: q, searchType: typeLabel ?? typeRaw };
        hint.textContent = `Sonuçlar geliyor… (${rawResults.length} ürün — mağazalar paralel sorgulanıyor)`;
        renderErrors(errorsAcc.length ? errorsAcc : undefined);
        renderTable();
        return;
      }
      if (msg.type === "error" && msg.store && msg.message) {
        errorsAcc.push({ store: msg.store, message: msg.message });
        renderErrors(errorsAcc);
        return;
      }
      if (msg.type === "done") {
        lastMeta = {
          query: msg.query ?? q,
          searchType: getCategoryDisplayLabel() ?? msg.searchType,
        };
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        processNdjsonLine(line.trim());
      }
    }

    try {
      buf += dec.decode();
    } catch {
      /* noop */
    }
    if (buf.trim()) {
      processNdjsonLine(buf.trim());
    }

    renderErrors(errorsAcc.length ? errorsAcc : undefined);
    renderTable();
  } catch (err) {
    hint.textContent = err instanceof Error ? err.message : "Bir hata oluştu.";
    wrap.classList.add("hidden");
    rawResults = [];
    lastMeta = { query: q, searchType: getCategoryDisplayLabel() ?? typeRaw };
  } finally {
    setLoading(false);
  }
});
