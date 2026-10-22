// Secrets (RESEND_API_KEY, TURNSTILE_SECRET_KEY) are re-applied on every deploy via .github/workflows/deploy-worker.yml
// この Worker を呼んでよいのは、denroot.com のページだけです。
//   CORS の許可（Access-Control-Allow-Origin）は、下の2つの住所から来た時にだけ返します。
//   ほかのサイトのページから来た送信（Origin が下の2つと違う送信）は、中身を読まずに断ります。
//   Origin の無い送信（ブラウザ以外から）は断りませんが、フォームの送信には、Turnstile の確認の結果の文字列（トークン）が要ります。
const ALLOWED_ORIGINS = ['https://denroot.com', 'https://www.denroot.com'];
// Turnstile の確認を行ったページの住所（hostname）。トークンがほかのサイトのページで取られたものなら、受け付けません。
const ALLOWED_HOSTNAMES = ['denroot.com', 'www.denroot.com'];

// 入力の長さの上限（Claude が 2026-10-22 に置いた値。お問い合わせのフォームの maxlength と同じ値）。
const MAX_NAME = 100;
const MAX_MESSAGE = 5000;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response(null, { status: 403, headers: { 'Vary': 'Origin' } });
    }
    return withCors(await route(request, env, ctx), origin);
  }
};

async function route(request, env, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  const url = new URL(request.url);
  if (request.method === 'POST') {
    if (url.pathname === '/contact') return handleContact(request, env, ctx);
    if (url.pathname === '/waitlist') return handleWaitlist(request, env, ctx);
    if (url.pathname === '/event') return handleEvent(request, env, ctx);
  }
  return new Response('Not found', { status: 404 });
}

// 許可した住所から来た時だけ、返事に CORS の許可を付けます。
function withCors(res, origin) {
  const headers = new Headers(res.headers);
  headers.set('Vary', 'Origin');
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  return new Response(res.body, { status: res.status, headers });
}

