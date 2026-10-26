// GENPUKU Pro 協力業者ポータル：Stripe Connect の自動化（Cloudflare Workers・無料枠で動きます）
//
// できること（Refore 運営の作業なし）
//  1. POST /checkout        工務店が「カードで払う」を押したとき、金額ぴったりの Stripe 支払い画面を作る
//                           （工事代金は職人さんの Stripe アカウントへ、運営手数料は Refore へ自動で分ける）
//  2. POST /webhook         Stripe から「支払い完了」が届いたら、自動で発注を確定する（ポータルのデータを書き換える）
//  3. POST /connect/onboard 職人さんが自分で Stripe の受け取り登録をする（登録用の画面を作る）
//  4. POST /sub             工務店の月額（プラン・オプション・追加枠）を、ポータルのボタンから直接変える
//                           （はじめての有料プランだけ Stripe の画面でカード登録。あとは登録済みのカードで自動。運営の確認なし）
//     Webhook で受けるもの：checkout.session.completed / invoice.paid / customer.subscription.deleted
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
      if (req.method === "POST" && url.pathname === "/sub") return json(await sub(req, env), 200, cors);
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
    if (s.metadata?.kind === "sub" && s.subscription) await subStarted(env, s);
    if (s.metadata?.kind === "extra" && s.payment_status === "paid") await extraPaid(env, s);
  }
  if (ev.type === "invoice.paid") await subRenewed(env, ev.data.object);
  if (ev.type === "customer.subscription.deleted") await subEnded(env, ev.data.object);
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
    // 前に作ったアカウントが、今の Stripe（キーを入れ替えたときなど）に無ければ作り直す
    let active = false;
    try { active = await transfersActive(env, acct); } catch (e) { if (/no such|not found|resource_missing|does not exist|permission denied|does not have permission/i.test(e.message)) acct = null; else throw e; }
    if (acct && active) {
      try { const l = await stripe(env, "POST", `accounts/${acct}/login_links`, {}); return { url: l.url, done: true }; }
      catch (e) { return { url: null, done: true }; }   // 簡易ダッシュボードが開けないときは「登録済み」だけ返す
    }
  }
  if (!acct) {
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
  const l = await stripe2(env, "POST", "core/account_links", { account: acct, use_case: { type: "account_onboarding", account_onboarding: { refresh_url: back, return_url: back } } });
  return { url: l.url, done: false };
}

/* ---------- 4. 工務店の月額（プラン・オプション・追加枠） ---------- */
// ポータルの OP_DEFAULT と同じ（運営の「設定」で金額を変えていれば、そちらを使う）
const PLAN_KEYS = ["free", "beginner", "pro", "master"];
const PLAN_INCL = { free: [], beginner: [], pro: ["calendar", "money", "docs"], master: ["calendar", "money", "docs", "staff"] };
const DEF_FEES = { plans: { free: 0, beginner: 980, pro: 4980, master: 14800 }, opt: 1000, member: 1000, extra: 1000 };
const NAMES = { beginner: "ビギナープラン", pro: "プロプラン", master: "マスタープラン", calendar: "オプション：予定表カレンダー自動反映", money: "オプション：収支閲覧",
  docs: "オプション：工事メモ・見積書・管理会社請求書作成", staff: "オプション：従業員追加（1人あたり）", extra: "案件追加（1件）" };
