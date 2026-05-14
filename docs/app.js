// The Quiet-Broke Index — interactive logic
(async function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmt$ = (n) => '$' + Math.round(n).toLocaleString();
  const fmtK = (n) => '$' + Math.round(n / 1000) + 'k';
  const pct = (n) => (n * 100).toFixed(1) + '%';

  let DATA = null;
  // Resolve cities.json relative to wherever app.js was loaded from.
  // Lets the same script work from /, /city/<slug>.html, /methodology.html, etc.
  const APP_SCRIPT = Array.from(document.scripts).find((s) => /\/app\.js(?:\?|$)/.test(s.src));
  const DATA_URL = APP_SCRIPT
    ? new URL('data/cities.json', APP_SCRIPT.src).toString()
    : 'data/cities.json';
  try {
    const r = await fetch(DATA_URL);
    DATA = await r.json();
  } catch (e) {
    console.error('Failed to load city data', e);
    return;
  }

  const W = DATA.weights;
  const A = DATA.anchors;
  const cities = DATA.cities.slice();

  // ---- score computation ----
  function fixedShare(c, override) {
    const hhi = (override && override.hhi) || DATA._meta.default_hhi;
    const rent = (override && override.rent_mo != null) ? override.rent_mo : c.median_3br_rent_mo;
    const kids = (override && override.kids != null) ? override.kids : 2;
    const health = (override && override.health_mo != null) ? override.health_mo : c.family_health_premium_mo;
    const transport = (override && override.transport_mo != null) ? override.transport_mo : c.commute_cost_mo;

    const eff_tax = c.eff_combined_tax_400k;
    const post_tax = hhi * (1 - eff_tax);

    const housing_yr = rent * 12;
    const childcare_yr = kids * c.median_ft_daycare_mo * 12;
    const health_yr = health * 12;
    const transport_yr = transport * 12;

    // tax burden is its own component computed as tax_dollars / hhi (so a 40% tax = 0.40)
    // but we want the share consumed by "fixed costs" as % of post-tax income for the line item display
    const housing_share = housing_yr / post_tax;
    const childcare_share = childcare_yr / post_tax;
    const health_share = health_yr / post_tax;
    const transport_share = transport_yr / post_tax;
    const tax_share = eff_tax; // tax as share of gross

    // total fixed burden = (fixed dollars + tax dollars) / gross
    const total_share = (housing_yr + childcare_yr + health_yr + transport_yr + hhi * eff_tax) / hhi;

    return {
      hhi,
      post_tax,
      eff_tax,
      housing_yr, childcare_yr, health_yr, transport_yr,
      housing_share, childcare_share, health_share, transport_share, tax_share,
      total_share,
      slack_yr: hhi - (housing_yr + childcare_yr + health_yr + transport_yr + hhi * eff_tax)
    };
  }

  function rawScore(c, override) {
    // Weighted sum of normalized components (each ratio normalized to 0..1 over a sensible range)
    // We map each component's ratio to a 0..1 sub-score, then weight.
    const f = fixedShare(c, override);

    // Normalization ranges (component-share / income at $400K baseline):
    // housing: 0.06 -> 0.20 of gross
    // tax: 0.30 -> 0.45
    // childcare: 0.03 -> 0.15
    // healthcare: 0.015 -> 0.030
    // transport: 0.012 -> 0.020
    const ranges = {
      housing: { lo: 0.06, hi: 0.20, val: (f.housing_yr) / f.hhi },
      tax:     { lo: 0.30, hi: 0.45, val: f.eff_tax },
      childcare:{lo: 0.00, hi: 0.16, val: (f.childcare_yr) / f.hhi },
      healthcare:{lo: 0.014,hi: 0.030, val: (f.health_yr) / f.hhi },
      transport:{lo: 0.012,hi: 0.022, val: (f.transport_yr) / f.hhi }
    };
    function norm(r) { return Math.max(0, Math.min(1, (r.val - r.lo) / (r.hi - r.lo))); }
    const sub = {
      housing: norm(ranges.housing) * W.housing,
      tax: norm(ranges.tax) * W.tax,
      childcare: norm(ranges.childcare) * W.childcare,
      healthcare: norm(ranges.healthcare) * W.healthcare,
      transport: norm(ranges.transport) * W.transport
    };
    const score01 = sub.housing + sub.tax + sub.childcare + sub.healthcare + sub.transport;
    return { score: Math.round(score01 * 100), f, sub };
  }

  // verdict band
  function verdict(score) {
    if (score >= 80) return { label: 'Wildly Quiet-Broke', detail: 'Your fixed-cost floor is consuming nearly everything a $400K gross brings in. You\'re affluent on paper and tight in practice. The "lifestyle of a normal upper-middle family" is a stretch goal, not a baseline. The way out almost never runs through earning more — it runs through changing two of the line items below.' };
    if (score >= 65) return { label: 'Comfortably Quiet-Broke', detail: 'Real income on paper. Real squeeze in practice. You\'re not in danger, but the savings rate the personal-finance books talk about (15–20% of gross) is mathematically out of reach here without trading one of housing, childcare, or commute for something materially different.' };
    if (score >= 45) return { label: 'Tight', detail: 'You\'re feeling it, but you have meaningful slack — a layoff wouldn\'t be a crisis next week. The fixed-cost floor is in a range where conventional advice (max your 401(k), open a 529, automate transfers to brokerage) actually works.' };
    if (score >= 25) return { label: 'Quietly Comfortable', detail: 'Your metro is doing a lot of work for you. The same gross income one tier of metros over would feel completely different. Don\'t mistake the geography for your skill at money.' };
    return { label: 'Rich, full stop', detail: 'Your fixed-cost burden is under a quarter of gross. Whatever feeling-broke happens at this score isn\'t cost — it\'s discretionary. That\'s a different problem (a real one, but a different one).' };
  }

  // ---- populate UI ----
  const sel = $('i-city');
  cities.sort((a,b) => a.name.localeCompare(b.name)).forEach(c => {
    const o = document.createElement('option');
    o.value = c.slug;
    o.textContent = c.name + ', ' + c.state;
    sel.appendChild(o);
  });

  // default selection: page-specified override (city pages) > localStorage > NYC
  let defaultSlug = 'new-york-ny';
  if (typeof window !== 'undefined' && window.QBI_DEFAULT_CITY && cities.find(c => c.slug === window.QBI_DEFAULT_CITY)) {
    defaultSlug = window.QBI_DEFAULT_CITY;
  } else {
    const stored = (typeof localStorage !== 'undefined') && localStorage.getItem('qbi_city');
    if (stored && cities.find(c => c.slug === stored)) defaultSlug = stored;
  }
  sel.value = defaultSlug;

  function autofillFromCity() {
    const c = cities.find(x => x.slug === sel.value);
    if (!c) return;
    $('i-rent').placeholder = `${c.median_3br_rent_mo} (metro median)`;
    $('i-health').placeholder = `${c.family_health_premium_mo} (regional avg)`;
    $('i-transport').placeholder = `${c.commute_cost_mo} (regional avg)`;
  }
  sel.addEventListener('change', () => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('qbi_city', sel.value);
    autofillFromCity();
  });
  autofillFromCity();

  function gatherOverride() {
    const ov = {
      hhi: Number($('i-hhi').value) || DATA._meta.default_hhi,
      kids: Number($('i-kids').value),
    };
    const rent = Number($('i-rent').value); if (rent > 0) ov.rent_mo = rent;
    const health = Number($('i-health').value); if (health > 0) ov.health_mo = health;
    const transport = Number($('i-transport').value); if (transport > 0) ov.transport_mo = transport;
    return ov;
  }

  function render(c, r) {
    $('r-score').textContent = r.score;
    const v = verdict(r.score);
    $('r-label').textContent = v.label + ' in ' + c.name;
    $('r-detail').innerHTML = v.detail + ' At your inputs in ' + c.name + ', your post-tax slack after the five fixed costs is <strong>' + fmt$(r.f.slack_yr) + '</strong>/yr.';

    const tb = $('r-breakdown').querySelector('tbody');
    tb.innerHTML = '';
    const lines = [
      ['Taxes (federal + state + local)', r.f.eff_tax * r.f.hhi, r.f.tax_share],
      ['Housing', r.f.housing_yr, r.f.housing_yr / r.f.hhi],
      ['Childcare', r.f.childcare_yr, r.f.childcare_yr / r.f.hhi],
      ['Healthcare', r.f.health_yr, r.f.health_yr / r.f.hhi],
      ['Transportation', r.f.transport_yr, r.f.transport_yr / r.f.hhi],
    ];
    const maxShare = Math.max(...lines.map(l => l[2]));
    lines.forEach(l => {
      const tr = document.createElement('tr');
      const w = Math.round((l[2] / maxShare) * 100);
      tr.innerHTML = `<td>${l[0]}<div class="bar-wrap"><div class="bar" style="width:${w}%"></div></div></td><td>${fmt$(l[1])} / yr <span style="color:var(--ink-mute); font-weight:400; font-size:12px;">(${pct(l[2])})</span></td>`;
      tb.appendChild(tr);
    });

    $('result').classList.add('show');
    setTimeout(() => { $('result').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
  }

  $('calc-btn').addEventListener('click', () => {
    const c = cities.find(x => x.slug === sel.value);
    if (!c) return;
    const r = rawScore(c, gatherOverride());
    render(c, r);
    // persist user inputs for share link
    const params = new URLSearchParams({
      city: c.slug,
      hhi: $('i-hhi').value,
      score: r.score,
    });
    history.replaceState(null, '', '?' + params.toString());
  });

  $('reset-btn').addEventListener('click', () => {
    $('i-rent').value = '';
    $('i-health').value = '';
    $('i-transport').value = '';
    $('i-hhi').value = 400000;
    $('i-kids').value = 2;
  });

  // ---- ranking table ----
  const ranked = cities.map(c => ({ c, r: rawScore(c, null) }))
                       .sort((a, b) => b.r.score - a.r.score);

  const rb = document.querySelector('#rank-table tbody');
  if (rb) ranked.forEach((row, i) => {
    const tr = document.createElement('tr');
    const s = row.r.score;
    const tag = s >= 80 ? '<span class="tag danger">very squeezed</span>'
              : s >= 60 ? '<span class="tag warn">squeezed</span>'
              : s >= 35 ? '<span class="tag">moderate</span>'
              : '<span class="tag">comfortable</span>';
    tr.innerHTML = `
      <td class="rank-n">${i+1}</td>
      <td><strong>${row.c.name}</strong>, ${row.c.state}<div class="tag-row" style="margin-top:4px;">${tag}</div></td>
      <td class="hide-mobile">${pct(row.r.f.eff_tax)}</td>
      <td class="hide-mobile">${fmt$(row.r.f.housing_yr)}/yr</td>
      <td class="hide-mobile">${pct(row.r.f.total_share)}</td>
      <td class="score">${s}<span class="meter"><span style="width:${s}%"></span></span></td>
    `;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => {
      sel.value = row.c.slug;
      autofillFromCity();
      const r = rawScore(row.c, gatherOverride());
      render(row.c, r);
    });
    rb.appendChild(tr);
  });

  // ---- hero stats: compute from real data ----
  const top10 = ranked.slice(0, 10);
  const avgFixedTop10 = top10.reduce((s, x) => s + x.r.f.housing_yr + x.r.f.childcare_yr + x.r.f.health_yr + x.r.f.transport_yr + x.r.f.eff_tax * x.r.f.hhi, 0) / 10;
  if ($('hero-stat-2')) $('hero-stat-2').textContent = '$' + Math.round(avgFixedTop10 / 1000) + 'k';
  const maxH = Math.max(...cities.map(c => c.median_3br_rent_mo));
  const minH = Math.min(...cities.map(c => c.median_3br_rent_mo));
  if ($('hero-stat-3')) $('hero-stat-3').textContent = (maxH / minH).toFixed(1) + '×';

  // ---- subscribe ----
  const subForm = $('sub-form');
  if (subForm) {
    subForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('sub-email').value.trim();
      const status = $('sub-status');
      if (!email || !email.includes('@')) { status.textContent = 'That email looks off — try again.'; return; }
      status.textContent = 'Sending…';
      try {
        const params = new URLSearchParams(location.search);
        // Static deploy: server-side subscribe API unavailable; jump straight to Substack.
        if (typeof window.QBI_HAS_API === 'undefined' || !window.QBI_HAS_API) {
          const fallback = 'https://henryfinance.substack.com/subscribe?email=' + encodeURIComponent(email) + '&utm_source=quietbroke&utm_medium=tool';
          status.innerHTML = 'Almost there — <a href="' + fallback + '" target="_blank" rel="noopener">finish on Substack</a> (one click).';
          window.open(fallback, '_blank', 'noopener');
          return;
        }
        const r = await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, city: params.get('city') || sel.value, score: params.get('score') || '', source: 'qbi-tool' })
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) {
          status.innerHTML = 'Subscribed. <a href="https://henryfinance.substack.com/" target="_blank" rel="noopener">Open Henry Finance →</a>';
          subForm.querySelector('button').disabled = true;
          subForm.querySelector('input').disabled = true;
        } else {
          // graceful fallback: open Substack subscribe page with email prefilled
          const fallback = 'https://henryfinance.substack.com/subscribe?email=' + encodeURIComponent(email) + '&utm_source=quietbroke&utm_medium=tool-fallback';
          status.innerHTML = 'Almost there — <a href="' + fallback + '" target="_blank" rel="noopener">finish on Substack</a> (one click).';
        }
      } catch (err) {
        const fallback = 'https://henryfinance.substack.com/subscribe?email=' + encodeURIComponent(email) + '&utm_source=quietbroke&utm_medium=tool-fallback';
        status.innerHTML = 'Almost there — <a href="' + fallback + '" target="_blank" rel="noopener">finish on Substack</a> (one click).';
      }
    });
  }

  // ---- share ----
  $('share-twitter').addEventListener('click', () => {
    const score = $('r-score').textContent;
    const c = cities.find(x => x.slug === sel.value);
    const text = `I scored ${score} on the Quiet-Broke Index in ${c ? c.name : ''}. Pretty much sums up how a $400K household feels right now in this country. https://quietbrokeindex.com`;
    window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text), '_blank', 'noopener');
  });
  $('share-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); $('share-copy').textContent = 'Copied'; setTimeout(() => $('share-copy').textContent = 'Copy result link', 1500); } catch (e) {}
  });
  $('share-substack').addEventListener('click', () => {
    window.open('https://substack.com/note?utm_source=quietbroke', '_blank', 'noopener');
  });

  // ---- share card (canvas) ----

  // Pre-load both web fonts so canvas drawText uses them properly.
  // The fonts are already linked via Google Fonts in the <head>;
  // document.fonts.load() ensures they are decoded before we draw.
  async function ensureFontsLoaded() {
    try {
      await Promise.all([
        document.fonts.load('700 96px Fraunces'),
        document.fonts.load('600 36px Fraunces'),
        document.fonts.load('500 16px Inter'),
        document.fonts.load('400 14px Inter'),
      ]);
    } catch (e) {
      // non-fatal — fallback fonts render fine
    }
  }

  function buildShareCanvas(c, r) {
    const W = 1200, H = 630;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // --- palette ---
    const BG      = '#f7f4ee';
    const CARD_BG = '#fffdf8';
    const INK     = '#1b1a17';
    const INK_S   = '#4a4742';
    const INK_M   = '#7a766f';
    const ACCENT  = '#b3361f';
    const LINE    = '#d9d2c6';
    const LINE_S  = '#ebe6dc';
    const ACCENT_S= '#f3dfd6';

    // background
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    // top accent stripe
    ctx.fillStyle = ACCENT;
    ctx.fillRect(0, 0, W, 7);

    // --- brand eyebrow ---
    ctx.fillStyle = ACCENT;
    ctx.font = "italic 600 15px Fraunces, Georgia, serif";
    ctx.letterSpacing = '2px';
    ctx.fillText('THE QUIET-BROKE INDEX', 72, 58);
    ctx.letterSpacing = '0px';

    const cityLabel = c.name + ', ' + c.state;
    const v = verdict(r.score);

    // --- big score area ---
    const scoreX = 72;
    // Score number baseline
    const scoreFontSize = 120;
    ctx.fillStyle = INK;
    ctx.font = `700 ${scoreFontSize}px Fraunces, Georgia, serif`;
    ctx.fillText(String(r.score), scoreX, 210);

    // " / 100" suffix
    ctx.font = `700 ${scoreFontSize}px Fraunces, Georgia, serif`;
    const bigW = ctx.measureText(String(r.score)).width;
    ctx.font = "400 26px Fraunces, Georgia, serif";
    ctx.fillStyle = INK_M;
    ctx.fillText('/ 100', scoreX + bigW + 10, 210);

    // verdict label — word-wrap at ~900px wide
    const verdictMaxW = 900;
    ctx.font = "600 34px Fraunces, Georgia, serif";
    const verdictWords = v.label.split(' ');
    let verdictLines = [];
    let line = '';
    for (const word of verdictWords) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > verdictMaxW && line) {
        verdictLines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) verdictLines.push(line);

    const verdictBaseY = 258;
    verdictLines.forEach((ln, i) => {
      ctx.font = "600 34px Fraunces, Georgia, serif";
      ctx.fillStyle = INK;
      ctx.fillText(ln, scoreX, verdictBaseY + i * 42);
    });

    // city name
    ctx.font = "500 18px Inter, Helvetica, Arial, sans-serif";
    ctx.fillStyle = INK_M;
    ctx.fillText(cityLabel, scoreX, verdictBaseY + verdictLines.length * 42 + 8);

    // --- divider ---
    const divY = verdictBaseY + verdictLines.length * 42 + 38;
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(72, divY);
    ctx.lineTo(W - 72, divY);
    ctx.stroke();

    // --- line items band ---
    // Distribute remaining space (minus footer ~40px) evenly across 5 rows
    const footerH = 44;
    const available = H - divY - 16 - footerH;
    const rowH = Math.floor(available / 5);
    const bandY = divY + 16;
    const labelW = 130;
    const barAreaX = 72 + labelW + 16;
    const barAreaW = W - 72 - barAreaX - 200;
    const valX = W - 72;

    const lines = [
      { label: 'Tax',          amt: r.f.eff_tax * r.f.hhi,  share: r.f.tax_share },
      { label: 'Housing',      amt: r.f.housing_yr,          share: r.f.housing_yr / r.f.hhi },
      { label: 'Childcare',    amt: r.f.childcare_yr,        share: r.f.childcare_yr / r.f.hhi },
      { label: 'Healthcare',   amt: r.f.health_yr,           share: r.f.health_yr / r.f.hhi },
      { label: 'Transport',    amt: r.f.transport_yr,        share: r.f.transport_yr / r.f.hhi },
    ];
    const maxShare = Math.max(...lines.map(l => l.share));

    lines.forEach((ln, i) => {
      const y = bandY + i * rowH;
      const midY = y + rowH / 2;

      // label
      ctx.font = "500 14px Inter, Helvetica, Arial, sans-serif";
      ctx.fillStyle = INK_S;
      ctx.fillText(ln.label, 72, midY + 5);

      // bar track
      const barH = 8;
      const barY = midY - barH / 2;
      ctx.fillStyle = LINE_S;
      ctx.beginPath();
      ctx.roundRect(barAreaX, barY, barAreaW, barH, 4);
      ctx.fill();

      // bar fill
      const fillW = Math.round((ln.share / maxShare) * barAreaW);
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.roundRect(barAreaX, barY, fillW, barH, 4);
      ctx.fill();

      // dollar amount
      ctx.font = "600 14px Inter, Helvetica, Arial, sans-serif";
      ctx.fillStyle = INK;
      ctx.textAlign = 'right';
      ctx.fillText(fmt$(ln.amt) + '/yr', valX, midY + 4);

      // percent
      ctx.font = "400 12px Inter, Helvetica, Arial, sans-serif";
      ctx.fillStyle = INK_M;
      ctx.textAlign = 'right';
      ctx.fillText('(' + pct(ln.share) + ')', valX, midY + 18);
      ctx.textAlign = 'left';
    });

    // --- footer ---
    const footY = H - 18;
    ctx.fillStyle = INK_M;
    ctx.font = "400 13px Inter, Helvetica, Arial, sans-serif";
    ctx.fillText('quietbrokeindex.com  ·  Henry Finance research  ·  henryfinance.substack.com', 72, footY);

    return canvas;
  }

  async function generateShareCard() {
    const c = cities.find(x => x.slug === sel.value);
    if (!c) return;
    const r = rawScore(c, gatherOverride());

    const btn = $('share-card-download');
    const origText = btn.textContent;
    btn.textContent = 'Rendering…';
    btn.style.opacity = '0.6';

    await ensureFontsLoaded();

    let canvas;
    try {
      canvas = buildShareCanvas(c, r);
    } catch (e) {
      btn.textContent = origText;
      btn.style.opacity = '';
      console.error('Share card render failed', e);
      return;
    }

    const slug = c.slug;
    const score = r.score;
    const filename = `quiet-broke-${slug}-${score}.png`;

    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      btn.textContent = 'Downloaded!';
      btn.style.opacity = '';
      setTimeout(() => { btn.textContent = origText; }, 2500);
    }, 'image/png');
  }

  async function copyShareCardToClipboard() {
    const c = cities.find(x => x.slug === sel.value);
    if (!c) return;
    const r = rawScore(c, gatherOverride());

    const btn = $('share-card-copy');
    const origText = btn.textContent;
    btn.textContent = 'Rendering…';
    btn.style.opacity = '0.6';

    await ensureFontsLoaded();

    let canvas;
    try {
      canvas = buildShareCanvas(c, r);
    } catch (e) {
      btn.textContent = origText;
      btn.style.opacity = '';
      return;
    }

    canvas.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        btn.textContent = 'Copied!';
        btn.style.opacity = '';
        setTimeout(() => { btn.textContent = origText; }, 2500);
      } catch (e) {
        // Clipboard API not available (non-HTTPS or blocked) — fall back to download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `quiet-broke-${c.slug}-${r.score}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        btn.textContent = 'Downloaded!';
        btn.style.opacity = '';
        setTimeout(() => { btn.textContent = origText; }, 2500);
      }
    }, 'image/png');
  }

  $('share-card-download').addEventListener('click', generateShareCard);
  $('share-card-copy').addEventListener('click', copyShareCardToClipboard);

  // Auto-render if URL has params
  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get('city')) {
    sel.value = urlParams.get('city');
    autofillFromCity();
    if (urlParams.get('hhi')) $('i-hhi').value = urlParams.get('hhi');
    setTimeout(() => $('calc-btn').click(), 100);
  }
})();
