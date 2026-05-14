// Build per-city pages from docs/data/cities.json.
// Outputs static HTML to docs/city/<slug>.html. Idempotent — safe to rerun.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/data/cities.json'), 'utf8'));
const OUT_DIR = path.join(ROOT, 'docs/city');
fs.mkdirSync(OUT_DIR, { recursive: true });

const W = DATA.weights;
const DEFAULT_HHI = DATA._meta.default_hhi;

// --- score logic (mirrors docs/app.js) ---
function fixedShare(c) {
  const hhi = DEFAULT_HHI;
  const rent = c.median_3br_rent_mo;
  const kids = 2;
  const health = c.family_health_premium_mo;
  const transport = c.commute_cost_mo;
  const eff_tax = c.eff_combined_tax_400k;
  const post_tax = hhi * (1 - eff_tax);
  const housing_yr = rent * 12;
  const childcare_yr = kids * c.median_ft_daycare_mo * 12;
  const health_yr = health * 12;
  const transport_yr = transport * 12;
  const total_share = (housing_yr + childcare_yr + health_yr + transport_yr + hhi * eff_tax) / hhi;
  return {
    hhi, post_tax, eff_tax, housing_yr, childcare_yr, health_yr, transport_yr,
    total_share,
    slack_yr: hhi - (housing_yr + childcare_yr + health_yr + transport_yr + hhi * eff_tax)
  };
}

function rawScore(c) {
  const f = fixedShare(c);
  const ranges = {
    housing:   { lo: 0.06,  hi: 0.20,  val: f.housing_yr / f.hhi },
    tax:       { lo: 0.30,  hi: 0.45,  val: f.eff_tax },
    childcare: { lo: 0.00,  hi: 0.16,  val: f.childcare_yr / f.hhi },
    healthcare:{ lo: 0.014, hi: 0.030, val: f.health_yr / f.hhi },
    transport: { lo: 0.012, hi: 0.022, val: f.transport_yr / f.hhi }
  };
  const norm = (r) => Math.max(0, Math.min(1, (r.val - r.lo) / (r.hi - r.lo)));
  const score01 =
    norm(ranges.housing) * W.housing +
    norm(ranges.tax) * W.tax +
    norm(ranges.childcare) * W.childcare +
    norm(ranges.healthcare) * W.healthcare +
    norm(ranges.transport) * W.transport;
  return { score: Math.round(score01 * 100), f };
}

function verdict(score) {
  if (score >= 80) return { label: 'Wildly Quiet-Broke' };
  if (score >= 65) return { label: 'Comfortably Quiet-Broke' };
  if (score >= 45) return { label: 'Tight' };
  if (score >= 25) return { label: 'Quietly Comfortable' };
  return { label: 'Rich, full stop' };
}

const fmt$ = (n) => '$' + Math.round(n).toLocaleString();
const fmtK = (n) => '$' + Math.round(n / 1000) + 'k';
const pct  = (n) => (n * 100).toFixed(1) + '%';

// Rank everything once.
const ranked = DATA.cities
  .map((c) => ({ c, r: rawScore(c) }))
  .sort((a, b) => b.r.score - a.r.score);

// 30-metro medians for editorial context.
const medians = (() => {
  const sorted = (key, fn) => {
    const arr = DATA.cities.map(fn).sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  };
  return {
    rent: sorted('rent', (c) => c.median_3br_rent_mo),
    daycare: sorted('dc', (c) => c.median_ft_daycare_mo),
    tax: sorted('tax', (c) => c.eff_combined_tax_400k),
    transport: sorted('tr', (c) => c.commute_cost_mo),
    health: sorted('hl', (c) => c.family_health_premium_mo)
  };
})();