const OPT_KEYS = ["calendar", "money", "docs", "staff"];
const ymJst = (ms = Date.now()) => new Date(ms + 9 * 3600000).toISOString().slice(0, 7);
async function fees(env, bot) {
  const o = (await getDoc(env, "opdata/settings", bot)) || {};
  const plans = Object.fromEntries(PLAN_KEYS.map(k => [k, Number(o.plans?.[k]?.price ?? DEF_FEES.plans[k]) || 0]));
  return { plans, opt: Number(o.moneyFee) || DEF_FEES.opt, member: Number(o.memberFee) || DEF_FEES.member, extra: Number(o.extraFee) || DEF_FEES.extra };
}
const amountOf = (f, key) => PLAN_KEYS.includes(key) ? f.plans[key] : key === "staff" ? f.member : key === "extra" ? f.extra : f.opt;
// Stripe の価格（lookup_key で探し、無ければ作る。商品は同じ名前のものがあれば使う）
export async function priceFor(env, key, amount) {
  const recurring = key !== "extra", lk = `gp_${key}_${amount}`;
  const found = await stripe(env, "GET", `prices?active=true&limit=1&lookup_keys[]=${encodeURIComponent(lk)}`);
  if (found.data?.[0]) return found.data[0].id;
  let product = null;
  try { const q = await stripe(env, "GET", `products/search?query=${encodeURIComponent(`active:'true' AND name:'${NAMES[key]}'`)}`); product = q.data?.[0]?.id || null; } catch (e) { product = null; }
  const p = await stripe(env, "POST", "prices", { currency: "jpy", unit_amount: amount, lookup_key: lk, ...(recurring ? { recurring: { interval: "month" } } : {}),
    ...(product ? { product } : { product_data: { name: NAMES[key] } }) });
  return p.id;
}
const keyOfItem = i => { const m = /^gp_([a-z]+)_\d+$/.exec(i?.price?.lookup_key || ""); return m ? m[1] : ""; };
const periodEnd = s => 1000 * Number(s.current_period_end || s.items?.data?.[0]?.current_period_end || 0);
const cardOf = s => { const c = s.default_payment_method?.card; return c ? `${(c.brand || "card").replace(/^./, x => x.toUpperCase())} ****${c.last4}` : ""; };
// プランを変えたときの会社の値（含まれるオプションは外す）
export function planUpd(c, key) {
  const opts = { ...(c.opts || {}) }, upd = { plan: key, nextPlan: null };
  (PLAN_INCL[key] || []).forEach(k => { if (k === "money") upd.money = false; else delete opts[k]; });
  upd.opts = opts; return upd;
}
async function sub(req, env) {
  const me = await whoAmI(req, env);
  const body = await req.json().catch(() => ({}));
  const bot = await botToken(env);
  const prof = await getDoc(env, `users/${me.uid}`, bot);
  if (!prof || prof.role !== "co" || prof.coRole !== "管理者" || prof.status !== "approved" || !prof.companyId) fail("会社の管理者だけが変更できます", 403);
  const cid = prof.companyId, c = await getDoc(env, `companies/${cid}`, bot);
  if (!c) fail("会社が見つかりません");
  return await subChange(env, bot, cid, c, body, me.email);
}
export async function subChange(env, bot, cid, c, { op, key, t, k } = {}, email = "") {
  const f = await fees(env, bot), back = `${env.PORTAL_URL}#/admin/plan`, save = upd => commit(env, [updWrite(env, `companies/${cid}`, upd)], bot);
  let s = c.stripeSub ? await stripe(env, "GET", `subscriptions/${c.stripeSub}`).catch(() => null) : null;
  if (s && ["canceled", "incomplete_expired"].includes(s.status)) s = null;
  const items = s ? s.items.data : [], itemOf = x => items.find(i => keyOfItem(i) === x), planItem = items.find(i => PLAN_KEYS.includes(keyOfItem(i)));
  const curPlan = PLAN_KEYS.includes(c.plan) ? c.plan : "free", upd0 = s ? { nextBill: periodEnd(s) } : {};
  const subPost = b => stripe(env, "POST", `subscriptions/${s.id}`, b);
  if (op === "down") { op = t === "plan" ? "plan" : "optoff"; key = k; }
  if (op === "plan") {
    if (!PLAN_KEYS.includes(key)) fail("プランが正しくありません");
    if (key === curPlan && !c.nextPlan) return { done: true };
    if (f.plans[key] === 0) {
      if (!s) { await save(planUpd(c, "free")); return { done: true, msg: "無料プランにしました" }; }
      await subPost({ cancel_at_period_end: true });
      await save({ ...upd0, nextPlan: "free" }); return { done: true, msg: "次の請求日から無料プランになります" };
    }
    const price = await priceFor(env, key, f.plans[key]);
    if (!s) {   // はじめての有料プラン：Stripe の画面でカードを登録して申し込む
      const cs = await stripe(env, "POST", "checkout/sessions", { mode: "subscription", line_items: { 0: { price, quantity: 1 } },
        ...(c.stripeCustomer ? { customer: c.stripeCustomer } : { customer_email: email || undefined }),
        client_reference_id: cid, metadata: { cid, kind: "sub", plan: key }, subscription_data: { metadata: { cid } },
        success_url: `${back}/paid`, cancel_url: back, locale: "ja" });
      return { url: cs.url };
    }
    const up = f.plans[key] > f.plans[curPlan];
    const its = { 0: planItem ? { id: planItem.id, price } : { price, quantity: 1 } };
    let n = 1; if (up) items.filter(i => (PLAN_INCL[key] || []).includes(keyOfItem(i))).forEach(i => { its[n++] = { id: i.id, deleted: true }; });
    await subPost({ items: its, proration_behavior: up ? "create_prorations" : "none", cancel_at_period_end: false });
    if (up) { await save({ ...upd0, ...planUpd(c, key) }); return { done: true, msg: `${NAMES[key]}に変更しました（今月分は日割りで次回の請求に足します）` }; }
    await save({ ...upd0, nextPlan: key }); return { done: true, msg: "次の請求日からプランが切り替わります" };
  }
  if (op === "opt") {
    if (!OPT_KEYS.includes(key)) fail("オプションが正しくありません");
    if (!s || !f.plans[curPlan]) fail("オプションは有料プランの方だけが使えます。先にプランを変更してください");
    if ((PLAN_INCL[curPlan] || []).includes(key)) fail("このオプションは今のプランに含まれています");
    const it = itemOf(key), price = await priceFor(env, key, amountOf(f, key));
    if (it && key !== "staff") fail("もう使っています");
    await subPost({ items: { 0: it ? { id: it.id, quantity: Number(it.quantity || 1) + 1 } : { price, quantity: 1 } }, proration_behavior: "create_prorations" });
    const opts = { ...(c.opts || {}) }, optEnd = { ...(c.optEnd || {}) }; delete optEnd[key];
    const upd = { ...upd0, optEnd };
    if (key === "money") upd.money = true; else { opts[key] = key === "staff" ? (Number(opts.staff) || 0) + 1 : true; upd.opts = opts; }
    await save(upd); return { done: true, msg: `${NAMES[key].replace("オプション：", "")}を追加しました` };
  }
  if (op === "optoff") {   // オプションをやめる：次の請求日から（それまでは使える）
    if (!s) fail("月額のお申し込みがありません");
    const it = itemOf(key); if (!it) fail("このオプションは使っていません");
    const q = Number(it.quantity || 1);
    await subPost({ items: { 0: key === "staff" && q > 1 ? { id: it.id, quantity: q - 1 } : { id: it.id, deleted: true } }, proration_behavior: "none" });
    const optEnd = { ...(c.optEnd || {}), [key]: key === "staff" ? Number(c.optEnd?.staff || 0) + 1 : periodEnd(s) };
    await save({ ...upd0, optEnd }); return { done: true, msg: "次の請求日からやめます（それまでは使えます）" };
  }
  if (op === "undo") {   // 予約していた変更を取り消す
    if (!s) fail("月額のお申し込みがありません");
    if (t === "plan") {
      if (c.nextPlan === "free") await subPost({ cancel_at_period_end: false });
      else if (planItem) await subPost({ items: { 0: { id: planItem.id, price: await priceFor(env, curPlan, f.plans[curPlan]) } }, proration_behavior: "none" });
      await save({ ...upd0, nextPlan: null }); return { done: true, msg: "予約していた変更を取り消しました" };
    }
    const it = itemOf(k), price = await priceFor(env, k, amountOf(f, k));
    await subPost({ items: { 0: it ? { id: it.id, quantity: Number(it.quantity || 1) + 1 } : { price, quantity: 1 } }, proration_behavior: "none" });
    const optEnd = { ...(c.optEnd || {}) }; delete optEnd[k];
    await save({ ...upd0, optEnd }); return { done: true, msg: "予約していた変更を取り消しました" };
  }
  if (op === "extra") {
    const price = await priceFor(env, "extra", f.extra), ym = ymJst();
    if (s) {   // 登録済みのカードで、次の請求に足す
      await stripe(env, "POST", "invoiceitems", { customer: s.customer, price, subscription: s.id, description: `${NAMES.extra}（${ym}）` });
      const extra = { ...(c.extra || {}) }; extra[ym] = Number(extra[ym] || 0) + 1;
      await save({ ...upd0, extra }); return { done: true, msg: "追加枠を1件買いました（次回の請求に足します）" };
    }
    const cs = await stripe(env, "POST", "checkout/sessions", { mode: "payment", line_items: { 0: { price, quantity: 1 } },
      ...(c.stripeCustomer ? { customer: c.stripeCustomer } : { customer_email: email || undefined, customer_creation: "always" }),
      client_reference_id: cid, metadata: { cid, kind: "extra", ym }, success_url: `${back}/paid`, cancel_url: back, locale: "ja" });
    return { url: cs.url };
  }
  fail("操作が正しくありません");
}
// はじめての有料プランの申し込みが済んだ
export async function subStarted(env, cs) {
  const bot = await botToken(env), cid = cs.metadata?.cid; if (!cid) return "skip";
  const c = await getDoc(env, `companies/${cid}`, bot); if (!c) return "skip";
  if (c.stripeSub === cs.subscription && c.plan === cs.metadata.plan) return "skip";
  const s = await stripe(env, "GET", `subscriptions/${cs.subscription}?expand[]=default_payment_method`);
  const upd = { ...planUpd(c, cs.metadata.plan), stripeSub: s.id, stripeCustomer: s.customer, nextBill: periodEnd(s), optEnd: {} };
  const card = cardOf(s); if (card) upd.card = card;
  await commit(env, [updWrite(env, `companies/${cid}`, upd, ["pendingPay"])], bot);
  return "ok";
}
// 追加枠（無料プランの人がカードで買った）
export async function extraPaid(env, cs) {
  const bot = await botToken(env), cid = cs.metadata?.cid; if (!cid) return "skip";
  const c = await getDoc(env, `companies/${cid}`, bot); if (!c || c.lastExtraSession === cs.id) return "skip";
  const ym = cs.metadata.ym || ymJst(), extra = { ...(c.extra || {}) }; extra[ym] = Number(extra[ym] || 0) + 1;
  const upd = { extra, lastExtraSession: cs.id }; if (cs.customer && !c.stripeCustomer) upd.stripeCustomer = cs.customer;
  await commit(env, [updWrite(env, `companies/${cid}`, upd)], bot);
  return "ok";
}
async function companyOfSub(env, bot, subId) { return subId ? (await queryEq(env, "companies", "stripeSub", subId, bot))[0] || null : null; }
// 毎月の更新（請求が済んだ）：予約していたプランの変更・オプションの終了を反映し、次回の請求日を進める
export async function subRenewed(env, inv) {
  const subId = inv.subscription || inv.parent?.subscription_details?.subscription; if (!subId) return "skip";
  const bot = await botToken(env), c = await companyOfSub(env, bot, subId); if (!c) return "skip";
  const end = 1000 * Number(inv.lines?.data?.[0]?.period?.end || 0), upd = end ? { nextBill: end } : {};
  if (inv.billing_reason === "subscription_cycle") {
    let base = c;
    if (c.nextPlan && c.nextPlan !== "free") { Object.assign(upd, planUpd(c, c.nextPlan)); base = { ...c, ...upd }; }
    const ends = Object.keys(c.optEnd || {}).filter(k => c.optEnd[k]);
    if (ends.length) {
      const opts = { ...(base.opts || {}) };
      ends.forEach(k => { if (k === "money") upd.money = false; else if (k === "staff") opts.staff = Math.max(0, (Number(opts.staff) || 0) - Number(c.optEnd.staff || 0)); else delete opts[k]; });
      upd.opts = opts; upd.optEnd = {};
    }
  }
  if (!Object.keys(upd).length) return "skip";
  await commit(env, [updWrite(env, `companies/${c.id}`, upd)], bot);
  return "ok";
}
// 解約（次の請求日に終わった）：無料プランへ
export async function subEnded(env, s) {
  const bot = await botToken(env), c = await companyOfSub(env, bot, s.id); if (!c) return "skip";
  await commit(env, [updWrite(env, `companies/${c.id}`, { plan: "free", nextPlan: null, opts: {}, optEnd: {}, money: false, stripeSub: null })], bot);
  return "ok";
}
