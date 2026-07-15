/* 世界料理制覇マップ — 投稿/編集/削除モジュール（管理者のみ）
 *
 * GitHub Contents API でブラウザから直接コミットする。
 * 管理者モード（localStorage: wfm-admin）のときだけ投稿UIを表示するので、
 * 一般の閲覧者には「＋投稿」ボタンも GitHub 設定も見えない。
 * 管理者モードは URL に #admin を付けて一度開くと、その端末で有効になる。
 * トークンはコードに埋め込まず、この端末の localStorage にのみ保存する。
 */
(function () {
  "use strict";

  const CFG_KEY = "wfm-gh";      // { owner, repo, branch, token }
  const ADMIN_KEY = "wfm-admin"; // "1" で管理者
  const HEIC_LIB = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
  const $ = (s, r = document) => r.querySelector(s);

  // ---- 管理者モード ---------------------------------------------------
  function isAdmin() { return localStorage.getItem(ADMIN_KEY) === "1"; }
  function enableAdmin() { localStorage.setItem(ADMIN_KEY, "1"); }
  function disableAdmin() { localStorage.removeItem(ADMIN_KEY); localStorage.removeItem(CFG_KEY); }

  // ---- 設定（localStorage） ------------------------------------------
  function loadCfg() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch (e) { /* noop */ }
    if ((!c.owner || !c.repo) && /\.github\.io$/.test(location.hostname)) {
      c.owner = c.owner || location.hostname.split(".")[0];
      const seg = location.pathname.split("/").filter(Boolean)[0];
      if (seg && !c.repo) c.repo = seg;
    }
    c.branch = c.branch || "main";
    return c;
  }
  function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

  // ---- 反映待ち控え（Pages デプロイラグ中も投稿が消えないように） -----
  const PENDING_KEY = "wfm-pending";
  function loadPending() {
    try { const a = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function savePending(arr) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(arr)); } catch (e) { /* noop */ }
  }
  function notePendingUpsert(post, imageRemote) {
    const arr = loadPending().filter((e) => !(e.post && e.post.id === post.id) && e.id !== post.id);
    arr.push({ type: "add", post, imageRemote, savedAt: Date.now() });
    savePending(arr);
  }
  function notePendingDelete(id) {
    const arr = loadPending().filter((e) => !(e.post && e.post.id === id) && e.id !== id);
    arr.push({ type: "del", id, savedAt: Date.now() });
    savePending(arr);
  }

  // ---- base64 / UTF-8 ------------------------------------------------
  function bytesToB64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
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

  // ---- 画像デコード & リサイズ（検証済み） ---------------------------
  function loadScriptOnce(src, globalName) {
    if (window[globalName]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("script load failed: " + src));
      document.head.appendChild(s);
    });
  }
  async function looksLikeHeic(file) {
    if (/image\/hei[cf]/i.test(file.type || "")) return true;
    if (/\.(heic|heif)$/i.test(file.name || "")) return true;
    try {
      const b = new Uint8Array(await file.slice(0, 32).arrayBuffer());
      if (b.length >= 12 && String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") {
        const brands = String.fromCharCode.apply(null, b.subarray(8, 32));
        if (/heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1|heif/i.test(brands)) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  async function heicToJpeg(file) {
    await withTimeout(loadScriptOnce(HEIC_LIB, "heic2any"), 60000, "変換ライブラリの読み込み");
    const out = await withTimeout(window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 }), 90000, "画像の変換");
    return Array.isArray(out) ? out[0] : out;
  }
  async function decodeImage(blob) {
    try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch (e) { /* next */ }
    try { return await createImageBitmap(blob); } catch (e) { /* next */ }
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.decoding = "async";
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("img decode failed")); };
      img.src = url;
    });
  }
  async function resizeImage(file, maxDim = 1600, quality = 0.85) {
    let blob = file, src = null;
    if (await looksLikeHeic(file)) {
      try { blob = await heicToJpeg(file); } catch (e) { blob = file; }
    }
    try {
      src = await decodeImage(blob);
    } catch (e) {
      if (blob === file) {
        try { blob = await heicToJpeg(file); src = await decodeImage(blob); }
        catch (e2) { throw Object.assign(new Error("decode failed: " + (e2.message || e2)), { code: "IMAGE_DECODE" }); }
      } else {
        throw Object.assign(new Error("decode failed: " + (e.message || e)), { code: "IMAGE_DECODE" });
      }
    }
    let width = src.naturalWidth || src.width;
    let height = src.naturalHeight || src.height;
    if (!width || !height) throw Object.assign(new Error("no dimensions"), { code: "IMAGE_DECODE" });
    const scale = Math.min(1, maxDim / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(src, 0, 0, width, height);
    const outBlob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    if (!outBlob) throw Object.assign(new Error("encode failed"), { code: "IMAGE_DECODE" });
    return new Uint8Array(await outBlob.arrayBuffer());
  }

  // ---- タイムアウト --------------------------------------------------
  function withTimeout(promise, ms, label) {
    let t;
    const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error((label || "処理") + "がタイムアウトしました")), ms); });
    return Promise.race([promise, to]).finally(() => clearTimeout(t));
  }
  async function fetchT(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 45000);
    try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
    finally { clearTimeout(t); }
  }

  // ---- GitHub API ----------------------------------------------------
  function ghHeaders(cfg) {
    return { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" };
  }
  async function ghGet(cfg, path) {
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${cfg.branch}`;
    const res = await fetchT(url, { headers: ghHeaders(cfg), cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw ghErr(res, `GET ${path}`);
    return res.json();
  }
  async function ghPut(cfg, path, contentB64, message, sha) {
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
    const body = { message, content: contentB64, branch: cfg.branch };
    if (sha) body.sha = sha;
    const res = await fetchT(url, {
      method: "PUT",
      headers: Object.assign(ghHeaders(cfg), { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await ghErrAsync(res, `PUT ${path}`);
    return res.json();
  }
  async function ghDelete(cfg, path) {
    const cur = await ghGet(cfg, path);
    if (!cur || !cur.sha) return;
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
    const res = await fetchT(url, {
      method: "DELETE",
      headers: Object.assign(ghHeaders(cfg), { "Content-Type": "application/json" }),
      body: JSON.stringify({ message: `delete ${path}`, sha: cur.sha, branch: cfg.branch }),
    });
    if (!res.ok) throw await ghErrAsync(res, `DELETE ${path}`);
  }
  function ghErr(res, label) {
    const e = new Error(`${label} → ${res.status}`);
    e.status = res.status;
    return e;
  }
  async function ghErrAsync(res, label) {
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch (e) { /* noop */ }
    const e = new Error(`${label} → ${res.status} ${detail}`);
    e.status = res.status;
    return e;
  }

  // posts.json を GET→反映→PUT（作成・編集の両対応、sha競合は1回再試行）
  async function upsertPost(cfg, post, attempt = 0) {
    const cur = await ghGet(cfg, "data/posts.json");
    let posts = [];
    let sha;
    if (cur && cur.content) {
      try { posts = JSON.parse(b64ToUtf8(cur.content)); } catch (e) { posts = []; }
      sha = cur.sha;
    }
    const i = posts.findIndex((p) => p.id === post.id);
    if (i >= 0) posts[i] = post; else posts.push(post);
    posts.sort((a, b) => (a.date || "").localeCompare(b.date || "") || String(a.id).localeCompare(String(b.id)));
    try {
      await ghPut(cfg, "data/posts.json", utf8ToB64(JSON.stringify(posts, null, 2) + "\n"),
        `post: ${post.country}${post.dish ? " / " + post.dish : ""}`, sha);
    } catch (e) {
      if (e.status === 409 && attempt < 2) return upsertPost(cfg, post, attempt + 1);
      throw e;
    }
  }
  async function removePost(cfg, id, attempt = 0) {
    const cur = await ghGet(cfg, "data/posts.json");
    if (!cur || !cur.content) return;
    let posts = [];
    try { posts = JSON.parse(b64ToUtf8(cur.content)); } catch (e) { posts = []; }
    const next = posts.filter((p) => p.id !== id);
    try {
      await ghPut(cfg, "data/posts.json", utf8ToB64(JSON.stringify(next, null, 2) + "\n"), `delete post ${id}`, cur.sha);
    } catch (e) {
      if (e.status === 409 && attempt < 2) return removePost(cfg, id, attempt + 1);
      throw e;
    }
  }

  // ---- UI 構築（管理者のみ） -----------------------------------------
  let pickedFile = null;
  let editingPost = null;
  // 写真を選んだ瞬間から裏で変換・リサイズを始める(入力中に処理を終わらせる)
  let processedPromise = null;
  let processedBytes = null;

  function buildUI() {
    const fab = document.createElement("button");
    fab.id = "fab-post";
    fab.className = "fab";
    fab.type = "button";
    fab.textContent = "＋ 投稿";
    document.body.appendChild(fab);

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="modal-backdrop" id="post-modal" hidden>
        <div class="modal post-modal">
          <button class="modal-close" id="post-close" aria-label="閉じる">×</button>
          <h3 id="pf-title">料理を投稿</h3>
          <form id="post-form" autocomplete="off">
            <input type="file" id="pf-photo" accept="image/*" hidden />
            <button type="button" class="pf-drop" id="pf-drop"><span>📷 写真を選ぶ</span></button>
            <input id="pf-country" list="pf-countries" placeholder="国名（例: イタリア / Italy / IT）" />
            <datalist id="pf-countries"></datalist>
            <div class="pf-resolved" id="pf-resolved"></div>
            <input id="pf-dish" placeholder="料理名（例: カルボナーラ）" />
            <textarea id="pf-comment" rows="3" placeholder="コメント（任意）"></textarea>
            <div class="pf-status" id="pf-status" aria-live="polite"></div>
            <div class="pf-actions">
              <button type="button" id="pf-settings-toggle" class="pf-link">⚙ 設定</button>
              <button type="submit" id="pf-submit" class="pf-submit">投稿する</button>
            </div>
            <div class="pf-settings" id="pf-settings" hidden>
              <p class="pf-hint">トークンはこの端末にのみ保存されます。<br>
                fine-grained PAT（対象リポジトリの <b>Contents: Read and write</b>）または classic の <b>repo</b> スコープ。</p>
              <input id="pf-owner" placeholder="GitHubユーザー名" />
              <input id="pf-repo" placeholder="リポジトリ名" />
              <input id="pf-branch" placeholder="ブランチ（既定 main）" />
              <input id="pf-token" type="password" placeholder="アクセストークン" />
              <button type="button" id="pf-save-settings" class="pf-submit pf-secondary">設定を保存</button>
              <button type="button" id="pf-logout" class="pf-link pf-danger">この端末の管理者モードを解除</button>
            </div>
          </form>
        </div>
      </div>`;
    document.body.appendChild(wrap.firstElementChild);
    wireUI(fab);
  }

  function populateCountries() {
    const dl = $("#pf-countries");
    if (!dl || dl.childElementCount || !window.WFM) return;
    const countries = window.WFM.getCountries();
    const frag = document.createDocumentFragment();
    for (const [, c] of Object.entries(countries)) {
      const o = document.createElement("option");
      o.value = c.ja;
      frag.appendChild(o);
    }
    dl.appendChild(frag);
  }

  function setStatus(msg) {
    const el = $("#pf-status");
    if (el) el.textContent = msg || "";
  }

  function wireUI(fab) {
    const modal = $("#post-modal");
    const close = () => { modal.hidden = true; document.body.style.overflow = ""; setStatus(""); };
    fab.addEventListener("click", () => openPostModal(null));
    $("#post-close").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

    const photoInput = $("#pf-photo");
    const drop = $("#pf-drop");
    drop.addEventListener("click", () => photoInput.click());
    photoInput.addEventListener("change", () => {
      pickedFile = photoInput.files[0] || null;
      if (!pickedFile) return;
      const url = URL.createObjectURL(pickedFile);
      const img = new Image();
      img.alt = "プレビュー";
      img.onload = () => { drop.innerHTML = ""; drop.appendChild(img); };
      img.onerror = () => { drop.textContent = "✓ 選択済み: " + pickedFile.name; };
      img.src = url;

      // 先行処理: 入力している間に変換・リサイズを済ませる
      // (クラウドにしか実体がない写真などで読めない場合に固まらないようタイムアウト付き)
      const f = pickedFile;
      processedBytes = null;
      setStatus("写真を準備中…（そのまま入力を続けてOK）");
      processedPromise = withTimeout(resizeImage(f), 120000, "写真の準備");
      processedPromise
        .then((bytes) => {
          if (pickedFile !== f) return; // 別の写真に差し替え済みなら無視
          processedBytes = bytes;
          setStatus("✓ 写真の準備ができました");
        })
        .catch(() => {
          if (pickedFile !== f) return;
          setStatus("⚠ この写真を読み込めません。別の写真を選ぶか、そのまま投稿で再試行できます。");
          processedPromise = null; // 投稿時に最初からやり直す
        });
    });

    const countryInput = $("#pf-country");
    const resolved = $("#pf-resolved");
    countryInput.addEventListener("input", () => {
      if (!countryInput.value.trim()) { resolved.textContent = ""; return; }
      const code = window.WFM && window.WFM.resolveCountry(countryInput.value);
      resolved.innerHTML = code
        ? `<span class="ok">${window.WFM.flagEmoji(code)} ${window.WFM.getCountries()[code].ja} として登録</span>`
        : `<span class="ng">国名を認識できません</span>`;
    });

    $("#pf-settings-toggle").addEventListener("click", () => {
      const s = $("#pf-settings");
      s.hidden = !s.hidden;
    });
    $("#pf-save-settings").addEventListener("click", () => {
      saveCfg({
        owner: $("#pf-owner").value.trim(),
        repo: $("#pf-repo").value.trim(),
        branch: $("#pf-branch").value.trim() || "main",
        token: $("#pf-token").value.trim(),
      });
      toast("設定を保存しました");
      $("#pf-settings").hidden = true;
    });
    $("#pf-logout").addEventListener("click", () => {
      if (confirm("この端末の管理者モードを解除しますか？（保存したトークンも消えます）")) {
        disableAdmin();
        location.reload();
      }
    });

    $("#post-form").addEventListener("submit", (e) => { e.preventDefault(); submitPost(close); });
  }

  function resetFormFields() {
    pickedFile = null;
    processedPromise = null;
    processedBytes = null;
    $("#pf-country").value = "";
    $("#pf-dish").value = "";
    $("#pf-comment").value = "";
    $("#pf-resolved").textContent = "";
    $("#pf-drop").innerHTML = "<span>📷 写真を選ぶ</span>";
    const pi = $("#pf-photo"); if (pi) pi.value = "";
  }

  function prefillSettings() {
    const cfg = loadCfg();
    if (!$("#pf-owner").value) $("#pf-owner").value = cfg.owner || "";
    if (!$("#pf-repo").value) $("#pf-repo").value = cfg.repo || "";
    if (!$("#pf-branch").value) $("#pf-branch").value = cfg.branch || "main";
    if (!$("#pf-token").value) $("#pf-token").value = cfg.token || "";
    if (!cfg.token || !cfg.owner || !cfg.repo) $("#pf-settings").hidden = false;
  }

  function openPostModal(post) {
    editingPost = post || null;
    populateCountries();
    prefillSettings();
    $("#pf-title").textContent = editingPost ? "投稿を編集" : "料理を投稿";
    $("#pf-submit").textContent = editingPost ? "更新する" : "投稿する";
    setStatus("");
    if (editingPost) {
      resetFormFields();
      $("#pf-country").value = editingPost.country || "";
      $("#pf-dish").value = editingPost.dish || "";
      $("#pf-comment").value = editingPost.comment || "";
      $("#pf-country").dispatchEvent(new Event("input"));
      const drop = $("#pf-drop");
      if (editingPost.image) drop.innerHTML = `<img src="${editingPost.image}" alt="現在の写真" />`;
    } else {
      resetFormFields();
    }
    $("#post-modal").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function toast(msg) {
    if (window.WFM && window.WFM.toast) window.WFM.toast(msg);
    else console.log(msg);
  }

  function requireCfg() {
    const cfg = loadCfg();
    cfg.owner = ($("#pf-owner") && $("#pf-owner").value.trim()) || cfg.owner;
    cfg.repo = ($("#pf-repo") && $("#pf-repo").value.trim()) || cfg.repo;
    cfg.branch = ($("#pf-branch") && $("#pf-branch").value.trim()) || cfg.branch || "main";
    cfg.token = ($("#pf-token") && $("#pf-token").value.trim()) || cfg.token;
    if (!cfg.owner || !cfg.repo || !cfg.token) {
      if ($("#pf-settings")) $("#pf-settings").hidden = false;
      toast("先に ⚙設定 で GitHub のユーザー名・リポジトリ・トークンを入力してください");
      return null;
    }
    saveCfg(cfg);
    return cfg;
  }

  function errMsg(e) {
    if (e && e.code === "IMAGE_DECODE") return "画像を読み込めませんでした。別の写真か JPEG/PNG でお試しください。";
    let hint = "";
    if (e && (e.status === 401 || e.status === 403)) hint = "（トークンの権限を確認）";
    if (e && e.status === 404) hint = "（ユーザー名・リポジトリ名を確認）";
    return String((e && e.message) || e).slice(0, 90) + hint;
  }

  // ---- 投稿（作成・編集） --------------------------------------------
  async function submitPost(closeModal) {
    const cfg = requireCfg();
    if (!cfg) return;
    if (!editingPost && !pickedFile) { toast("写真を選んでください"); return; }
    const code = window.WFM.resolveCountry($("#pf-country").value);
    if (!code) { toast("国名を認識できません（例: イタリア / Italy / IT）"); return; }

    const submitBtn = $("#pf-submit");
    const origLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    try {
      const country = window.WFM.getCountries()[code].ja;
      const id = editingPost ? editingPost.id : `web-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      let image = editingPost ? editingPost.image : null;
      let oldImage = null;
      let imageRemote = editingPost ? editingPost.imageRemote : null;
      let imageLocal = null;

      if (pickedFile) {
        // 選択時に始めた先行処理を使う(済んでいれば待ちゼロ)
        let bytes = processedBytes;
        if (!bytes) {
          setStatus((await looksLikeHeic(pickedFile)) ? "画像を変換中…（初回は少し時間がかかります）" : "画像を処理中…");
          submitBtn.textContent = "処理中…";
          bytes = await (processedPromise || resizeImage(pickedFile));
        }
        setStatus("写真をアップロード中…");
        const imgPath = `images/${id}-${Date.now()}.jpg`;
        const putRes = await ghPut(cfg, imgPath, bytesToB64(bytes), `photo: ${country}`);
        if (editingPost && editingPost.image) oldImage = editingPost.image;
        image = imgPath;
        // Pages 反映前でも表示できるソースを控えておく
        const sha = putRes && putRes.commit && putRes.commit.sha;
        imageRemote = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${sha || cfg.branch}/${imgPath}`;
        imageLocal = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      }

      setStatus(editingPost ? "更新中…" : "投稿を保存中…");
      submitBtn.textContent = editingPost ? "更新中…" : "保存中…";
      const post = {
        id,
        code,
        country,
        dish: $("#pf-dish").value.trim(),
        comment: $("#pf-comment").value.trim(),
        image,
        date: editingPost ? editingPost.date : new Date().toISOString(),
        source: editingPost ? (editingPost.source || "web") : "web",
        rev: Date.now(), // 反映確認用のリビジョン
      };
      await upsertPost(cfg, post);

      // 差し替え前の画像を後始末（best-effort）
      if (oldImage && oldImage.startsWith("images/")) {
        try { await ghDelete(cfg, oldImage); } catch (e) { /* ignore */ }
      }

      // 反映待ち控えを保存し、画面には即時ソース付きで反映
      notePendingUpsert(post, imageRemote);
      const livePost = Object.assign({}, post, { pending: true, imageRemote, imageLocal });
      if (editingPost) window.WFM.updatePostLive(livePost);
      else window.WFM.addPostLive(livePost);

      setStatus("");
      toast(`${window.WFM.flagEmoji(code)} ${country} を${editingPost ? "更新" : "投稿"}しました（サイト全体への反映は1〜2分）`);
      // 国別モーダルが開いていたら閉じる
      const cm = document.getElementById("modal");
      if (cm) { cm.hidden = true; }
      editingPost = null;
      resetFormFields();
      closeModal();
    } catch (e) {
      console.error(e);
      setStatus("");
      toast((editingPost ? "更新" : "投稿") + "に失敗: " + errMsg(e));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = origLabel;
    }
  }

  async function editPost(post) { openPostModal(post); }

  async function deletePost(post) {
    if (!post) return;
    if (!confirm(`「${post.country}${post.dish ? " / " + post.dish : ""}」を削除しますか？`)) return;
    const cfg = requireCfg();
    if (!cfg) return;
    toast("削除中…");
    try {
      await removePost(cfg, post.id);
      if (post.image && String(post.image).startsWith("images/")) {
        try { await ghDelete(cfg, post.image); } catch (e) { /* ignore */ }
      }
      notePendingDelete(post.id); // 反映ラグ中の再読込でも復活しないように
      window.WFM.removePostLive(post.id);
      const cm = document.getElementById("modal");
      if (cm) { cm.hidden = true; document.body.style.overflow = ""; }
      toast("削除しました");
    } catch (e) {
      console.error(e);
      toast("削除に失敗: " + errMsg(e));
    }
  }

  // ---- 初期化 --------------------------------------------------------
  function init() {
    // URL に #admin があれば管理者モードを有効化してハッシュを消す
    if (/admin/i.test(location.hash)) {
      enableAdmin();
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* noop */ }
    }
    window.WFMPost = { isAdmin, editPost, deletePost };
    if (isAdmin()) buildUI();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
