// GENPUKU Pro 協力業者ポータル：Stripe Connect の自動化（Cloudflare Workers・無料枠で動きます）
//
// できること（Refore 運営の作業なし）
//  1. POST /checkout        工務店が「カードで払う」を押したとき、金額ぴったりの Stripe 支払い画面を作る
//                           （工事代金は職人さんの Stripe アカウントへ、運営手数料は Refore へ自動で分ける）
//  2. POST /webhook         Stripe から「支払い完了」が届いたら、自動で発注を確定する（ポータルのデータを書き換える）
//  3. POST /connect/onboard 職人さんが自分で Stripe の受け取り登録をする（登録用の画面を作る）
//
// 秘密の値は Cloudflare の「Variables and Secrets」に入れる（このファイルには書かない）
//  STRIPE_SECRET_KEY      Stripe のシークレットキー（テストは sk_test_…）
//  STRIPE_WEBHOOK_SECRET  Stripe の Webhook の署名シークレット（whsec_…）
//  BOT_EMAIL / BOT_PASSWORD  ポータルの自動処理用アカウント（role: "op"）
//  FIREBASE_API_KEY       ポータルの index.html の FIREBASE_CONFIG.apiKey と同じ
//  FIREBASE_PROJECT_ID    shokunin-portal
//  PORTAL_URL             https://refore1111.github.io/shokunin-portal/
//  ALLOWED_ORIGIN         https://refore1111.github.io

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/webhook") return await webhook(req, env);
      if (req.method === "POST" && url.pathname === "/checkout") return json(await checkout(req, env), 200, cors);
      if (req.method === "POST" && url.pathname === "/connect/onboard") return json(await onboard(req, env), 200, cors);
      if (url.pathname === "/") return json({ ok: true, name: "genpuku-stripe" }, 200, cors);
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 400, cors);
    }
  },
};

const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...headers } });
const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };

/* ---------- Firebase（REST） ---------- */
// ログイン中の人を確かめる（ポータルから送られた ID トークン）
async function whoAmI(req, env) {
  const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok) fail("ログインしてください", 401);
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: tok }) });
  const d = await r.json();
  const u = d.users?.[0]; if (!u) fail("ログインの有効期限が切れました。もう一度ログインしてください", 401);
  return { uid: u.localId, email: u.email || "", token: tok };
}
// 自動処理用アカウント（運営）でログイン
let botCache = null;
async function botToken(env) {
  if (botCache && botCache.exp > Date.now() + 60000) return botCache.tok;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: env.BOT_EMAIL, password: env.BOT_PASSWORD, returnSecureToken: true }) });
  const d = await r.json(); if (!d.idToken) fail("自動処理用アカウントでログインできません: " + (d.error?.message || ""), 500);
  botCache = { tok: d.idToken, exp: Date.now() + Number(d.expiresIn || 3600) * 1000 };
  return botCache.tok;
}
const docsBase = env => `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const docName = (env, path) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
// Firestore の値 ⇔ ふつうの値
export function fromFs(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFs);
  return null;
}
export const fromFields = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, fromFs(v)]));
export function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
}
async function getDoc(env, path, token) {
  const r = await fetch(`${docsBase(env)}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  const d = await r.json(); if (d.error) fail(`読み込みできません（${path}）: ${d.error.message}`, r.status === 403 ? 403 : 400);
  return fromFields(d.fields);
}
// 書き込み：sets = 変える値、dels = 消す項目
export function updWrite(env, path, sets, dels = [], mustExist = true) {
  const w = { update: { name: docName(env, path), fields: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, toFs(v)])) },
    updateMask: { fieldPaths: [...Object.keys(sets), ...dels] } };
  if (mustExist) w.currentDocument = { exists: true };
  return w;
}
async function commit(env, writes, token) {
  const r = await fetch(`${docsBase(env)}:commit`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ writes }) });
  const d = await r.json(); if (d.error) fail("書き込みできません: " + d.error.message, 500);
  return d;
}
async function queryEq(env, coll, field, value, token) {
  const r = await fetch(`${docsBase(env)}:runQuery`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coll }], where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: toFs(value) } } } }) });
  const d = await r.json();
  return (Array.isArray(d) ? d : []).filter(x => x.document).map(x => ({ id: x.document.name.split("/").pop(), ...fromFields(x.document.fields) }));
}