// 本文を JSON として読みます。読めない時と、オブジェクトでない時（null・配列など）は null を返します。
async function readJson(request) {
  try {
    const b = await request.json();
    return b !== null && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch (e) {
    return null;
  }
}

// メールアドレスを、前後の空白を取り、小文字にそろえます。文字列でなければ空文字を返します。
//   小文字にそろえるのは、大文字と小文字だけが違う同じアドレスを、別の登録として二重に入れないためです。
function normalizeEmail(e) {
  return typeof e === 'string' ? e.trim().toLowerCase() : '';
}

async function handleContact(request, env, ctx) {
  try {
    const b = await readJson(request);
    if (!b) return jsonResponse({ error: 'Invalid body' }, 400);
    if (b.company) return jsonResponse({ success: true });
    // 名前は、件名にも入るので、改行などの制御文字を空白に置き換えます。
    const name = typeof b.name === 'string' ? b.name.replace(/[\u0000-\u001F\u007F]/g, ' ').trim() : '';
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    const email = normalizeEmail(b.email);
    const lang = b.lang;
    const turnstileToken = b.turnstileToken;
    if (!(await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, request))) {
      return jsonResponse({ error: 'verification_failed' }, 403);
    }
    if (!(await checkRateLimit(env, request))) {
      return jsonResponse({ error: 'rate_limited' }, 429);
    }
    if (!name || !email || !message) {
      return jsonResponse({ error: 'Missing required fields' }, 400);
    }
    if (name.length > MAX_NAME || message.length > MAX_MESSAGE) {
      return jsonResponse({ error: 'Too long' }, 400);
    }
    if (!isValidEmail(email)) {
      return jsonResponse({ error: 'Invalid email' }, 400);
    }
    const isJa = lang === 'ja';
    ctx.waitUntil((async () => {
      await sendEmailWithRetry(env.RESEND_API_KEY, {
        from: 'noreply@denroot.com',
        to: 'contact@denroot.com',
        subject: `[お問合せ] ${name}様`,
        text: `名前: ${name}\nメール: ${email}\n\nメッセージ:\n${message}`,
      });
      await sleep(600);
      await sendEmailWithRetry(env.RESEND_API_KEY, {
        from: 'noreply@denroot.com',
        to: email,
        reply_to: SENDER_CONTACT,
        subject: isJa ? 'お問合せを承りました' : 'Thank you for your inquiry',
        html: contactConfirmHtml(isJa),
      });
    })().catch(e => console.error('Contact emails failed:', e.message)));
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleWaitlist(request, env, ctx) {
  try {
    const b = await readJson(request);
    if (!b) return jsonResponse({ error: 'Invalid body' }, 400);
    if (b.company) return jsonResponse({ success: true });
    const email = normalizeEmail(b.email);
    // 言語は ja か en だけを保存します（そのほかの値は en にします）。
    const lang = b.lang === 'ja' ? 'ja' : 'en';
    const turnstileToken = b.turnstileToken;
    if (!(await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, request))) {
      return jsonResponse({ error: 'verification_failed' }, 403);
    }
    if (!(await checkRateLimit(env, request))) {
      return jsonResponse({ error: 'rate_limited' }, 429);
    }
    if (!isValidEmail(email)) return jsonResponse({ error: 'Email is required' }, 400);
    // 前に大文字のまま入った登録とも重ならないように、小文字にしてから比べます。
    const existing = await env.DB.prepare('SELECT id FROM waitlist WHERE lower(email) = ?').bind(email).first();
    if (existing) return jsonResponse({ error: 'already_registered' }, 409);
    await env.DB.prepare('INSERT INTO waitlist (email, lang) VALUES (?, ?)').bind(email, lang).run();
    const isJa = lang === 'ja';
    ctx.waitUntil((async () => {
      await sendEmailWithRetry(env.RESEND_API_KEY, {
        from: 'noreply@denroot.com',
        to: email,
        reply_to: SENDER_CONTACT,
        subject: isJa ? 'ウェイトリスト登録完了' : 'Waitlist Registration Confirmed',
        html: waitlistConfirmHtml(isJa),
        // Gmail / Apple Mail が件名の横に「登録解除」ボタンを出す。
        // mailto 形式なので、押すと配信停止メールが自動作成・送信される（削除は手動運用）。
        headers: { 'List-Unsubscribe': `<mailto:${SENDER_CONTACT}?subject=unsubscribe>` },
      });
      await sleep(600);
      await sendEmailWithRetry(env.RESEND_API_KEY, {
        from: 'noreply@denroot.com',
        to: 'contact@denroot.com',
        subject: '[ウェイトリスト] 新規登録',
        text: `新規ウェイトリスト登録\nメール: ${email}\n言語: ${lang}`,
      });
    })().catch(e => console.error('Waitlist emails failed:', e.message)));
    return jsonResponse({ success: true });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

function waitlistConfirmHtml(isJa) {
  const title = isJa ? 'ウェイトリスト登録完了' : 'Waitlist Registration Confirmed';
  const h1 = isJa ? 'ウェイトリストへの<br>ご登録ありがとうございます。' : 'Welcome to<br>the waitlist.';
  const p1 = isJa ? 'ウェイトリストへのご登録を確認いたしました。' : 'Your spot on the waitlist is confirmed.';
  const p2 = isJa ? 'サービスのローンチ時に、このメールアドレスへご連絡いたします。' : "We'll reach out to this address the moment we launch.";
  const footer = isJa ? 'このメールはウェイトリスト登録のご確認として送信されました。' : 'This email was sent to confirm your waitlist registration.';
  return `<!DOCTYPE html>
<html lang="${isJa ? 'ja' : 'en'}">
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,'Inter','Helvetica Neue',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:48px 20px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
<tr><td style="background:#060810;border-radius:12px 12px 0 0;padding:32px 40px;text-align:center;">
<img src="https://denroot.com/assets/denroot-logo-white.png" alt="denroot" width="132" style="display:block;margin:0 auto;height:auto;border:0;" />
</td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 12px 12px;padding:48px 40px 40px;">
<h1 style="margin:0 0 24px;font-size:26px;font-weight:600;line-height:1.3;letter-spacing:-0.02em;color:#1d1d1f;">${h1}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.75;color:#48484a;">${p1}</p>
<p style="margin:0 0 40px;font-size:15px;line-height:1.75;color:#48484a;">${p2}</p>
<hr style="border:none;border-top:1px solid #e8e8ed;margin:0 0 24px;">
<p style="margin:0;font-size:11px;color:#6e6e73;line-height:1.6;">${footer}</p>
${senderBlockHtml(isJa)}
<table width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 0;"><tr>
<td align="left" style="font-size:11px;color:#6e6e73;line-height:1.6;">© 2026 denroot</td>
<td align="right" style="font-size:11px;line-height:1.6;"><a href="https://denroot.com/privacy/" style="color:#6e6e73;">${isJa ? 'プライバシーポリシー' : 'Privacy Policy'}</a></td>
</tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// お問い合わせの自動返信です。送った人が書いた名前と本文は、入れません。
//   自動返信は、フォームに書かれたアドレスへ届きます。名前や本文を入れると、悪意のある人が、フォームに他人のアドレスと
//   好きな文を書くだけで、その文を載せたメールを、denroot の名前で他人に送れてしまうためです。
function contactConfirmHtml(isJa) {
  const t = isJa
    ? { title: 'お問合せを承りました', h1: 'ご連絡ありがとうございます。', body: 'お問合せを承りました。内容を確認のうえ、<strong>1〜3営業日以内に</strong>担当者よりご返信いたします。', reply: '※ 万一、3営業日を過ぎても返信が届かない場合は、迷惑メールフォルダをご確認のうえ、お手数ですが contact@denroot.com まで直接ご連絡ください。', footer: 'このメールはお問合せフォームからの自動返信です。このメールへの返信でも受け付けております。' }
    : { title: 'Thank you for your inquiry', h1: 'Thank you for contacting us.', body: "We've received your inquiry and will reply <strong>within 1–3 business days</strong>.", reply: "If you haven't heard from us after 3 business days, please check your spam folder and then email us directly at contact@denroot.com.", footer: 'This is an automated confirmation from the contact form. You can also simply reply to this email.' };
  return `<!DOCTYPE html>
<html lang="${isJa ? 'ja' : 'en'}">
<head><meta charset="UTF-8"><title>${t.title}</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,'Inter','Helvetica Neue',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:48px 20px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
<tr><td style="background:#060810;border-radius:12px 12px 0 0;padding:32px 40px;text-align:center;">
<img src="https://denroot.com/assets/denroot-logo-white.png" alt="denroot" width="132" style="display:block;margin:0 auto;height:auto;border:0;" />
</td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 12px 12px;padding:48px 40px 40px;">
<h1 style="margin:0 0 24px;font-size:26px;font-weight:600;line-height:1.3;letter-spacing:-0.02em;color:#1d1d1f;">${t.h1}</h1>
<p style="margin:0 0 32px;font-size:15px;line-height:1.75;color:#48484a;">${t.body}</p>
<hr style="border:none;border-top:1px solid #e8e8ed;margin:0 0 24px;">
<p style="margin:0 0 14px;font-size:12px;color:#48484a;line-height:1.7;">${t.reply}</p>
<p style="margin:0;font-size:11px;color:#6e6e73;line-height:1.6;">${t.footer}</p>
${senderBlockHtml(isJa)}
<table width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 0;"><tr>
<td align="left" style="font-size:11px;color:#6e6e73;line-height:1.6;">© 2026 denroot</td>
<td align="right" style="font-size:11px;line-height:1.6;"><a href="https://denroot.com/privacy/" style="color:#6e6e73;">${isJa ? 'プライバシーポリシー' : 'Privacy Policy'}</a></td>
</tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// 送った人に届く自動のメール（確認メールと自動返信）は、送り元の noreply@denroot.com には受け箱が無いので、
//   返信先（reply_to）を contact@denroot.com にします。自動返信に「このメールへの返信でも受け付けております」と書いてあるためです。
async function sendEmail(apiKey, { from, to, subject, html, text, headers, reply_to }) {
  const body = { from, to, subject };
  if (reply_to) body.reply_to = reply_to;
  if (html) body.html = html;
  if (text) body.text = text;
  if (headers) body.headers = headers;   // 例：List-Unsubscribe
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend error: ${await res.text()}`);
  return res.json();
}

async function verifyTurnstile(token, secret, request) {
  if (typeof token !== 'string' || !token || token.length > 2048 || !secret) return false;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const form = new URLSearchParams();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await res.json();
    // トークンが denroot.com のページで取られたものかも確かめます（Cloudflare の説明：
    //   https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ の「Validate the action and hostname」）。
    return data.success === true && ALLOWED_HOSTNAMES.includes(data.hostname);
  } catch (e) {
    return false;
  }
}

/* Rate limiting stores a SHA-256 hash of the IP, never the IP itself.
   Same IP -> same hash, so rate limiting still works, but the raw address
   is never written to the database and cannot be recovered from it. */
/* ⚠️ 塩は必ず env（Worker secret）から取る。
   リポジトリは公開されているため、ソースに塩を書くと誰でも読める。
   IPv4 の空間は約43億通りしかないので、塩が既知なら SHA-256 は総当たりで復元できる。
   ＝ ソースに書かれた塩によるハッシュ化は、保護になっていない。
   さらに、ハッシュに10分の時間窓を混ぜて、時間をまたいだ名寄せもできないようにする。 */
async function hashIp(ip, env) {
  const salt = (env && env.RL_SALT) || '';
  if (!salt) return null;                       // 秘密塩が無ければ、IP由来の値を一切保存しない
  const window = Math.floor(Date.now() / 600000); // 10分ごとにローテート
  const data = new TextEncoder().encode(salt + ':' + window + ':' + ip);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// フォーム（事前登録とお問い合わせ）の送信を、10分ごとに数え、上限を超えていれば false を返します。
//   設定が欠けていて数えられない時（IP・D1・塩〔RL_SALT〕が無い時）は、false を返して送信を断ります。
//   数えずに通すと、設定の誤りに気づかないまま、回数制限が外れるためです。
//   D1 の読み書きに失敗した時だけは、送信を通します。D1 が止まっている間も、お問い合わせを受け付けるためです
//   （フォームの送信には Turnstile の確認が要るので、機械による大量の送信は、そこで止まります）。
//   どちらの時も、理由を Cloudflare の記録（rate_limit_unavailable）に出します。
async function checkRateLimit(env, request) {
  const rawIp = request.headers.get('CF-Connecting-IP') || '';
  if (!rawIp || !env.DB) { console.error('rate_limit_unavailable', !rawIp ? 'no_ip' : 'no_db'); return false; }
  const ip = await hashIp(rawIp, env);   // 秘密塩＋10分窓。生IPはD1に到達しない
  if (!ip) { console.error('rate_limit_unavailable', 'no_salt'); return false; }   // 塩が未設定なら、IP 由来の値を保存せず、送信を断る
  const LIMIT = 30;
  const WINDOW = 600;
  const now = Math.floor(Date.now() / 1000);
  const run = async () => {
    const row = await env.DB.prepare('SELECT cnt, reset_at FROM rate_limit WHERE ip = ?').bind(ip).first();
    if (!row || row.reset_at < now) {
      await env.DB.prepare('INSERT INTO rate_limit (ip, cnt, reset_at) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET cnt = 1, reset_at = ?').bind(ip, now + WINDOW, now + WINDOW).run();
      return true;
    }
    if (row.cnt >= LIMIT) return false;
    await env.DB.prepare('UPDATE rate_limit SET cnt = cnt + 1 WHERE ip = ?').bind(ip).run();
    return true;
  };
  // 期限切れの行を掃除する。放置すると使われないハッシュが溜まり続け、
  // 「10分で無効になり順次削除する」というポリシーの記載が嘘になる。
  if (Math.random() < 0.05) {
    try { await env.DB.prepare('DELETE FROM rate_limit WHERE reset_at < ?').bind(now).run(); } catch (e) {}
  }
  try {
    return await run();
  } catch (e) {
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS rate_limit (ip TEXT PRIMARY KEY, cnt INTEGER NOT NULL, reset_at INTEGER NOT NULL)').run();
      return await run();
    } catch (e2) {
      console.error('rate_limit_unavailable', 'd1');
      return true;
    }
  }
}

// メールアドレスの形を確かめます。@ が1つだけあり、@ の前（64文字まで）に空白・制御文字・<>()[],;:"\ が無く、
//   @ の後ろが「英数字とハイフンの区切り」を点でつないだ形で、点が1つ以上あるものだけを通します。
//   全体は254文字まで（RFC 5321 の上限）。
function isValidEmail(e) {
  if (typeof e !== 'string' || e.length > 254) return false;
  const m = /^([^\s@<>()\[\],;:"\\\u0000-\u001F\u007F]{1,64})@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/.exec(e);
  return m !== null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendEmailWithRetry(apiKey, message, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await sendEmail(apiKey, message);
    } catch (e) {
      if (i === tries - 1) throw e;
      // Resend free-tier rate limit is ~2 req/sec; back off and retry.
      await sleep(800 * (i + 1));
    }
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ── Anonymous reach counter ──────────────────────────────────────────────
   Measures ONLY how far a visitor scrolled, so we can see which section of
   the LP loses people.

   Deliberately NOT collected / NOT stored:
     · no cookies, no localStorage           · no visitor ID, no session ID
     · no IP address (never written to D1)   · no fingerprinting
   Exactly one row per visit, sent when the page is closed. Individual
   visitors cannot be identified or re-identified from this data.
────────────────────────────────────────────────────────────────────────── */
const LP_SECTIONS = ['hero','stats','world','against','whatitis','partner','screens','engine','tried','compare','truth','wasted','founder','waitlist'];

async function handleEvent(request, env, ctx) {
  try {
    // drop bots — they would inflate every number
    const ua = request.headers.get('User-Agent') || '';
    if (!ua || /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|curl|wget|python|axios|node-fetch/i.test(ua)) {
      return new Response(null, { status: 204 });
    }
    // only accept beacons that came from our own pages
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response(null, { status: 204 });
    }
    const b = await readJson(request);
    const section = b && LP_SECTIONS.includes(b.section) ? b.section : null;
    if (!section) return new Response(null, { status: 204 });
    // 到達計測には、回数制限を付けません。回数制限は IP から計算した値を D1 に書くので、LP を見ただけの人についても
    //   その値を書くことになります。それは、プライバシーポリシーの第2条(3)（IP から計算した値を持つのは、フォームの送信時）と、
    //   第10条(4)（到達計測では IP アドレスを保存しない）に食い違うためです。

    const depth  = LP_SECTIONS.indexOf(section);
    const lang   = b.lang === 'ja' ? 'ja' : 'en';
    const device = b.device === 'mobile' ? 'mobile' : 'desktop';
    const ref    = typeof b.ref === 'string' ? b.ref.replace(/[^a-zA-Z0-9.\-]/g, '').slice(0, 60) : '';
    const cta    = b.cta ? 1 : 0;
    const now    = Math.floor(Date.now() / 1000);

    // country is already known to the edge (2-letter ISO code). Not personal data, and it costs nothing.
    const country = (request.cf && typeof request.cf.country === 'string') ? request.cf.country.slice(0, 2) : '';

    ctx.waitUntil(writeEvent(env, { section, depth, lang, device, ref, cta, country, now }));
  } catch (e) { /* never let measurement break the page */ }
  return new Response(null, { status: 204 });
}

async function writeEvent(env, e) {
  if (!env.DB) return;
  const insert = () => env.DB
    .prepare('INSERT INTO lp_events (section, depth, lang, device, ref, cta, country, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(e.section, e.depth, e.lang, e.device, e.ref, e.cta, e.country, e.now)
    .run();
  try {
    await insert();
  } catch (err) {
    // first run (no table) or an older table without the country column — heal, then retry once
    try {
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS lp_events (id INTEGER PRIMARY KEY AUTOINCREMENT, section TEXT NOT NULL, depth INTEGER NOT NULL, lang TEXT, device TEXT, ref TEXT, cta INTEGER, country TEXT, created_at INTEGER NOT NULL)'
      ).run();
      try { await env.DB.prepare('ALTER TABLE lp_events ADD COLUMN country TEXT').run(); } catch (ignore) { /* column already there */ }
      await insert();
    } catch (e2) { /* give up silently — measurement must never break the page */ }
  }
}

/* ── Sender information block ────────────────────────────────────────────────
   Act on Regulation of Transmission of Specified Electronic Mail, Art.4 and
   Enforcement Rule Art.9 require an ADVERTISING email to state, in the body:
     (1) the sender's name,
     (2) THE ADDRESS OF THE PERSON RESPONSIBLE FOR TRANSMISSION,
     (3) a contact point for complaints and enquiries,
     (4) an email address or URL for refusing further mail, and
     (5) immediately before or after (4), a statement that refusal is possible.

   The confirmation email below is transactional, not advertising, so (2) is not
   required for it. THE LAUNCH NOTIFICATION EMAIL *IS* ADVERTISING, and it cannot
   be sent until an address exists to put in SENDER_ADDRESS — this is true even if
   the app is released free of charge.  See 法務.md §7.
──────────────────────────────────────────────────────────────────────────── */
// 2026-08-05 送信者から個人名を外した（Ryu 指示）。上の (1) は「氏名又は名称」なので名称で足りる。
// ⚠️ 個人事業主が屋号のみで足りるかは【未確認】→ 法務.md §7 の専門家チェックで確認する。
const SENDER_NAME_JA = 'Denroot';
const SENDER_NAME_EN = 'Denroot';
const SENDER_CONTACT = 'contact@denroot.com';
const SENDER_ADDRESS = '';   // ⚠️ MUST be filled before any advertising email (incl. the launch notification) is sent.

function senderBlockHtml(isJa) {
  const addr = SENDER_ADDRESS
    ? `<p style="margin:0 0 4px;">${isJa ? '住所' : 'Address'}：${SENDER_ADDRESS}</p>`
    : '';
  return isJa ? `
<hr style="border:none;border-top:1px solid #e8e8ed;margin:24px 0 18px;">
<div style="font-size:11px;color:#6e6e73;line-height:1.7;">
<p style="margin:0 0 4px;">送信者：${SENDER_NAME_JA}</p>
${addr}
<p style="margin:0 0 4px;">お問い合わせ：<a href="mailto:${SENDER_CONTACT}" style="color:#6e6e73;">${SENDER_CONTACT}</a></p>
<p style="margin:8px 0 0;"><strong>配信停止をご希望の場合は、いつでも受け付けます。</strong>上記アドレス宛に「配信停止」とご記入のうえご連絡ください。</p>
</div>` : `
<hr style="border:none;border-top:1px solid #e8e8ed;margin:24px 0 18px;">
<div style="font-size:11px;color:#6e6e73;line-height:1.7;">
<p style="margin:0 0 4px;">Sender: ${SENDER_NAME_EN}</p>
${addr}
<p style="margin:0 0 4px;">Enquiries: <a href="mailto:${SENDER_CONTACT}" style="color:#6e6e73;">${SENDER_CONTACT}</a></p>
<p style="margin:8px 0 0;"><strong>You can unsubscribe at any time.</strong> Email the address above with the word "unsubscribe".</p>
</div>`;
}
