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

// --- editorial take generator (hero blurb) ---
function take(c, r, rankIdx) {
  const housingShareGross = r.f.housing_yr / r.f.hhi;
  const housingMedShareGross = (medians.rent * 12) / DEFAULT_HHI;
  const taxDelta = c.eff_combined_tax_400k - medians.tax;
  const daycareDelta = c.median_ft_daycare_mo - medians.daycare;
  const slack = r.f.slack_yr;

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

// --- article body generator ---
// Generates a unique 600-800 word article section for each city.
// Each section covers: lead paragraph, score drivers, peer comparison, who feels the squeeze, data caveats.

function articleBody(idx, row) {
  const c = row.c;
  const r = row.r;
  const rankN = idx + 1;
  const slack = r.f.slack_yr;
  const { moreSqueezed, lessSqueezed } = neighbors(idx);

  // Compare to 30-metro median for each line item
  const housingPctOfGross = (c.median_3br_rent_mo * 12 / DEFAULT_HHI * 100).toFixed(1);
  const medHousingPctOfGross = (medians.rent * 12 / DEFAULT_HHI * 100).toFixed(1);
  const taxDelta = ((c.eff_combined_tax_400k - medians.tax) * 100).toFixed(1);
  const taxDeltaNum = c.eff_combined_tax_400k - medians.tax;
  const daycareDelta = c.median_ft_daycare_mo - medians.daycare;
  const healthDelta = c.family_health_premium_mo - medians.health;
  const transportDelta = c.commute_cost_mo - medians.transport;

  // Comparison cities: pick 2-3 instructive peers from ranked list
  // Prefer cities that score within ~10 points (similar) or far apart (contrasting)
  const peerCandidates = ranked.filter((row2, i) => i !== idx);
  const similarPeers = peerCandidates.filter(row2 => Math.abs(row2.r.score - r.score) <= 8 && row2.r.score !== r.score).slice(0, 2);
  const contrastPeers = peerCandidates.filter(row2 => Math.abs(row2.r.score - r.score) >= 20).slice(0, 1);
  const compPeers = [...similarPeers, ...contrastPeers].slice(0, 3);
  // fallback to neighbors if not enough peers
  const peersToUse = compPeers.length >= 2 ? compPeers : [...moreSqueezed.slice(0,1), ...lessSqueezed.slice(0,2)].filter(Boolean);

  // Archetype: calculate slack for a 2-kid household vs a contrasting city
  const cheapCity = ranked[ranked.length - 1];
  const expensiveCity = ranked[0];
  const archetypeCity = r.score < 40 ? expensiveCity : cheapCity;
  const archetypeSlack = archetypeCity.r.f.slack_yr;

  // City-specific editorial angles
  const housingAngle = (() => {
    const ratio = c.median_3br_rent_mo / medians.rent;
    if (ratio >= 1.5) return `Housing is the dominant cost — ${fmt$(c.median_3br_rent_mo)}/month for a median 3BR is ${(ratio).toFixed(2)}x the 30-metro median of ${fmt$(medians.rent)}. That single line item eats ${housingPctOfGross}% of gross income before you've paid a dollar in tax, versus a ${medHousingPctOfGross}% median across all 30 metros.`;
    if (ratio >= 1.2) return `Housing runs ${fmt$(c.median_3br_rent_mo)}/month for a median 3BR — well above the 30-metro median of ${fmt$(medians.rent)} (${medHousingPctOfGross}% of gross). At ${housingPctOfGross}% of a $400K gross, it's the largest single drain in the budget.`;
    if (ratio <= 0.75) return `Housing is one of ${c.name}'s genuine advantages. The median 3BR clocks in at ${fmt$(c.median_3br_rent_mo)}/month, just ${housingPctOfGross}% of a $400K gross — far below the 30-metro median of ${fmt$(medians.rent)} (${medHousingPctOfGross}% of gross). That gap alone is worth ${fmt$((medians.rent - c.median_3br_rent_mo) * 12)} a year in slack.`;
    return `Housing is close to the 30-metro median, at ${fmt$(c.median_3br_rent_mo)}/month (${housingPctOfGross}% of gross) versus a metro-wide median of ${fmt$(medians.rent)} (${medHousingPctOfGross}% of gross). Not cheap, not the headline story.`;
  })();

  const taxAngle = (() => {
    const taxPct = (c.eff_combined_tax_400k * 100).toFixed(1);
    const medTaxPct = (medians.tax * 100).toFixed(1);
    const taxBite = Math.round(c.eff_combined_tax_400k * DEFAULT_HHI);
    if (taxDeltaNum >= 0.03) return `Taxes are a meaningful drag. At ${taxPct}% combined effective rate for MFJ at $400K, ${c.name} runs ${taxDelta} points above the 30-metro median of ${medTaxPct}%. That difference is roughly ${fmt$(taxDeltaNum * DEFAULT_HHI)} more in annual taxes than the median metro — money that simply doesn't land in your account.`;
    if (taxDeltaNum <= -0.03) return `Taxes are a genuine tailwind here. The combined effective rate at $400K MFJ is ${taxPct}% — ${Math.abs(parseFloat(taxDelta))} points below the 30-metro median of ${medTaxPct}%. The state has no income tax, which keeps ${fmt$(Math.abs(taxDeltaNum) * DEFAULT_HHI)} a year in the household versus a median-tax metro.`;
    return `Taxes are near the 30-metro median. The combined effective rate for MFJ at $400K is ${taxPct}% (median: ${medTaxPct}%), which translates to ${fmt$(taxBite)} in annual taxes. No particular advantage or disadvantage here.`;
  })();

  const childcareAngle = (() => {
    const twoKidYr = c.median_ft_daycare_mo * 2 * 12;
    const medTwoKidYr = medians.daycare * 2 * 12;
    if (daycareDelta >= 400) return `Childcare costs sting. Full-time daycare runs ${fmt$(c.median_ft_daycare_mo)}/month per child — for two kids, that's ${fmt$(twoKidYr)}/year, or ${fmt$(twoKidYr - medTwoKidYr)} more than the 30-metro median of ${fmt$(medians.daycare)}/month. These are post-tax dollars, so the real gross equivalent at ${(c.eff_combined_tax_400k*100).toFixed(0)}% effective rate is closer to ${fmt$(twoKidYr / (1 - c.eff_combined_tax_400k))}.`;
    if (daycareDelta <= -250) return `Childcare is a relative relief. At ${fmt$(c.median_ft_daycare_mo)}/month per child, two kids in full-time care runs ${fmt$(twoKidYr)}/year — ${fmt$(medTwoKidYr - twoKidYr)} less than the 30-metro median. That's real savings for the family-formation cohort.`;
    return `Childcare is roughly average. Full-time care runs ${fmt$(c.median_ft_daycare_mo)}/month per child — for two kids, ${fmt$(twoKidYr)}/year total. The 30-metro median is ${fmt$(medians.daycare)}/month, so ${c.name} is within ${fmt$(Math.abs(daycareDelta))}/month of dead center.`;
  })();

  const healthAngle = (() => {
    const annualHealth = c.family_health_premium_mo * 12;
    const medAnnualHealth = medians.health * 12;
    if (healthDelta >= 40) return `Family health premiums (employee share) run ${fmt$(c.family_health_premium_mo)}/month — ${fmt$(healthDelta)}/month above the 30-metro median. At ${fmt$(annualHealth)}/year, this is a smaller line item than housing or taxes, but it's not nothing.`;
    if (healthDelta <= -40) return `Health premiums (employee share) are below average at ${fmt$(c.family_health_premium_mo)}/month. At ${fmt$(annualHealth)}/year, that's ${fmt$(medAnnualHealth - annualHealth)} less than the median metro.`;
    return `Health premiums (employee share) are close to the 30-metro average at ${fmt$(c.family_health_premium_mo)}/month, or ${fmt$(annualHealth)}/year. Not a distinguishing factor in ${c.name}'s score.`;
  })();

  const transportAngle = (() => {
    const annualTransport = c.commute_cost_mo * 12;
    if (transportDelta >= 40) return `Transport runs ${fmt$(c.commute_cost_mo)}/month all-in (two cars plus insurance and fuel, or a hybrid transit/rideshare mix), which is above average for the index. At ${fmt$(annualTransport)}/year, it adds meaningful pressure given the rest of the cost stack.`;
    if (transportDelta <= -40) return `Transport costs are lower than most metros at ${fmt$(c.commute_cost_mo)}/month all-in. At ${fmt$(annualTransport)}/year, this is one area where ${c.name} provides a modest offset against higher costs elsewhere.`;
    return `Transport comes in at ${fmt$(c.commute_cost_mo)}/month all-in — close to the 30-metro median. At ${fmt$(annualTransport)}/year, it's a steady fixed cost but not what's moving the needle on ${c.name}'s score.`;
  })();

  // Peer comparison section
  const peerParas = peersToUse.map(peerRow => {
    const p = peerRow.c;
    const pRankN = ranked.findIndex(rr => rr.c.slug === p.slug) + 1;
    const pSlack = peerRow.r.f.slack_yr;
    const scoreDiff = r.score - peerRow.r.score;
    const direction = scoreDiff > 0 ? 'more squeezed' : 'less squeezed';
    const absDiff = Math.abs(scoreDiff);
    if (absDiff <= 5) {
      return `<a href="${p.slug}.html">${p.name}, ${p.state}</a> (score ${peerRow.r.score}, rank ${pRankN}) is the closest comparable — nearly identical squeeze levels despite different cost structures. ${p.name} has housing at ${fmt$(p.median_3br_rent_mo)}/month and taxes at ${(p.eff_combined_tax_400k*100).toFixed(1)}%, while ${c.name} runs ${fmt$(c.median_3br_rent_mo)}/month and ${(c.eff_combined_tax_400k*100).toFixed(1)}% respectively. Same total pain, different sources.`;
    } else if (scoreDiff > 10) {
      return `<a href="${p.slug}.html">${p.name}, ${p.state}</a> (score ${peerRow.r.score}) is notably ${direction} than ${c.name}. The gap is mostly ${c.median_3br_rent_mo > p.median_3br_rent_mo ? 'housing' : c.eff_combined_tax_400k > p.eff_combined_tax_400k ? 'taxes' : 'childcare'} — ${c.name}'s ${c.median_3br_rent_mo > p.median_3br_rent_mo ? fmt$(c.median_3br_rent_mo) + ' median rent versus ' + fmt$(p.median_3br_rent_mo) : (c.eff_combined_tax_400k*100).toFixed(1) + '% effective tax versus ' + (p.eff_combined_tax_400k*100).toFixed(1) + '%'}. A $400K household in ${p.name} keeps ${fmt$(pSlack)}/year post-fixed-costs versus ${fmt$(slack)} in ${c.name}.`;
    } else {
      return `<a href="${p.slug}.html">${p.name}, ${p.state}</a> (score ${peerRow.r.score}) scores ${absDiff} points ${direction} than ${c.name}. The difference in post-fixed-cost slack is ${fmt$(Math.abs(slack - pSlack))}/year — meaningful but not city-changing. The two metros make an instructive comparison for households deciding between them.`;
    }
  });

  // Archetype section
  const archetypePara = (() => {
    const twoKidChildcare = c.median_ft_daycare_mo * 2 * 12;
    const taxBite = Math.round(c.eff_combined_tax_400k * DEFAULT_HHI);
    const fixedTotal = r.f.housing_yr + twoKidChildcare + r.f.health_yr + r.f.transport_yr + taxBite;

    if (r.score >= 55) {
      // High-squeeze city: focus on how little is left
      return `Take a dual-income couple in ${c.name}: both work in tech or finance, combined W-2 of $400K, two kids in full-time care, renting a median 3BR. Their tax bill is ${fmt$(taxBite)}/year. Housing eats another ${fmt$(r.f.housing_yr)}/year. Two kids in daycare at ${fmt$(c.median_ft_daycare_mo)}/month each: ${fmt$(twoKidChildcare)}/year. Health and transport add ${fmt$(r.f.health_yr + r.f.transport_yr)}/year. Total fixed obligations: ${fmt$(fixedTotal)} — leaving ${fmt$(slack)} for everything else. That's retirement contributions, college savings, vacations, car repairs, and any savings above the 401(k). It's workable, but it's not the "you're rich" number most people assume $400K to be.`;
    } else if (r.score >= 35) {
      // Mid-range city
      return `Consider a dual-income ${c.name} household earning $400K combined: federal and state taxes claim ${fmt$(taxBite)}/year. Rent at the median 3BR costs ${fmt$(r.f.housing_yr)}/year. Two kids in full-time care: ${fmt$(twoKidChildcare)}/year. Health premiums and transport add ${fmt$(r.f.health_yr + r.f.transport_yr)}/year. Fixed obligations total ${fmt$(fixedTotal)}, leaving ${fmt$(slack)}/year. Compare that to the same income in ${archetypeCity.c.name}: the post-fixed slack there is ${fmt$(archetypeSlack)}. The ${fmt$(Math.abs(slack - archetypeSlack))} gap is what "location arbitrage" actually looks like in dollar terms.`;
    } else {
      // Low-squeeze city: highlight the advantage vs coastal peer
      return `Run the numbers for a $400K dual-income ${c.name} household with two kids: taxes take ${fmt$(taxBite)}/year. Housing at ${fmt$(r.f.housing_yr)}/year. Two kids in daycare at ${fmt$(c.median_ft_daycare_mo)}/month each: ${fmt$(twoKidChildcare)}/year. Health and transport: ${fmt$(r.f.health_yr + r.f.transport_yr)}/year. Fixed obligations total ${fmt$(fixedTotal)}, leaving ${fmt$(slack)}/year in post-fixed slack. For comparison, the same household in ${archetypeCity.c.name} (score ${archetypeCity.r.score}) keeps only ${fmt$(archetypeSlack)}/year — ${fmt$(slack - archetypeSlack)} less. That difference, compounded over a decade, is a material wealth gap.`;
    }
  })();

  // Caveats section
  const caveatPara = (() => {
    const caveats = [];

    // Tax caveat
    caveats.push(`The tax rate used here is an effective rate estimate for a $400K MFJ household in ${c.name} — it blends federal, state, and city income tax with payroll taxes, and does not account for RSU timing, alternative minimum tax, or SALT deduction phase-outs, all of which can shift your actual bill by several percentage points.`);

    // Childcare caveat (if city has above-average costs, mention private school)
    if (c.median_ft_daycare_mo > medians.daycare) {
      caveats.push(`The childcare figure covers full-time daycare for young children. Once kids reach school age, the choice between public and private school in ${c.name} can swing this line item by ${fmt$(15000)} to ${fmt$(45000)}/year per child — a scenario the index doesn't model.`);
    } else {
      caveats.push(`The childcare figure covers full-time daycare. Private school tuition in ${c.name} can add ${fmt$(15000)} to ${fmt$(40000)}/year per child once kids hit school age — a scenario the index doesn't capture.`);
    }

    // Partner income caveat
    caveats.push(`This model assumes a two-earner household. Single-income households at $400K face a structurally different tax profile (often more favorable at this income level due to bracket differences), and households where one partner has large RSU cliff vests will see income concentration risk that changes the picture significantly from year to year.`);

    return caveats.slice(0, 3).map(s => `<p>${s}</p>`).join('\n');
  })();

  return `
<section class="container city-article" style="padding: 40px 22px 0;">
  <article>
    <h1 style="font-size:clamp(22px,4vw,34px); font-family: var(--serif); font-weight:700; line-height:1.2; margin-bottom:20px;">${escapeHtml(c.name)} Quiet-Broke Index: How squeezed is a $400K household in ${escapeHtml(c.name)}?</h1>

    <p class="sub" style="font-size:17px; line-height:1.6; margin-bottom:32px;">${c.name} earns a Quiet-Broke score of <strong>${r.score} out of 100</strong>, ranking it <strong>${rankN} of 30 metros</strong> tracked in this index — the higher the score, the more squeezed a $400K household feels. ${take(c, r, idx)} For the full methodology behind these numbers, see the <a href="../methodology.html">methodology page</a> and the original <a href="https://henryfinance.substack.com/p/the-quiet-broke-index" target="_blank" rel="noopener">Henry Finance deep dive on the Quiet-Broke Index</a>.</p>

    <h2 style="font-family: var(--serif); font-weight:700; font-size:clamp(18px,3vw,26px); margin: 32px 0 16px;">What drives ${escapeHtml(c.name)}'s score</h2>
    <p>Five line items go into the index. Here is how ${escapeHtml(c.name)} stacks up on each, relative to the 30-metro median:</p>

    <h3 style="font-size:17px; font-weight:600; margin: 24px 0 8px;">Housing</h3>
    <p>${housingAngle}</p>

    <h3 style="font-size:17px; font-weight:600; margin: 24px 0 8px;">Taxes</h3>
    <p>${taxAngle}</p>

    <h3 style="font-size:17px; font-weight:600; margin: 24px 0 8px;">Childcare</h3>
    <p>${childcareAngle}</p>

    <h3 style="font-size:17px; font-weight:600; margin: 24px 0 8px;">Healthcare</h3>
    <p>${healthAngle}</p>

    <h3 style="font-size:17px; font-weight:600; margin: 24px 0 8px;">Transport</h3>
    <p>${transportAngle}</p>

    <h2 style="font-family: var(--serif); font-weight:700; font-size:clamp(18px,3vw,26px); margin: 40px 0 16px;">Compare to other metros</h2>
    <p>Context matters. Here are the cities that score closest to ${escapeHtml(c.name)}, and what the comparison reveals about different ways to arrive at the same squeeze level:</p>
    <ul style="padding-left:20px; line-height:1.8;">
      ${peersToUse.map(peerRow => `<li>${peerParas[peersToUse.indexOf(peerRow)]}</li>`).join('\n      ')}
    </ul>
    <p>See where every metro lands on the <a href="../">Quiet-Broke Index home page</a>.</p>

    <h2 style="font-family: var(--serif); font-weight:700; font-size:clamp(18px,3vw,26px); margin: 40px 0 16px;">Who feels the squeeze most in ${escapeHtml(c.name)}</h2>
    <p>${archetypePara}</p>

    <h2 style="font-family: var(--serif); font-weight:700; font-size:clamp(18px,3vw,26px); margin: 40px 0 16px;">What the data leaves out</h2>
    ${caveatPara}
    <p style="font-size:14px; color: var(--ink-mute); margin-top:16px;">Full data sources and methodology: <a href="../methodology.html">Quiet-Broke Index methodology</a>. Original research: <a href="https://henryfinance.substack.com/p/the-quiet-broke-index" target="_blank" rel="noopener">Henry Finance — The Quiet-Broke Index</a>.</p>
  </article>
</section>
`;
}

function cityPage(idx, row) {
  const c = row.c;
  const r = row.r;
  const v = verdict(r.score);
  const rankN = idx + 1;
  const { moreSqueezed, lessSqueezed } = neighbors(idx);
  const editorial = take(c, r, idx);

  // SEO-optimized title and description
  const title = `${c.name}, ${c.state} Quiet-Broke Index: How squeezed is a $400K household in ${c.name}?`;
  const slack = r.f.slack_yr;
  const slackK = Math.round(slack / 1000);

  // Unique meta description 155-160 chars
  const descCore = `Score: ${r.score}/100, rank ${rankN} of 30. Median 3BR: ${fmt$(c.median_3br_rent_mo)}/mo, tax rate: ${pct(c.eff_combined_tax_400k)}, post-fixed slack: ${fmt$(slack)}/yr.`;
  const desc = `$400K in ${c.name}, ${c.state}? Quiet-Broke Index: squeezed-${r.score >= 50 ? 'hard' : 'moderate'}, rank ${rankN}/30. ${fmt$(c.median_3br_rent_mo)}/mo rent, ${pct(c.eff_combined_tax_400k)} effective tax, ${fmt$(slack)}/yr left after fixed costs.`.slice(0, 160);

  const canonical = `https://jeevesagency.github.io/quiet-broke-index/city/${c.slug}.html`;
  const ogImage = `https://jeevesagency.github.io/quiet-broke-index/assets/og.png`;

  const moreHtml = moreSqueezed.length
    ? `<div class="neighbors-col"><h3>More squeezed than ${escapeHtml(c.name)}</h3><ul>${moreSqueezed.map(neighborLi).join('')}</ul></div>`
    : `<div class="neighbors-col"><h3>More squeezed than ${escapeHtml(c.name)}</h3><p style="color:var(--ink-mute); font-size:14px;">Nothing in the 30-metro set scores higher. ${escapeHtml(c.name)} is the most-squeezed metro on the index.</p></div>`;

  const lessHtml = lessSqueezed.length
    ? `<div class="neighbors-col"><h3>Less squeezed than ${escapeHtml(c.name)}</h3><ul>${lessSqueezed.map(neighborLi).join('')}</ul></div>`
    : `<div class="neighbors-col"><h3>Less squeezed than ${escapeHtml(c.name)}</h3><p style="color:var(--ink-mute); font-size:14px;">Nothing in the 30-metro set scores lower. ${escapeHtml(c.name)} is the least-squeezed metro on the index.</p></div>`;

  const articleSection = articleBody(idx, row);

  // JSON-LD Article structured data
  const articleJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": `${c.name} Quiet-Broke Index: How squeezed is a $400K household in ${c.name}?`,
    "author": { "@type": "Organization", "name": "Henry Finance" },
    "datePublished": "2026-05-01",
    "dateModified": "2026-05-14",
    "image": ogImage,
    "publisher": {
      "@type": "Organization",
      "name": "Henry Finance",
      "logo": { "@type": "ImageObject", "url": ogImage }
    },
    "mainEntityOfPage": { "@type": "WebPage", "@id": canonical },
    "description": desc
  });

  // JSON-LD BreadcrumbList
  const breadcrumbJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://jeevesagency.github.io/quiet-broke-index/" },
      { "@type": "ListItem", "position": 2, "name": "Cities", "item": "https://jeevesagency.github.io/quiet-broke-index/#rank" },
      { "@type": "ListItem", "position": 3, "name": `${c.name}, ${c.state}`, "item": canonical }
    ]
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}" />
<link rel="canonical" href="${canonical}" />
<meta property="og:title" content="${escapeHtml(c.name)}, ${c.state} Quiet-Broke Index: $400K household squeeze score ${r.score}/100" />
<meta property="og:description" content="${escapeHtml(desc)}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${canonical}" />
<meta property="og:image" content="${ogImage}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(c.name)}, ${c.state}: Is $400K enough? Quiet-Broke score ${r.score}/100 (rank ${rankN}/30)" />
<meta name="twitter:description" content="${escapeHtml(desc)}" />
<meta name="twitter:image" content="${ogImage}" />
<script type="application/ld+json">${articleJsonLd}</script>
<script type="application/ld+json">${breadcrumbJsonLd}</script>
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
        <div class="pill pill-primary" id="share-card-download">Download score card</div>
        <div class="pill" id="share-card-copy">Copy image</div>
      </div>
    </div>
  </div>
</section>

${articleSection}

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
<!-- Cloudflare Web Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "2e85ea576f9b4b69868ea3ff07c4018c"}'></script><!-- End Cloudflare Web Analytics -->
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
