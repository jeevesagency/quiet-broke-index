// POST /api/subscribe — proxies to Substack's public free-subscribe endpoint.
// Falls back gracefully: if Substack rejects/blocks server-side, client redirects to
// https://henryfinance.substack.com/subscribe?email=... so the user can finish in one click.

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const email = (body.email || '').toString().trim().toLowerCase();
  const city = (body.city || '').toString().slice(0, 64);
  const score = (body.score || '').toString().slice(0, 8);
  const source = (body.source || 'qbi').toString().slice(0, 32);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, error: 'bad_email' });
    return;
  }

  const pub = 'henryfinance.substack.com';
  const subscribeUrl = `https://${pub}/api/v1/free`;
  const payload = {
    email,
    email_signup: 1,
    first_url: `https://quietbrokeindex.com/?city=${city}&score=${score}`,
    first_referrer: '',
    current_url: `https://quietbrokeindex.com/?city=${city}&score=${score}`,
    current_referrer: '',
    referral_code: '',
    source: 'subscribe_modal_embed_form',
    email_collection_method: 'single_opt_in',
    captcha_response: null,
  };

  // Light, single attempt. If it fails or 403s, client falls back.
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 5500);
    const r = await fetch(subscribeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Origin': `https://${pub}`,
        'Referer': `https://${pub}/subscribe`,
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    clearTimeout(tid);
    const text = await r.text();
    let j = {};
    try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 400) }; }

    // Substack typically returns {} or { user_id: ... } on success
    if (r.ok && (!j.error)) {
      res.status(200).json({ ok: true, ts: Date.now(), city, score, src: source });
      return;
    }
    res.status(200).json({ ok: false, fallback: true, status: r.status, hint: j.error || null });
  } catch (e) {
    res.status(200).json({ ok: false, fallback: true, error: 'network' });
  }
}
