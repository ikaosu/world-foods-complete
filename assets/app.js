/* 世界料理制覇マップ — フロントエンド
 * data/countries.json (ISO2 -> {en, ja, un, ...}) と
 * data/posts.json (投稿配列) を読み、choropleth 世界地図を描画する。
 * 投稿モジュール(post.js)向けに window.WFM を公開する。
 */
(function () {
  "use strict";

  // 「世界」の分母。193カ国(国連加盟) + オブザーバー2 = 195 が一般的。お好みで調整可。
  const WORLD_COUNT = 195;

  const $ = (sel) => document.querySelector(sel);

  // 描画に使うデータをモジュールスコープに保持
  const state = { posts: [], byCode: new Map(), countries: {} };
  let mapInstance = null;

  // ---- ユーティリティ -------------------------------------------------
  function flagEmoji(code) {
    if (!code || code.length !== 2) return "🍽️";
    const cc = code.toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return "🍽️";
    return String.fromCodePoint(0x1f1e6 + cc.charCodeAt(0) - 65, 0x1f1e6 + cc.charCodeAt(1) - 65);
  }

  // 訪問数に応じた塗り色 (多く食べた国ほど濃いテラコッタ)
  function fillFor(n) {
    return n >= 5 ? "#8a4a30" : n >= 3 ? "#ad6247" : n >= 2 ? "#c07a5a" : "#d5a184";
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function getCSS(varName) {
    return (
      getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "#ece3d6"
    );
  }

  function mediaHTML(post, cls) {
    if (post.image) {
      return `<img class="${cls}" src="${esc(post.image)}" alt="${esc(post.country)}の料理" loading="lazy" />`;
    }
    return `<div class="card-ph">${flagEmoji(post.code)}</div>`;
  }

  function nameOf(code) {
    const c = state.countries[code];
    return c ? c.ja : code;
  }

  // ---- 国名リゾルバ（post.js からも利用） -----------------------------
  let resolverIndex = null;
  function buildResolver() {
    resolverIndex = new Map();
    const put = (k, code) => {
      const key = String(k || "").trim().toLowerCase();
      if (key && !resolverIndex.has(key)) resolverIndex.set(key, code);
    };
    for (const [code, c] of Object.entries(state.countries)) {
      put(code, code);
      put(c.en, code);
      put(c.ja, code);
      for (const a of c.alt || []) put(a, code);
    }
    const manual = { 英国: "GB", 米国: "US", 韓国: "KR", 台湾: "TW", 香港: "HK", uk: "GB", usa: "US", uae: "AE" };
    for (const [k, code] of Object.entries(manual)) put(k, code);
  }
  function resolveCountry(raw) {
    if (!resolverIndex) buildResolver();
    if (!raw) return null;
    let s = String(raw).trim().toLowerCase();
    if (resolverIndex.has(s)) return resolverIndex.get(s);
    s = s.replace(/[#＃「」『』()（）:：、。・\s]+/g, "");
    return resolverIndex.has(s) ? resolverIndex.get(s) : null;
  }

  // ---- データ読込 -----------------------------------------------------
  async function loadJSON(path, fallback) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (e) {
      console.warn("load failed:", path, e);
      return fallback;
    }
  }

  // ---- メイン ---------------------------------------------------------
  async function main() {
    const [countries, posts] = await Promise.all([
      loadJSON("data/countries.json", {}),
      loadJSON("data/posts.json", []),
    ]);
    state.countries = countries;
    state.posts = Array.isArray(posts) ? posts : [];
    buildResolver();

    setupSearch(); // イベント配線（1回だけ）
    setupModal();
    setupTheme();
    renderAll();

    // 投稿モジュール(post.js)向けの公開API
    window.WFM = {
      getCountries: () => state.countries,
      resolveCountry,
      flagEmoji,
      toast,
      hasPostId: (id) => state.posts.some((p) => p.id === id),
      addPostLive(post) {
        if (!post) return;
        if (post.id && state.posts.some((p) => p.id === post.id)) return;
        state.posts.push(post);
        renderAll();
      },
      updatePostLive(post) {
        if (!post || !post.id) return;
        const i = state.posts.findIndex((p) => p.id === post.id);
        if (i >= 0) state.posts[i] = post;
        else state.posts.push(post);
        renderAll();
      },
      removePostLive(id) {
        const before = state.posts.length;
        state.posts = state.posts.filter((p) => p.id !== id);
        if (state.posts.length !== before) renderAll();
      },
    };
    document.dispatchEvent(new Event("wfm:ready"));
  }

  function computeByCode() {
    const m = new Map();
    for (const p of state.posts) {
      if (!p.code) continue;
      const code = String(p.code).toUpperCase();
      if (!m.has(code)) m.set(code, []);
      m.get(code).push(p);
    }
    state.byCode = m;
  }

  // データ変更時にまとめて再描画
  function renderAll() {
    computeByCode();
    renderStats();
    renderMap();
    renderFeed();
    renderSearchResults();
    renderFooter();
  }

  // ---- 統計 -----------------------------------------------------------
  function renderStats() {
    const nCountries = state.byCode.size;
    const nDishes = state.posts.length;
    const pct = Math.round((nCountries / WORLD_COUNT) * 1000) / 10;
    $("#stat-countries").textContent = nCountries;
    $("#stat-percent").textContent = pct + "%";
    $("#stat-dishes").textContent = nDishes;
    requestAnimationFrame(() => {
      $("#progress-bar").style.width = Math.min(100, pct) + "%";
    });
  }

  // ---- 地図 -----------------------------------------------------------
  function renderMap() {
    const mapEl = document.getElementById("map");
    if (mapInstance && mapInstance.destroy) {
      try { mapInstance.destroy(); } catch (e) { /* noop */ }
    }
    mapInstance = null;
    mapEl.innerHTML = "";

    const byCode = state.byCode;
    if (typeof jsVectorMap === "undefined") {
      mapEl.innerHTML = '<p class="map-fallback">地図ライブラリを読み込めませんでした。</p>';
      return;
    }
    try {
      // eslint-disable-next-line no-undef
      mapInstance = new jsVectorMap({
        selector: "#map",
        map: "world",
        backgroundColor: "transparent",
        zoomButtons: true,
        zoomOnScroll: false,
        regionStyle: {
          initial: {
            fill: getCSS("--map-unvisited"),
            stroke: getCSS("--map-stroke"),
            "stroke-width": 0.6,
          },
          hover: { fillOpacity: 0.82, cursor: "pointer" },
        },
        onRegionTooltipShow(event, tooltip, code) {
          const list = byCode.get(code);
          const name = nameOf(code);
          if (list) {
            tooltip.text(`<strong>${flagEmoji(code)} ${esc(name)}</strong><br>食べた・${list.length}品`, true);
          } else {
            tooltip.text(`${esc(name)}<br><span style="opacity:.7">未食</span>`, true);
          }
        },
        onRegionClick(event, code) {
          const list = byCode.get(code);
          if (list && list.length) openModal(code, list, nameOf(code));
        },
      });

      // 訪問国を直接塗る (series は scale 必須で扱いにくいため setStyle で確実に着色)
      for (const [code, list] of byCode) {
        const region = mapInstance.regions[code];
        if (region && region.element && region.element.setStyle) {
          region.element.setStyle("fill", fillFor(list.length));
        }
      }
    } catch (e) {
      console.error("map init failed:", e);
      mapEl.innerHTML = '<p class="map-fallback">地図を初期化できませんでした。</p>';
    }
  }

  // ---- フィード -------------------------------------------------------
  function renderFeed() {
    const feed = $("#feed");
    const posts = state.posts;
    if (!posts.length) {
      feed.innerHTML = `<p class="feed-empty">まだ投稿がありません。</p>`;
      return;
    }
    const sorted = [...posts].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    feed.innerHTML = sorted
      .slice(0, 24)
      .map((p) => {
        const name = p.country || nameOf(p.code);
        const flag = flagEmoji(p.code);
        const title = p.dish ? esc(p.dish) : `${flag} ${esc(name)}`;
        const meta = p.dish
          ? `<span class="card-flag">${flag}</span>${esc(name)} ・ ${fmtDate(p.date)}`
          : fmtDate(p.date);
        return `
        <article class="card" data-code="${esc(p.code || "")}" tabindex="0">
          ${mediaHTML(p, "card-img")}
          <div class="card-body">
            <div class="card-dish">${title}</div>
            <div class="card-meta">${meta}</div>
            ${p.comment ? `<p class="card-comment">${esc(p.comment)}</p>` : ""}
          </div>
        </article>`;
      })
      .join("");

    feed.querySelectorAll(".card").forEach((el) => {
      const open = () => {
        const code = (el.getAttribute("data-code") || "").toUpperCase();
        if (!code) return;
        const list = state.posts.filter((p) => (p.code || "").toUpperCase() === code);
        const nm = list[0]?.country || nameOf(code);
        if (list.length) openModal(code, list, nm);
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });
  }

  // ---- 国さがし（検索） ----------------------------------------------
  const search = { q: "", filter: "all" };

  function buildCountryRows() {
    const rows = [];
    for (const [code, c] of Object.entries(state.countries)) {
      const list = state.byCode.get(code);
      rows.push({
        code,
        ja: c.ja || code,
        en: c.en || "",
        un: !!c.un,
        alt: c.alt || [],
        count: list ? list.length : 0,
      });
    }
    return rows;
  }

  function rowHTML(r) {
    const eaten = r.count > 0;
    const status = eaten ? `食べた・${r.count}品` : "未食";
    return `<button type="button" class="srow ${eaten ? "srow-eaten" : ""}" data-code="${r.code}" data-eaten="${eaten ? 1 : 0}">
      <span class="srow-flag">${flagEmoji(r.code)}</span>
      <span class="srow-name">${esc(r.ja)}<span class="srow-en">${esc(r.en)}</span></span>
      <span class="srow-status ${eaten ? "st-eaten" : "st-todo"}">${status}</span>
    </button>`;
  }

  function renderSearchResults() {
    const resultsEl = $("#search-results");
    const summaryEl = $("#search-summary");
    if (!resultsEl || !summaryEl) return;
    const allRows = buildCountryRows();
    const q = search.q.trim().toLowerCase();

    let rows = allRows;
    if (search.filter === "eaten") rows = rows.filter((r) => r.count > 0);
    else if (search.filter === "todo") rows = rows.filter((r) => r.count === 0 && r.un);

    if (q) {
      rows = rows.filter(
        (r) =>
          r.ja.toLowerCase().includes(q) ||
          r.en.toLowerCase().includes(q) ||
          r.code.toLowerCase() === q ||
          r.alt.some((a) => String(a).toLowerCase().includes(q))
      );
    }
    rows = rows.slice().sort((a, b) => b.count - a.count || a.ja.localeCompare(b.ja, "ja"));

    const eatenTotal = allRows.filter((r) => r.count > 0).length;
    summaryEl.textContent = `食べた ${eatenTotal} カ国 ／ 全 ${WORLD_COUNT} カ国`;

    // 既定表示（未検索・すべて）は「食べた国」だけ。250件のダンプを避ける
    let note = "";
    if (!q && search.filter === "all") {
      const eatenRows = rows.filter((r) => r.count > 0);
      if (eatenRows.length) {
        rows = eatenRows;
        note = `<p class="search-note">検索ボックスに入力すると、まだ食べていない国も探せます。</p>`;
      }
    }

    const CAP = 80;
    const shown = rows.slice(0, CAP);
    const more = rows.length - shown.length;

    resultsEl.innerHTML =
      (shown.length ? shown.map(rowHTML).join("") : `<p class="search-empty">該当する国がありません。</p>`) +
      (more > 0 ? `<p class="search-more">ほか ${more} カ国…（国名で絞り込んでください）</p>` : "") +
      note;

    resultsEl.querySelectorAll(".srow").forEach((el) => {
      el.addEventListener("click", () => {
        const code = el.getAttribute("data-code");
        const eaten = el.getAttribute("data-eaten") === "1";
        if (eaten) {
          const list = state.byCode.get(code);
          if (list) openModal(code, list, nameOf(code));
        } else {
          highlightRegion(code);
          toast(`${flagEmoji(code)} ${nameOf(code)} はまだ食べていません`);
        }
      });
    });
  }

  let searchWired = false;
  function setupSearch() {
    const input = $("#country-search");
    const chips = $("#filter-chips");

    const params = new URLSearchParams(location.search);
    if (params.get("q")) { search.q = params.get("q"); input.value = search.q; }
    const f = params.get("filter");
    if (f && ["all", "eaten", "todo"].includes(f)) search.filter = f;

    const applyChipUI = () =>
      chips.querySelectorAll(".chip").forEach((c) =>
        c.classList.toggle("is-active", c.getAttribute("data-filter") === search.filter)
      );
    applyChipUI();

    if (searchWired) return;
    searchWired = true;
    input.addEventListener("input", () => { search.q = input.value; renderSearchResults(); });
    chips.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        search.filter = chip.getAttribute("data-filter");
        applyChipUI();
        renderSearchResults();
      });
    });
  }

  // 地図上で該当国を一時的にハイライト（点滅）し、地図までスクロール
  function highlightRegion(code) {
    if (!mapInstance || !mapInstance.regions || !mapInstance.regions[code]) return;
    const el = mapInstance.regions[code].element;
    if (!el || !el.setStyle) return;
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
    const list = state.byCode.get(code);
    const resting = list ? fillFor(list.length) : getCSS("--map-unvisited");
    el.setStyle("fill", "#e0a24a");
    el.setStyle("stroke", "#5a3a26");
    el.setStyle("stroke-width", 1.6);
    setTimeout(() => {
      el.setStyle("fill", resting);
      el.setStyle("stroke", getCSS("--map-stroke"));
      el.setStyle("stroke-width", 0.6);
    }, 1700);
  }

  // ---- トースト -------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  // ---- モーダル -------------------------------------------------------
  function openModal(code, list, name) {
    const sorted = [...list].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    $("#modal-title").innerHTML =
      `${flagEmoji(code)} ${esc(name)} <span style="font-size:.7em;color:var(--ink-soft)">・${list.length}品</span>`;
    const admin = !!(window.WFMPost && window.WFMPost.isAdmin && window.WFMPost.isAdmin());
    $("#modal-body").innerHTML = sorted
      .map(
        (p) => `
      <div class="mpost">
        ${mediaHTML(p, "")}
        ${p.dish ? `<div class="mpost-dish">${esc(p.dish)}</div>` : ""}
        ${p.comment ? `<p class="mpost-comment">${esc(p.comment)}</p>` : ""}
        <div class="mpost-date">${fmtDate(p.date)}</div>
        ${admin ? `<div class="mpost-actions"><button type="button" class="mpost-btn mpost-edit">編集</button><button type="button" class="mpost-btn mpost-del">削除</button></div>` : ""}
      </div>`
      )
      .join("");
    if (admin) {
      $("#modal-body").querySelectorAll(".mpost").forEach((el, i) => {
        const p = sorted[i];
        const eb = el.querySelector(".mpost-edit");
        const db = el.querySelector(".mpost-del");
        if (eb) eb.addEventListener("click", () => window.WFMPost.editPost(p));
        if (db) db.addEventListener("click", () => window.WFMPost.deletePost(p));
      });
    }
    const modal = $("#modal");
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }

  let modalWired = false;
  function setupModal() {
    if (modalWired) return;
    modalWired = true;
    const modal = $("#modal");
    const close = () => { modal.hidden = true; document.body.style.overflow = ""; };
    $("#modal-close").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }

  // ---- フッター / テーマ ---------------------------------------------
  function renderFooter() {
    const latest = state.posts.map((p) => p.date).filter(Boolean).sort().pop();
    $("#footer-updated").textContent = latest ? `最終更新: ${fmtDate(latest)}` : "世界料理制覇マップ";
  }

  let themeWired = false;
  function setupTheme() {
    const KEY = "wfm-theme";
    const saved = localStorage.getItem(KEY);
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    if (themeWired) return;
    themeWired = true;
    $("#theme-toggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const isDark = cur ? cur === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
      const next = isDark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(KEY, next);
      renderMap(); // 初期塗り色(CSS変数)を反映
    });
  }

  document.addEventListener("DOMContentLoaded", main);
})();