// --- editorial take generator ---
// Identifies the line item that's disproportionately driving the squeeze
// relative to the 30-metro median, and writes a one-paragraph diagnosis.
function take(c, r, rankIdx) {
  const housingShareGross = r.f.housing_yr / r.f.hhi;
  const housingMedShareGross = (medians.rent * 12) / DEFAULT_HHI;
  const taxDelta = c.eff_combined_tax_400k - medians.tax;
  const daycareDelta = c.median_ft_daycare_mo - medians.daycare;
  const slack = r.f.slack_yr;

  // pick the dominant story
  const housingRatio = c.median_3br_rent_mo / medians.rent;
  const isHousingHeavy = housingRatio >= 1.25;
  const isTaxHeavy = taxDelta >= 0.025;
  const isDaycareHeavy = daycareDelta >= 350;
  const isCheap = r.score < 30;

  const rankN = rankIdx + 1;
  const totalSharePct = (r.f.total_share * 100).toFixed(1) + '%';

  const headline = (() => {
    if (isCheap) {
      return `${c.name} is one of the most slack-rich metros in the index. A $400K household keeps roughly ${fmt$(slack)} a year after taxes and the four major fixed costs — closer to ${fmtK(slack)} of breathing room than most of America's coasts can dream of.`;
    }
    const parts = [];
    if (isHousingHeavy && isTaxHeavy) {
      parts.push(`${c.name}'s squeeze isn't one thing — it's two. The median 3BR runs ${fmt$(c.median_3br_rent_mo)}/month (${(housingShareGross*100).toFixed(1)}% of a $400K gross, vs. ${(housingMedShareGross*100).toFixed(1)}% for the 30-metro median), and the combined effective tax rate at $400K MFJ is ${(c.eff_combined_tax_400k*100).toFixed(1)}% — ${(taxDelta*100).toFixed(1)} points above the median metro.`);
    } else if (isHousingHeavy) {
      parts.push(`${c.name}'s pain isn't taxes — the effective rate at $400K (${(c.eff_combined_tax_400k*100).toFixed(1)}%) is within a percentage point of the 30-metro median. It's housing. The median 3BR is ${fmt$(c.median_3br_rent_mo)}/month, or ${(housingShareGross*100).toFixed(1)}% of gross before tax — meaningfully above the ${(housingMedShareGross*100).toFixed(1)}% median.`);
    } else if (isTaxHeavy) {
      parts.push(`${c.name}'s squeeze is mostly the tax bill. Housing comes in at ${fmt$(c.median_3br_rent_mo)}/month — manageable relative to coastal peers — but the combined federal + state + local effective rate at $400K MFJ is ${(c.eff_combined_tax_400k*100).toFixed(1)}%, ${(taxDelta*100).toFixed(1)} points above the 30-metro median. That's roughly ${fmt$(taxDelta*DEFAULT_HHI)} a year that never reaches your account.`);
    } else if (isDaycareHeavy) {
      parts.push(`${c.name}'s squeeze hides in childcare. Median full-time daycare runs ${fmt$(c.median_ft_daycare_mo)}/month — for two kids, that's ${fmt$(c.median_ft_daycare_mo*2*12)} a year before tax, off post-tax dollars. The housing line is closer to average, which is why ${c.name} surprises people on this list.`);
    } else {
      parts.push(`${c.name} ranks ${rankN} of 30 not because any single line item is brutal, but because all five are above-average at once. Housing is ${fmt$(c.median_3br_rent_mo)}/month, childcare runs ${fmt$(c.median_ft_daycare_mo)}/kid, and the combined effective tax rate is ${(c.eff_combined_tax_400k*100).toFixed(1)}%. None of these alone would make the news. Stacked, they consume ${totalSharePct} of a $400K gross.`);
    }
    return parts.join(' ');
  })();

  const closer = (() => {
    if (isCheap) {
      return ` The thing to be honest about: comfort here is mostly geography, not virtue. The same gross in San Francisco or New York would feel completely different.`;
    }
    if (slack < 30000) {
      return ` After the five fixed costs and taxes, the slack on a $400K HHI is roughly ${fmt$(slack)} a year. That's the entire budget for savings, retirement, discretionary, and surprises.`;
    }
    return ` After the five fixed costs and taxes, the slack on a $400K HHI here is about ${fmt$(slack)} a year — real money, but a long way from "rich."`;
  })();

  return headline + closer;
}

// --- neighbor helpers ---
function neighbors(idx) {
  const moreSqueezed = ranked.slice(Math.max(0, idx - 3), idx).reverse();
  const lessSqueezed = ranked.slice(idx + 1, idx + 4);
  return { moreSqueezed, lessSqueezed };
}

// --- HTML helpers ---
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function neighborLi(row) {
  return `<li><a href="${row.c.slug}.html">${escapeHtml(row.c.name)}, ${row.c.state}</a><span class="s">${row.r.score}</span></li>`;
}

