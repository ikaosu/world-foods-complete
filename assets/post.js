/* 世界料理制覇マップ — サイトからの投稿モジュール
 *
 * GitHub Pages（バックエンドなし）で投稿を実現するため、
 * ブラウザから GitHub Contents API で直接コミットする。
 *  - 画像を images/ に PUT（アップ前にリサイズ）
 *  - data/posts.json を GET→追記→PUT
 * トークンはコードに埋め込まず、この端末の localStorage にのみ保存する
 * （＝公開サイトのソースには出ないので、閲覧者は投稿できない）。
 */
(function () {
  "use strict";

  const CFG_KEY = "wfm-gh"; // { owner, repo, branch, token }
  const $ = (s, r = document) => r.querySelector(s);

  // ---- 設定（localStorage） ------------------------------------------
  function loadCfg() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch (e) { /* noop */ }
    // github.io ホストなら owner / repo を自動推定
    if ((!c.owner || !c.repo) && /\.github\.io$/.test(location.hostname)) {
      c.owner = c.owner || location.hostname.split(".")[0];
      const seg = location.pathname.split("/").filter(Boolean)[0];
      if (seg && !c.repo) c.repo = seg;
    }
    c.branch = c.branch || "main";
    return c;
  }
  function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

  // ---- base64 / UTF-8 変換 -------------------------------------------
  function bytesToB64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(String(b64).replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  const utf8ToB64 = (str) => bytesToB64(new TextEncoder().encode(str));
  const b64ToUtf8 = (b64) => new TextDecoder().decode(b64ToBytes(b64));

  // ---- 画像リサイズ ---------------------------------------------------
  async function resizeImage(file, maxDim = 1600, quality = 0.85) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      bitmap = await createImageBitmap(file);
    }
    let { width, height } = bitmap;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    return new Uint8Array(await blob.arrayBuffer());
  }

  // ---- GitHub API ----------------------------------------------------
  function ghHeaders(cfg) {
    return { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" };
  }
  async function ghGet(cfg, path) {
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${cfg.branch}`;
    const res = await fetch(url, { headers: ghHeaders(cfg), cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
  }
  async function ghPut(cfg, path, contentB64, message, sha) {
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
    const body = { message, content: contentB64, branch: cfg.branch };
    if (sha) body.sha = sha;
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...ghHeaders(cfg), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).message || ""; } catch (e) { /* noop */ }
      const err = new Error(`PUT ${path} → ${res.status} ${detail}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // posts.json を GET→追記→PUT（sha 競合時は1回だけ再試行）
  async function appendPost(cfg, post, attempt = 0) {
    const cur = await ghGet(cfg, "data/posts.json");
    let posts = [];
    let sha;
    if (cur && cur.content) {
      try { posts = JSON.parse(b64ToUtf8(cur.content)); } catch (e) { posts = []; }
      sha = cur.sha;
    }
    if (!posts.some((p) => p.id === post.id)) posts.push(post);
    posts.sort((a, b) => (a.date || "").localeCompare(b.date || "") || String(a.id).localeCompare(String(b.id)));
    const content = utf8ToB64(JSON.stringify(posts, null, 2) + "\n");
    try {
      await ghPut(cfg, "data/posts.json", content, `post: ${post.country}${post.dish ? " / " + post.dish : ""}`, sha);
    } catch (e) {
      if (e.status === 409 && attempt < 1) return appendPost(cfg, post, attempt + 1);
      throw e;
    }
  }

  // ---- UI 構築 --------------------------------------------------------
  function buildUI() {
    const fab = document.createElement("button");
    fab.id = "fab-post";
    fab.className = "fab";
    fab.type = "button";
    fab.innerHTML = "＋ 投稿";
    document.body.appendChild(fab);

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="modal-backdrop" id="post-modal" hidden>
        <div class="modal post-modal">
          <button class="modal-close" id="post-close" aria-label="閉じる">×</button>
          <h3>料理を投稿</h3>
          <form id="post-form" autocomplete="off">
            <input type="file" id="pf-photo" accept="image/*" hidden />
            <button type="button" class="pf-drop" id="pf-drop"><span>📷 写真を選ぶ</span></button>
            <input id="pf-country" list="pf-countries" placeholder="国名（例: イタリア / Italy / IT）" />
            <datalist id="pf-countries"></datalist>
            <div class="pf-resolved" id="pf-resolved"></div>
            <input id="pf-dish" placeholder="料理名（例: カルボナーラ）" />
            <textarea id="pf-comment" rows="3" placeholder="コメント（任意）"></textarea>
            <div class="pf-actions">
              <button type="button" id="pf-settings-toggle" class="pf-link">⚙ GitHub設定</button>
              <button type="submit" id="pf-submit" class="pf-submit">投稿する</button>
            </div>
            <div class="pf-settings" id="pf-settings" hidden>
              <p class="pf-hint">トークンはこの端末のブラウザにのみ保存されます。<br>
                fine-grained PAT（対象リポジトリの <b>Contents: Read and write</b>）を推奨。</p>
              <input id="pf-owner" placeholder="GitHubユーザー名" />
              <input id="pf-repo" placeholder="リポジトリ名" />
              <input id="pf-branch" placeholder="ブランチ（既定 main）" />
              <input id="pf-token" type="password" placeholder="アクセストークン (github_pat_... / ghp_...)" />
              <button type="button" id="pf-save-settings" class="pf-submit pf-secondary">設定を保存</button>
            </div>
          </form>
        </div>
      </div>`;
    document.body.appendChild(wrap.firstElementChild);

    wireUI(fab);
  }

  let pickedFile = null;

  function populateCountries() {
    const dl = $("#pf-countries");
    if (!dl || dl.childElementCount || !window.WFM) return;
    const countries = window.WFM.getCountries();
    const frag = document.createDocumentFragment();
    for (const [code, c] of Object.entries(countries)) {
      const o = document.createElement("option");
      o.value = c.ja;
      o.label = `${c.ja} (${c.en})`;
      frag.appendChild(o);
    }
    dl.appendChild(frag);
  }

  function wireUI(fab) {
    const modal = $("#post-modal");
    const open = () => {
      populateCountries();
      prefillSettings();
      modal.hidden = false;
      document.body.style.overflow = "hidden";
    };
    const close = () => { modal.hidden = true; document.body.style.overflow = ""; };
    fab.addEventListener("click", open);
    $("#post-close").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

    // 写真選択 + プレビュー
    const photoInput = $("#pf-photo");
    const drop = $("#pf-drop");
    drop.addEventListener("click", () => photoInput.click());
    photoInput.addEventListener("change", () => {
      pickedFile = photoInput.files[0] || null;
      if (pickedFile) {
        const url = URL.createObjectURL(pickedFile);
        drop.innerHTML = `<img src="${url}" alt="プレビュー" />`;
      }
    });

    // 国名の解決プレビュー
    const countryInput = $("#pf-country");
    const resolved = $("#pf-resolved");
    countryInput.addEventListener("input", () => {
      const code = window.WFM && window.WFM.resolveCountry(countryInput.value);
      if (!countryInput.value.trim()) { resolved.textContent = ""; return; }
      resolved.innerHTML = code
        ? `<span class="ok">${window.WFM.flagEmoji(code)} ${window.WFM.getCountries()[code].ja} として登録</span>`
        : `<span class="ng">国名を認識できません</span>`;
    });

    // 設定
    $("#pf-settings-toggle").addEventListener("click", () => {
      const s = $("#pf-settings");
      s.hidden = !s.hidden;
    });
    $("#pf-save-settings").addEventListener("click", () => {
      const cfg = {
        owner: $("#pf-owner").value.trim(),
        repo: $("#pf-repo").value.trim(),
        branch: $("#pf-branch").value.trim() || "main",
        token: $("#pf-token").value.trim(),
      };
      saveCfg(cfg);
      toast("GitHub設定を保存しました");
      $("#pf-settings").hidden = true;
    });

    $("#post-form").addEventListener("submit", (e) => { e.preventDefault(); submitPost(close); });
  }

  function prefillSettings() {
    const cfg = loadCfg();
    if (!$("#pf-owner").value) $("#pf-owner").value = cfg.owner || "";
    if (!$("#pf-repo").value) $("#pf-repo").value = cfg.repo || "";
    if (!$("#pf-branch").value) $("#pf-branch").value = cfg.branch || "main";
    if (!$("#pf-token").value) $("#pf-token").value = cfg.token || "";
    // 未設定なら設定を開いておく
    if (!cfg.token || !cfg.owner || !cfg.repo) $("#pf-settings").hidden = false;
  }

  function toast(msg) {
    if (window.WFM && window.WFM.toast) window.WFM.toast(msg);
    else console.log(msg);
  }

  // ---- 投稿実行 -------------------------------------------------------
  async function submitPost(closeModal) {
    const cfg = loadCfg();
    // フォームの最新設定値も反映
    cfg.owner = $("#pf-owner").value.trim() || cfg.owner;
    cfg.repo = $("#pf-repo").value.trim() || cfg.repo;
    cfg.branch = $("#pf-branch").value.trim() || cfg.branch || "main";
    cfg.token = $("#pf-token").value.trim() || cfg.token;

    if (!cfg.owner || !cfg.repo || !cfg.token) {
      $("#pf-settings").hidden = false;
      toast("先に GitHub 設定（ユーザー名・リポジトリ・トークン）を入力してください");
      return;
    }
    if (!pickedFile) { toast("写真を選んでください"); return; }
    const code = window.WFM.resolveCountry($("#pf-country").value);
    if (!code) { toast("国名を認識できません（例: イタリア / Italy / IT）"); return; }

    const submitBtn = $("#pf-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "投稿中…";
    try {
      const bytes = await resizeImage(pickedFile);
      const id = `web-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const imgPath = `images/${id}.jpg`;
      const country = window.WFM.getCountries()[code].ja;

      await ghPut(cfg, imgPath, bytesToB64(bytes), `post: ${country} の写真`);

      const post = {
        id,
        code,
        country,
        dish: $("#pf-dish").value.trim(),
        comment: $("#pf-comment").value.trim(),
        image: imgPath,
        date: new Date().toISOString(),
        source: "web",
      };
      await appendPost(cfg, post);

      saveCfg(cfg); // 成功した設定を保存
      window.WFM.addPostLive(post); // その場で地図・フィードに反映
      toast(`${window.WFM.flagEmoji(code)} ${country} を投稿しました（数十秒で公開版にも反映）`);
      resetForm();
      closeModal();
    } catch (e) {
      console.error(e);
      let hint = "";
      if (e.status === 401 || e.status === 403) hint = "（トークンの権限を確認してください）";
      if (e.status === 404) hint = "（ユーザー名・リポジトリ名を確認してください）";
      toast("投稿に失敗: " + String(e.message || e).slice(0, 70) + hint);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "投稿する";
    }
  }

  function resetForm() {
    pickedFile = null;
    $("#post-form").reset();
    $("#pf-drop").innerHTML = "<span>📷 写真を選ぶ</span>";
    $("#pf-resolved").textContent = "";
  }

  document.addEventListener("DOMContentLoaded", buildUI);
})();
