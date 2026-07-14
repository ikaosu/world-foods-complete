/* Discord -> サイト 同期スクリプト
 *
 * 指定チャンネルのメッセージを読み、画像付き投稿を data/posts.json に取り込む。
 * 画像は images/ に再ホスト(Discord CDN の URL は失効するため)。
 *
 * 必要な環境変数:
 *   DISCORD_BOT_TOKEN   … Bot トークン
 *   DISCORD_CHANNEL_ID  … 取り込み対象チャンネルの ID
 *   MAX_HISTORY         … 初回に遡る最大件数 (任意, 既定 800)
 *
 * メッセージ書式:  1行目 = 国名 / 2行目以降 = コメント / 画像を1枚以上添付
 *
 * 依存パッケージなし。Node 18+ (グローバル fetch) で動作。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const IMG_DIR = path.join(ROOT, "images");
const POSTS_PATH = path.join(DATA_DIR, "posts.json");
const COUNTRIES_PATH = path.join(DATA_DIR, "countries.json");
const STATE_PATH = path.join(DATA_DIR, ".sync-state.json");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL = process.env.DISCORD_CHANNEL_ID;
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "800", 10);
const API = "https://discord.com/api/v10";

// 日本語カジュアル名の補完 (データセットで拾えない口語表記)
const MANUAL_ALIASES = {
  英国: "GB", 米国: "US", 米: "US",
  韓国: "KR", 南朝鮮: "KR", 北朝鮮: "KP",
  台湾: "TW", 香港: "HK", マカオ: "MO",
  uk: "GB", usa: "US", uae: "AE",
};

function die(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

// ---- 国名リゾルバ -----------------------------------------------------
function buildResolver(countries) {
  const idx = new Map();
  const put = (key, code) => {
    const k = String(key || "").trim().toLowerCase();
    if (k && !idx.has(k)) idx.set(k, code);
  };
  for (const [code, c] of Object.entries(countries)) {
    put(code, code);        // ISO2
    put(c.en, code);        // 英語名
    put(c.ja, code);        // 日本語名
    for (const a of c.alt || []) put(a, code); // 別表記・ISO3 等
  }
  for (const [k, code] of Object.entries(MANUAL_ALIASES)) put(k, code);

  return function resolve(raw) {
    if (!raw) return null;
    let s = String(raw).trim().toLowerCase();
    if (idx.has(s)) return idx.get(s);
    // 記号・助詞を落として再挑戦
    s = s.replace(/[#＃「」『』()（）:：、。・\s]+/g, "");
    if (idx.has(s)) return idx.get(s);
    return null;
  };
}

// ---- Discord 取得 -----------------------------------------------------
async function apiGet(params) {
  const url = new URL(`${API}/channels/${CHANNEL}/messages`);
  url.searchParams.set("limit", "100");
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bot ${TOKEN}` } });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const wait = Math.ceil((body.retry_after || 1) * 1000) + 250;
    console.warn(`  rate limited, wait ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    return apiGet(params);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    die(`Discord API ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json(); // newest-first の配列
}

async function fetchAfter(lastId) {
  // lastId より新しいメッセージを時系列で前進取得
  const out = [];
  let after = lastId;
  for (let page = 0; page < 30; page++) {
    const batch = await apiGet({ after });
    if (!batch.length) break;
    out.push(...batch);
    after = batch[0].id; // batch は newest-first なので先頭が最新
    if (batch.length < 100) break;
  }
  return out;
}

async function fetchLatest(cap) {
  // 初回: 現在から過去へ遡って取得
  const out = [];
  let before;
  for (let page = 0; page < 30 && out.length < cap; page++) {
    const batch = await apiGet({ before });
    if (!batch.length) break;
    out.push(...batch);
    before = batch[batch.length - 1].id; // 末尾が最古
    if (batch.length < 100) break;
  }
  return out;
}

// ---- 添付画像 ---------------------------------------------------------
function pickImage(msg) {
  for (const att of msg.attachments || []) {
    const ct = att.content_type || "";
    const isImg = ct.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(att.filename || "");
    if (isImg) return att;
  }
  return null;
}

function extFor(att) {
  const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(att.filename || "");
  let ext = (m ? m[1] : (att.content_type || "").split("/")[1] || "jpg").toLowerCase();
  if (ext === "jpeg") ext = "jpg";
  return ext.replace(/[^a-z0-9]/g, "") || "jpg";
}

async function downloadImage(att, id) {
  const ext = extFor(att);
  const rel = `images/${id}.${ext}`;
  const dest = path.join(ROOT, "images", `${id}.${ext}`);
  if (existsSync(dest)) return rel;
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`image download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return rel;
}

// ---- 本体 -------------------------------------------------------------
async function loadJSON(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch { return fallback; }
}

function bigMax(a, b) {
  if (!a) return b;
  if (!b) return a;
  return BigInt(a) > BigInt(b) ? a : b;
}

async function main() {
  if (!TOKEN) die("DISCORD_BOT_TOKEN が未設定です");
  if (!CHANNEL) die("DISCORD_CHANNEL_ID が未設定です");

  const countries = await loadJSON(COUNTRIES_PATH, {});
  if (!Object.keys(countries).length) die("data/countries.json が読めません");
  const resolve = buildResolver(countries);

  const posts = await loadJSON(POSTS_PATH, []);
  const existingIds = new Set(posts.map((p) => p.id));
  const state = await loadJSON(STATE_PATH, {});

  await mkdir(IMG_DIR, { recursive: true });

  console.log(`同期開始 (既存 ${posts.length} 件, lastId=${state.lastId || "なし"})`);
  const messages = state.lastId
    ? await fetchAfter(state.lastId)
    : await fetchLatest(MAX_HISTORY);
  console.log(`取得 ${messages.length} 件のメッセージ`);

  // 時系列昇順で処理
  messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  let added = 0, skipped = 0, unresolved = 0;
  let maxId = state.lastId || null;

  for (const msg of messages) {
    maxId = bigMax(maxId, msg.id);
    if (existingIds.has(msg.id)) continue;
    if (msg.author?.bot) { skipped++; continue; }

    const att = pickImage(msg);
    if (!att) { skipped++; continue; } // 写真必須

    const lines = (msg.content || "").split(/\r?\n/).map((l) => l.trim());
    const countryRaw = lines[0] || "";
    const comment = lines.slice(1).join("\n").trim();
    const code = resolve(countryRaw);
    if (!code) {
      unresolved++;
      console.warn(`  ⚠ 国名を解決できず: "${countryRaw}" (msg ${msg.id}) — code=null で保存`);
    }

    let image = null;
    try {
      image = await downloadImage(att, msg.id);
    } catch (e) {
      console.warn(`  ⚠ 画像DL失敗 (msg ${msg.id}): ${e.message}`);
    }

    posts.push({
      id: msg.id,
      code: code,
      country: code ? countries[code].ja : countryRaw,
      comment,
      image,
      date: msg.timestamp, // ISO8601
      source: "discord",
    });
    existingIds.add(msg.id);
    added++;
    console.log(`  ＋ ${code || "??"} ${code ? countries[code].ja : countryRaw} — ${comment.slice(0, 24)}`);
  }

  // 昇順で安定保存
  posts.sort((a, b) => (a.date || "").localeCompare(b.date || "") || String(a.id).localeCompare(String(b.id)));
  await writeFile(POSTS_PATH, JSON.stringify(posts, null, 2) + "\n");
  await writeFile(
    STATE_PATH,
    JSON.stringify({ lastId: maxId, updatedAt: new Date().toISOString() }, null, 2) + "\n"
  );

  console.log(`完了: 追加 ${added} / スキップ ${skipped} / 国名未解決 ${unresolved} / 合計 ${posts.length}`);
  // GitHub Actions 用の出力 (差分があるかどうか)
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `added=${added}\n`, { flag: "a" });
  }
}

main().catch((e) => die(e.stack || e.message));