function cityPage(idx, row) {
  const c = row.c;
  const r = row.r;
  const v = verdict(r.score);
  const rankN = idx + 1;
  const { moreSqueezed, lessSqueezed } = neighbors(idx);
  const editorial = take(c, r, idx);

  const title = `${c.name}, ${c.state} Quiet-Broke Score: ${r.score} / 100 (Rank ${rankN} of 30)`;
  const desc = `How squeezed is a $400K household in ${c.name}, ${c.state}? Quiet-Broke Index score: ${r.score}/100, rank ${rankN} of 30 US metros. Median 3BR rent ${fmt$(c.median_3br_rent_mo)}/mo, effective tax ${pct(c.eff_combined_tax_400k)}.`;
  const canonical = `https://jeevesagency.github.io/quiet-broke-index/city/${c.slug}.html`;

  const moreHtml = moreSqueezed.length
    ? `<div class="neighbors-col"><h3>More squeezed than ${escapeHtml(c.name)}</h3><ul>${moreSqueezed.map(neighborLi).join('')}</ul></div>`
    : `<div class="neighbors-col"><h3>More squeezed than ${escapeHtml(c.name)}</h3><p style="color:var(--ink-mute); font-size:14px;">Nothing in the 30-metro set scores higher. ${escapeHtml(c.name)} is the most-squeezed metro on the index.</p></div>`;

  const lessHtml = lessSqueezed.length
    ? `<div class="neighbors-col"><h3>Less squeezed than ${escapeHtml(c.name)}</h3><ul>${lessSqueezed.map(neighborLi).join('')}</ul></div>`
    : `<div class="neighbors-col"><h3>Less squeezed than ${escapeHtml(c.name)}</h3><p style="color:var(--ink-mute); font-size:14px;">Nothing in the 30-metro set scores lower. ${escapeHtml(c.name)} is the least-squeezed metro on the index.</p></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}" />
<link rel="canonical" href="${canonical}" />
<meta property="og:title" content="${escapeHtml(c.name)}, ${c.state}: Quiet-Broke score ${r.score}/100" />
<meta property="og:description" content="${escapeHtml(desc)}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${canonical}" />
<meta property="og:image" content="https://jeevesagency.github.io/quiet-broke-index/assets/og.png" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="../style.css" />
</head>
<body>

<div class="topbar">
  <div class="topbar-inner">
    <div class="brand"><a href="../">The Quiet-Broke Index</a> <span class="by">a Henry Finance research project</span></div>
    <a class="sub" href="https://henryfinance.substack.com/subscribe?utm_source=quietbroke&utm_medium=citypage&utm_content=${c.slug}" target="_blank" rel="noopener">Subscribe free</a>
  </div>
</div>

<section class="city-hero">
  <div class="container">
    <div class="eyebrow"><a href="../" style="color:inherit; border-bottom:1px solid var(--line);">← The Quiet-Broke Index</a> · ${c.state} · v0.1</div>
    <h1>${escapeHtml(c.name)}, ${c.state}: <span class="accent">${v.label.toLowerCase()}</span></h1>

    <div class="summary-row">
      <div class="big-score">
        <div class="num">${r.score}</div>
        <div class="max">/ 100</div>
        <div class="rk">Rank ${rankN} / 30</div>
      </div>
      <div class="take">
        <div class="verdict-label">What's distinctive about ${escapeHtml(c.name)}'s squeeze</div>
        <p>${editorial}</p>
        <div class="stat-mini">
          <div><div class="n">${fmt$(c.median_3br_rent_mo)}</div><div class="l">Median 3BR rent / month</div></div>
          <div><div class="n">${pct(c.eff_combined_tax_400k)}</div><div class="l">Combined effective tax at $400K MFJ</div></div>
          <div><div class="n">${fmt$(c.median_ft_daycare_mo)}</div><div class="l">Median full-time daycare / month</div></div>
          <div><div class="n">${fmt$(r.f.slack_yr)}</div><div class="l">Post-fixed-cost slack / year</div></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="container">
  <div class="calc" id="calc">
    <h2>Run the numbers for your household</h2>
    <p class="sub">Pre-filled with ${escapeHtml(c.name)} metro defaults. Override anything that doesn't match your situation.</p>
    <div class="grid">
      <div class="field">
        <label for="i-hhi">Household income (W-2 + RSU, pre-tax)</label>
        <input type="number" id="i-hhi" value="400000" min="100000" max="2000000" step="5000" />
        <div class="hint">Cash + vested equity. Don't subtract anything yet.</div>
      </div>
      <div class="field">
        <label for="i-city">City / metro</label>
        <select id="i-city"></select>
        <div class="hint">Anchored to the metro's median 3BR rent / daycare / etc.</div>
      </div>
      <div class="field">
        <label for="i-rent">Your housing cost (monthly)</label>
        <input type="number" id="i-rent" value="" placeholder="auto-fills from metro" min="0" step="50" />
        <div class="hint">Rent or PITI. Leave blank to use metro median.</div>
      </div>
      <div class="field">
        <label for="i-kids">Kids in full-time care</label>
        <select id="i-kids">
          <option value="0">0</option>
          <option value="1">1</option>
          <option value="2" selected>2</option>
          <option value="3">3</option>
        </select>
        <div class="hint">Counts full-day daycare or after-school + nanny share.</div>
      </div>
      <div class="field">
        <label for="i-health">Family health premium (monthly, your share)</label>
        <input type="number" id="i-health" value="" placeholder="auto-fills from metro" min="0" step="10" />
        <div class="hint">The number that comes off your paycheck. Not the employer's share.</div>
      </div>
      <div class="field">
        <label for="i-transport">Transport (monthly, all-in)</label>
        <input type="number" id="i-transport" value="" placeholder="auto-fills from metro" min="0" step="10" />
        <div class="hint">Two car payments + insurance + gas, or transit + Uber, or one of each.</div>
      </div>
    </div>
    <div class="actions">
      <button class="btn-primary" id="calc-btn">Compute my score</button>
      <button class="btn-ghost" id="reset-btn">Reset to metro defaults</button>
    </div>

    <div class="result" id="result">
      <div class="verdict-row">
        <div class="score-bubble"><div class="num" id="r-score">—</div><div class="max">/ 100</div></div>
        <div class="verdict-text">
          <div class="verdict-label" id="r-label">—</div>
          <div class="verdict-detail" id="r-detail">—</div>
        </div>
      </div>

      <div class="breakdown">
        <h3 style="font-size:17px;margin-bottom:10px;">Where the money goes</h3>
        <table id="r-breakdown"><tbody></tbody></table>
      </div>

      <div class="subscribe-cta">
        <h3>Get the deep dive on your three biggest leaks.</h3>
        <p>We send one Henry Finance issue every Tuesday and Friday. No spam. The next one ranks the tactical fixes for your top three line items — childcare arbitrage, the AMT/SALT shift, and house-rich/cash-poor traps.</p>
        <form class="sub-form" id="sub-form">
          <input type="email" id="sub-email" placeholder="you@whereveryou.work" required />
          <button type="submit" class="btn-primary">Send me the playbook</button>
        </form>
        <div class="sub-status" id="sub-status"></div>
      </div>

      <div class="share-row">
        <div class="pill" id="share-twitter">Share on X</div>
        <div class="pill" id="share-copy">Copy result link</div>
        <div class="pill" id="share-substack">Restack on Substack</div>
      </div>
    </div>
  </div>
</section>

<section class="container neighbors">
  <h2>How ${escapeHtml(c.name)} compares</h2>
  <p class="sub">The neighbors on either side of ${escapeHtml(c.name)} in the 30-metro ranking.</p>
  <div class="neighbors-grid">
    ${moreHtml}
    ${lessHtml}
  </div>
  <p style="margin-top: 24px;"><a href="../#rank">See the full 30-city ranking →</a></p>
</section>

<section class="container" style="padding: 24px 22px 56px;">
  <div class="subscribe-cta" style="margin: 0;">
    <h3>Henry Finance — for high earners who don't feel rich.</h3>
    <p>One free issue every Tuesday and Friday. Frameworks, not formulas. Written by a HENRY for HENRYs. No "10x your wealth" content. No pop-ups.</p>
    <form class="sub-form" onsubmit="event.preventDefault(); window.open('https://henryfinance.substack.com/subscribe?email=' + encodeURIComponent(this.querySelector('input').value) + '&utm_source=quietbroke&utm_medium=citypage&utm_content=${c.slug}', '_blank', 'noopener');">
      <input type="email" placeholder="you@whereveryou.work" required />
      <button type="submit" class="btn-primary">Subscribe (free)</button>
    </form>
  </div>
</section>

<footer>
  <div class="container">
    <p><strong>The Quiet-Broke Index</strong> is a research project of <a href="https://henryfinance.substack.com/?utm_source=quietbroke&utm_medium=citypage-footer&utm_content=${c.slug}">Henry Finance</a> — a twice-weekly newsletter for high earners who don't feel rich.</p>
    <p>v0.1, May 2026. Numbers refresh monthly. <a href="../">Back to the index</a> · <a href="../methodology.html">Methodology</a> · <a href="https://henryfinance.substack.com/?utm_source=quietbroke&utm_medium=citypage-footer-2&utm_content=${c.slug}">Subscribe (free)</a></p>
  </div>
</footer>

<script>
  // Set default city in the embedded calculator before app.js loads
  window.QBI_DEFAULT_CITY = ${JSON.stringify(c.slug)};
</script>
<script src="../app.js"></script>
</body>
</html>
`;
}

// write all pages
let count = 0;
ranked.forEach((row, idx) => {
  const html = cityPage(idx, row);
  fs.writeFileSync(path.join(OUT_DIR, row.c.slug + '.html'), html);
  count++;
});

console.log(`Wrote ${count} city pages to ${OUT_DIR}`);