/* ---------- Stripe ---------- */
// フォーム形式（a[b][c]=…）にする
export function form(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out); else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}
async function stripe(env, method, path, body) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" }, body: body ? form(body) : undefined });
  const d = await r.json(); if (d.error) fail("Stripe: " + d.error.message);
  return d;
}
// Stripe の新しい API（Accounts v2）：JSON で送る
const STRIPE_V2 = "2026-09-30.preview";
async function stripe2(env, method, path, body) {
  const r = await fetch(`https://api.stripe.com/v2/${path}`, { method, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": STRIPE_V2, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json(); if (d.error) fail("Stripe: " + (d.error.message || d.error.code || "error"));
  return d;
}
// 職人さんが工事代金を受け取れる状態か（Accounts v2 の recipient 設定）
async function transfersActive(env, acct) {
  const a = await stripe2(env, "GET", `core/accounts/${acct}?include=configuration.recipient`);
  return a?.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === "active";
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
// Stripe の署名を確かめる（なりすましの通知を受けないため）
export async function verifyStripeSig(raw, header, secret, now = Date.now()) {
  const parts = Object.fromEntries((header || "").split(",").map(x => x.split("=")).filter(x => x.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = (header || "").split(",").filter(x => x.trim().startsWith("v1=")).map(x => x.trim().slice(3));
  if (!parts.t || !sigs.length) return false;
  if (Math.abs(now / 1000 - Number(parts.t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${raw}`)));
  return sigs.includes(mac);
}

/* ---------- 1. 支払い画面を作る ---------- */
async function checkout(req, env) {
  const me = await whoAmI(req, env);
  const { payId } = await req.json().catch(() => ({}));
  if (!payId) fail("支払いが見つかりません");
  // 工務店本人の権限で読む（ほかの会社の支払いは読めない）
  const p = await getDoc(env, `payments/${payId}`, me.token);
  if (!p) fail("支払いが見つかりません");
  if (!["waiting", "reported"].includes(p.status)) fail("この支払いはもう済んでいます");
  const acct = ((await getDoc(env, "opdata/connect", me.token)) || {})[p.craftsmanId];
  if (!acct) fail("職人さんが Stripe の受け取り登録をまだしていません。振込でお支払いください");
  if (!(await transfersActive(env, acct))) fail("職人さんの Stripe の受け取り登録がまだ終わっていません。振込でお支払いいただくか、登録が終わるまでお待ちください");
  const total = Math.round(Number(p.total)), fee = Math.round(Number(p.fee));
  if (!(total > 0) || !(fee >= 0) || fee >= total) fail("金額が正しくありません");
  const back = `${env.PORTAL_URL}#/admin/job/${encodeURIComponent(p.jobId)}`;
  const s = await stripe(env, "POST", "checkout/sessions", {
    mode: "payment",
    line_items: { 0: { quantity: 1, price_data: { currency: "jpy", unit_amount: total,
      product_data: { name: `${p.jobTitle || "工事"}（工事代金＋運営手数料）`.slice(0, 120), description: `工事代金 ${p.amount}円は${p.craftsmanName || "職人"}さんへ、運営手数料 ${fee}円は株式会社Reforeへ` } } } },
    payment_intent_data: { application_fee_amount: fee, transfer_data: { destination: acct }, metadata: { payId, jobId: p.jobId, companyId: p.companyId } },
    metadata: { payId, jobId: p.jobId, companyId: p.companyId },
    client_reference_id: String(payId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 200),
    customer_email: me.email || undefined,
    success_url: back, cancel_url: back,
    locale: "ja",
  });
  // 支払い画面を作ったことを残す（自動処理用アカウントで）
  const bot = await botToken(env);
  await commit(env, [updWrite(env, `payments/${payId}`, { stripeSession: s.id, split: true, method: "stripe", sessionAt: Date.now() })], bot);
  return { url: s.url };
}

/* ---------- 2. 支払い完了 → 自動で発注を確定 ---------- */
async function webhook(req, env) {
  const raw = await req.text();
  if (!(await verifyStripeSig(raw, req.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET))) return new Response("bad signature", { status: 400 });
  const ev = JSON.parse(raw);
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(ev.type)) {
    const s = ev.data.object;
    if (s.payment_status === "paid" && s.metadata?.payId) await confirmPay(env, s.metadata.payId, s);
  }
  return new Response("ok");
}
export async function confirmPay(env, payId, s) {
  const bot = await botToken(env);
  const p = await getDoc(env, `payments/${payId}`, bot);
  if (!p || !["waiting", "reported"].includes(p.status)) return "skip";   // 2回届いても1回だけ
  if (Number(s.amount_total) !== Math.round(Number(p.total))) {           // 金額が合わないときは確定しない（運営が確認）
    await commit(env, [updWrite(env, `payments/${payId}`, { stripeMismatch: Number(s.amount_total), method: "stripe" })], bot);
    return "mismatch";
  }
  const now = Date.now(), uid = p.craftsmanId;
  const writes = [updWrite(env, `jobs/${p.jobId}`, { status: "assigned", assignedTo: uid, assignedAt: now, updatedAt: now, split: true }, ["selectedTo", "selectedAt"])];
  if (await getDoc(env, `documents/${p.jobId}_order`, bot)) writes.push(updWrite(env, `documents/${p.jobId}_order`, { status: "issued", issuedAt: now }));
  for (const a of await queryEq(env, "applications", "jobId", p.jobId, bot))
    if (["applied", "waiting"].includes(a.status)) writes.push(updWrite(env, `applications/${a.id}`, { status: a.craftsmanId === uid ? "selected" : "rejected", updatedAt: now }));
  writes.push(updWrite(env, `payments/${payId}`, { status: "held", confirmedAt: now, split: true, method: "stripe", auto: true, stripeSession: s.id || "", stripePI: s.payment_intent || "" }));
  await commit(env, writes, bot);
  return "ok";
}

/* ---------- 3. 職人さんの Stripe 受け取り登録 ---------- */
async function onboard(req, env) {
  const me = await whoAmI(req, env);
  const prof = await getDoc(env, `users/${me.uid}`, me.token);
  if (!prof || prof.role !== "craftsman" || prof.status !== "approved") fail("承認済みの協力業者だけが登録できます", 403);
  const bot = await botToken(env);
  let acct = ((await getDoc(env, "opdata/connect", bot)) || {})[me.uid];
  if (acct) {
    // 登録が済んでいれば、入金・振込を見る Stripe の画面へ
    if (await transfersActive(env, acct)) {
      try { const l = await stripe(env, "POST", `accounts/${acct}/login_links`, {}); return { url: l.url, done: true }; }
      catch (e) { return { url: null, done: true }; }   // 簡易ダッシュボードが開けないときは「登録済み」だけ返す
    }
  } else {
    // Accounts v2：受け取り専用（recipient）。Stripe が本人確認を集め、職人さんは簡易ダッシュボードで入金・振込を見る。手数料と損失は Refore 持ち
    const a = await stripe2(env, "POST", "core/accounts", {
      contact_email: me.email || undefined,
      display_name: prof.tradeName || prof.name || undefined,
      dashboard: "express",
      identity: { country: "jp" },
      defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } },
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
      metadata: { uid: me.uid },
    });
    acct = a.id;
    // opdata/connect の、この職人さんの1項目だけを書き換える（ほかの人の登録は消さない）
    await commit(env, [{ update: { name: docName(env, "opdata/connect"), fields: { [me.uid]: { stringValue: acct } } }, updateMask: { fieldPaths: [me.uid] } }], bot);
  }
  const back = `${env.PORTAL_URL}#/profile`;
  const l = await stripe2(env, "POST", "core/account_links", { account: acct, use_case: { type: "account_onboarding", account_onboarding: { configurations: ["recipient"], refresh_url: back, return_url: back } } });
  return { url: l.url, done: false };
}
