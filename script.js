document.addEventListener("DOMContentLoaded", function () {
  // (1) — NASTAV SI URL IKONKY FILTRU (volitelné)
  const FILTER_ICON_URL = "https://klubovna.lopourmedia.cz/wp-content/uploads/2025/08/Ikonka-filtr.png";

  const GOOGLE_SHEET_ID = "1j11Ep6FYZWm8YhhObSAI4afwv-ZNz8LyjejLl1504vQ";
  const SHEETS = ["půda", "sklad", "skříň - chodba", "2.np - velká", "garáž"];

  // (2) — OBRÁZKY PRO MÍSTNOSTI (base + číslo_sektoru + ext; pro výchozí použij `default`)
  const images = {
    puda: {
      base: "http://klubovna.lopourmedia.cz/wp-content/uploads/2025/07/puda-",
      ext: ".jpg",
      default: "https://klubovna.lopourmedia.cz/wp-content/uploads/2025/07/puda-default.jpg"
    },
    "2npvelka": {
      base: "http://klubovna.lopourmedia.cz/wp-content/uploads/2025/07/2np-velka-",
      ext: ".png",
      default: "https://klubovna.lopourmedia.cz/wp-content/uploads/2025/07/2np-velka-default.png"
    },
    skrinchodba: {
      base: "http://klubovna.lopourmedia.cz/wp-content/uploads/2025/07/Skrin-chodba-",
      ext: "-scaled.png",
      default: "https://klubovna.lopourmedia.cz/wp-content/uploads/2025/07/Skrin-chodba-default-scaled.png"
    },
    garaz: {
      base: "", ext: ""
      // default: "https://.../garaz-default.png"
    }
  };

  // Počty sektorů pro „Co je v…“
  const ROOM_SECTOR_COUNTS = {
    "půda": 24,
    "sklad": 18,
    "2.np - velká": 14,
    "skříň - chodba": 21,
    "garáž": 25
  };

  // Cache (5 min)
  const CACHE_KEY = "inventoryCache_v6";
  const CACHE_TTL = 5 * 60 * 1000;

  // ------- Pomocné funkce -------
  function capitalize(str) { return !str ? "" : str.charAt(0).toUpperCase() + str.slice(1).toLowerCase(); }
  function normalize(text) { return (text ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
  function mistnostToImageKey(text) { return normalize(text).replace(/[\s\-.]/g, ""); }

  // Fuzzy tolerance (Damerau–Levenshtein)
  function damerauLevenshtein(a, b) {
    const al = a.length, bl = b.length, INF = al + bl;
    const score = Array(al + 2).fill(null).map(() => Array(bl + 2).fill(0));
    const da = {};
    score[0][0] = INF;
    for (let i = 0; i <= al; i++) { score[i + 1][1] = i; score[i + 1][0] = INF; }
    for (let j = 0; j <= bl; j++) { score[1][j + 1] = j; score[0][j + 1] = INF; }
    for (let i = 1; i <= al; i++) {
      let db = 0;
      for (let j = 1; j <= bl; j++) {
        const i1 = da[b[j - 1]] || 0;
        const j1 = db;
        let cost = 1;
        if (a[i - 1] === b[j - 1]) { cost = 0; db = j; }
        score[i + 1][j + 1] = Math.min(
          score[i][j] + cost,
          score[i + 1][j] + 1,
          score[i][j + 1] + 1,
          score[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1)
        );
      }
      da[a[i - 1]] = i;
    }
    return score[al + 1][bl + 1];
  }
  function isFuzzyMatch(name, queryRaw) {
    const n = normalize(name), q = normalize(queryRaw);
    if (!q) return true;
    if (n.includes(q)) return true;
    const t = q.length <= 4 ? 1 : (q.length <= 8 ? 2 : 3);
    return damerauLevenshtein(n, q) <= t;
  }

  // 🔁 Odduplikování (společná funkce pro obě bubliny)
  function dedupe(items) {
    const seen = new Set(), out = [];
    for (const it of items) {
      const key = `${normalize(it.name)}|${normalize(it.mistnost)}|${String(it.sektor)}|${normalize(it.bedna||"")}`;
      if (!seen.has(key)) { seen.add(key); out.push(it); }
    }
    return out;
  }

  // ------- DOM (1. bublina) -------
  const input = document.getElementById("material-input");
  const button = document.getElementById("search-btn");
  const tbody = document.getElementById("result-tbody");
  const obrazekWrap = document.getElementById("obrazek-wrap");
  const noresultDiv = document.getElementById("noresult");
  const filterToggle = document.getElementById("filter-toggle");
  const filterContainer = document.getElementById("filter-container");
  const filterMistnost = document.getElementById("filter-mistnost");
  const filterSektor = document.getElementById("filter-sektor");

  // ------- DOM (2. bublina) -------
  const roomPicker = document.getElementById("room-picker");
  const roomImageWrap = document.getElementById("room-image-wrap");
  const sectorGrid = document.getElementById("sector-grid");
  const sectorResultTable = document.getElementById("sector-result-table");
  const sectorResultTbody = document.getElementById("sector-result-tbody");

  // Ikonka filtru
  (function initFilterIcon(){
    const icon = document.querySelector(".filter-icon");
    if (icon && FILTER_ICON_URL) icon.style.backgroundImage = `url('${FILTER_ICON_URL}')`;
  })();

  let debounceTimer = null;
  let inventoryCache = null;
  let filtersVisible = false;

  function setStatus(message, type) {
    noresultDiv.style.display = message ? "block" : "none";
    noresultDiv.textContent = message || "";
    noresultDiv.style.color = type === "error" ? "#b00" : "#111";
  }
  function showDefault() {
    tbody.innerHTML = "";
    obrazekWrap.innerHTML = "";
    noresultDiv.style.display = "none";
    noresultDiv.textContent = "";
  }

  // ------- Data z Google Sheets -------
  async function fetchOneSheet(sheetName) {
    const url = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} při načítání listu ${sheetName}`);
    const csv = await res.text();
    const rows = csv.trim().split("\n").map(r => (r.startsWith('"') && r.endsWith('"')) ? r.slice(1, -1).split('","') : r.split(","));
    const [header, ...dataRows] = rows;
    const idx = name => header.indexOf(name);
    return dataRows.map(r => ({
      name: r[idx("name")] ?? "",
      mistnost: r[idx("mistnost")] ?? "",
      sektor: r[idx("sektor")] ?? "",
      bedna: r[idx("bedna")] ?? ""
    })).filter(x => normalize(x.name) && normalize(x.mistnost));
  }
  async function fetchInventoryAllSheetsFresh() {
    const results = await Promise.all(SHEETS.map(s => fetchOneSheet(s).catch(()=>[])));
    return results.flat();
  }
  function saveCache(data) { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), d: data })); } catch {} }
  function loadCacheIfFresh() {
    try {
      const raw = localStorage.getItem(CACHE_KEY); if (!raw) return null;
      const { t, d } = JSON.parse(raw) || {};
      if (!t || !Array.isArray(d)) return null;
      if (Date.now() - t > CACHE_TTL) return null;
      return d;
    } catch { return null; }
  }
  async function ensureInventory() {
    if (inventoryCache) return inventoryCache;
    const cached = loadCacheIfFresh();
    if (cached) { inventoryCache = cached; return cached; }
    setStatus("Načítám…", "info");
    try {
      const fresh = await fetchInventoryAllSheetsFresh();
      inventoryCache = fresh; saveCache(fresh); setStatus("");
      if (filterMistnost && filterMistnost.options.length <= 1) populateFilters(fresh);
      return fresh;
    } catch (e) { setStatus("Nepodařilo se načíst data.", "error"); throw e; }
  }

  // ------- Filtry (1. bublina) -------
  function populateFilters(inv) {
    const mistnosti = Array.from(new Set(inv.map(x => x.mistnost).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'cs'));
    const sektory = Array.from(new Set(inv.map(x => x.sektor).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'cs'));
    filterMistnost.innerHTML = `<option value="__all">Vše</option>` + mistnosti.map(m => `<option value="${m}">${capitalize(m)}</option>`).join("");
    filterSektor.innerHTML   = `<option value="__all">Vše</option>` + sektory.map(s => `<option value="${s}">${s}</option>`).join("");
  }
  function resetFilters() { if (filterMistnost) filterMistnost.value="__all"; if (filterSektor) filterSektor.value="__all"; }
  function getActiveFilters() { return { mistnost: filterMistnost?.value || "__all", sektor: filterSektor?.value || "__all" }; }
  function applyFilters(arr) {
    const {mistnost,sektor}=getActiveFilters();
    return arr.filter(i => (mistnost==="__all"||i.mistnost===mistnost) && (sektor==="__all"||i.sektor===sektor));
  }

  // ------- Render (1. bublina) -------
  function renderResults(found) {
    const groups = {};
    found.forEach(item => {
      const key = (item.mistnost||"")+"_"+(item.sektor||"");
      if (!groups[key]) groups[key] = { items: [], mistnost: item.mistnost, sektor: item.sektor };
      groups[key].items.push(item);
    });

    // Tabulka
    const rowsHtml = Object.values(groups).map(g =>
      g.items.map(item => `
        <tr class="result-row" data-mistnost="${g.mistnost}" data-sektor="${g.sektor}">
          <td>${capitalize(item.name)}</td>
          <td>${capitalize(g.mistnost||"")}</td>
          <td>${g.sektor||""}</td>
          <td>${item.bedna ? capitalize(item.bedna) : ""}</td>
        </tr>`).join("")
    ).join("");
    tbody.innerHTML = rowsHtml;

    // Obrázky – všechny nalezené kombinace
    obrazekWrap.innerHTML = "";
    Object.values(groups).forEach(g => {
      const key = mistnostToImageKey(g.mistnost||"");
      const info = images[key];
      if (info && g.sektor) {
        const img = document.createElement("img");
        img.src = info.base + g.sektor + info.ext;
        img.alt = `${g.mistnost} – sektor ${g.sektor}`;
        img.className = "vetsi-obrazek";
        obrazekWrap.appendChild(img);
      }
    });
  }

  // ------- Hledání (1. bublina) -------
  async function doSearch() {
    const hledanoRaw = input.value || "";
    const hledano = normalize(hledanoRaw);
    if (!hledano) { showDefault(); return; }

    tbody.innerHTML = ""; obrazekWrap.innerHTML = ""; setStatus("Načítám…","info");
    try {
      const inv = await ensureInventory();
      let list = inv.filter(i =>
        i && i.name && i.mistnost &&
        (normalize(i.name).includes(hledano) || isFuzzyMatch(i.name, hledanoRaw))
      );
      if (filtersVisible) list = applyFilters(list);
      list = dedupe(list); // 🔁 odduplikovat

      if (list.length) { renderResults(list); setStatus(""); }
      else { showDefault(); setStatus("Upsík, tohle asi nemáme :-(", "error"); }
    } catch {
      showDefault();
      setStatus("Nepodařilo se načíst data. Zkuste to prosím později.", "error");
    }
  }

  // Toggle filtrů
  filterContainer.style.display = "none";
  filterToggle.addEventListener("click", () => {
    filtersVisible = !filtersVisible;
    filterContainer.style.display = filtersVisible ? "flex" : "none";
    filterToggle.setAttribute("aria-expanded", String(filtersVisible));
    if (!filtersVisible) { resetFilters(); if (input.value.trim()) doSearch(); }
    else { if (!inventoryCache) ensureInventory().catch(()=>{}); }
  });
  filterMistnost.addEventListener("change", () => { if (filtersVisible) doSearch(); });
  filterSektor.addEventListener("change", () => { if (filtersVisible) doSearch(); });
  input.addEventListener("input", () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(doSearch, 300); });
  input.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
  button.onclick = doSearch;

  // 🆕 Klik na řádek tabulky (1. bublina) → zobraz JEDEN náhled
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr.result-row");
    if (!tr) return;
    const mistnost = tr.dataset.mistnost;
    const sektor = tr.dataset.sektor;
    if (!mistnost || !sektor) return;
    const key = mistnostToImageKey(mistnost);
    const info = images[key];
    if (!info) return;

    obrazekWrap.innerHTML = "";
    const img = document.createElement("img");
    img.src = info.base + sektor + info.ext;
    img.alt = `${mistnost} – sektor ${sektor}`;
    img.className = "vetsi-obrazek";
    obrazekWrap.appendChild(img);
    obrazekWrap.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // ==================== 2. bublina: „Co je v…“ ====================

  // Výběr správného obrázku (sektor vs. default)
  function getRoomImageSrc(mistnost, sektor) {
    const key = mistnostToImageKey(mistnost);
    const info = images[key];
    if (!info || (!info.base && !info.default)) return null;
    if (sektor) return info.base + sektor + info.ext;   // zvýrazněný sektor
    if (info.default) return info.default;               // výchozí obrázek
    return info.base + "0" + info.ext;                  // fallback …-0…
  }

  function showRoomImage(mistnost, sektor = null) {
    roomImageWrap.innerHTML = "";
    const src = getRoomImageSrc(mistnost, sektor);
    if (!src) return;
    const img = document.createElement("img");
    img.src = src;
    img.alt = sektor
      ? `${mistnost} – zvýrazněný sektor ${sektor}`
      : `${mistnost} – rozložení sektorů`;
    img.className = "vetsi-obrazek";
    roomImageWrap.appendChild(img);
  }

  function renderSectorGridForRoom(mistnost) {
    const count = ROOM_SECTOR_COUNTS[mistnost.toLowerCase()] || ROOM_SECTOR_COUNTS[mistnost] || 24;
    sectorGrid.innerHTML = "";
    for (let i = 1; i <= count; i++) {
      const btn = document.createElement("button");
      btn.className = "sector-btn";
      btn.textContent = String(i);
      btn.dataset.sektor = String(i);
      sectorGrid.appendChild(btn);
    }
    sectorGrid.style.display = "grid";
  }

  async function showSectorContent(mistnost, sektor) {
    const inv = await ensureInventory();
    const list = inv.filter(x => normalize(x.mistnost) === normalize(mistnost) && String(x.sektor) === String(sektor));
    const items = dedupe(list);

    sectorResultTbody.innerHTML = items.map(it => `
      <tr>
        <td>${capitalize(it.name)}</td>
        <td>${capitalize(it.mistnost)}</td>
        <td>${it.sektor || ""}</td>
        <td>${it.bedna ? capitalize(it.bedna) : ""}</td>
      </tr>
    `).join("");
    sectorResultTable.style.display = items.length ? "table" : "none";
  }

  // Klik na místnost v horním „obdélníku“
  roomPicker.addEventListener("click", (e) => {
    const btn = e.target.closest(".room-cell");
    if (!btn) return;
    const mistnost = btn.dataset.room;

    showRoomImage(mistnost, null);         // default bez zvýraznění
    renderSectorGridForRoom(mistnost);     // počet sektorů dle místnosti
    sectorResultTable.style.display = "none";
    sectorResultTbody.innerHTML = "";
    sectorGrid.dataset.currentRoom = mistnost;
  });

  // Klik na sektor
  sectorGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".sector-btn");
    if (!btn) return;
    const sektor = btn.dataset.sektor;
    const mistnost = sectorGrid.dataset.currentRoom;
    if (!mistnost) return;

    showRoomImage(mistnost, sektor);
    showSectorContent(mistnost, sektor);
  });

  // Init
  showDefault();
});
