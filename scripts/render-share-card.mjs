// Renders a sample share card to /tmp/share-card-sample.png using node-canvas.
// Run: node scripts/render-share-card.mjs
// This mirrors the buildShareCanvas() logic in docs/app.js exactly.

import { createCanvas, registerFont } from 'canvas';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/data/cities.json'), 'utf8'));

// ---- helpers (mirror app.js) ----
const fmt$ = (n) => '$' + Math.round(n).toLocaleString();
const pct  = (n) => (n * 100).toFixed(1) + '%';

function fixedShare(c, override) {
  const hhi = (override && override.hhi) || DATA._meta.default_hhi;
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
  return {
    hhi, post_tax, eff_tax,
    housing_yr, childcare_yr, health_yr, transport_yr,
    housing_share: housing_yr / post_tax,
    childcare_share: childcare_yr / post_tax,
    health_share: health_yr / post_tax,
    transport_share: transport_yr / post_tax,
    tax_share: eff_tax,
    total_share: (housing_yr + childcare_yr + health_yr + transport_yr + hhi * eff_tax) / hhi,
    slack_yr: hhi - (housing_yr + childcare_yr + health_yr + transport_yr + hhi * eff_tax),
  };
}

function rawScore(c) {
  const W = DATA.weights;
  const f = fixedShare(c);
  const ranges = {
    housing:   { lo: 0.06,  hi: 0.20,  val: f.housing_yr / f.hhi },
    tax:       { lo: 0.30,  hi: 0.45,  val: f.eff_tax },
    childcare: { lo: 0.00,  hi: 0.16,  val: f.childcare_yr / f.hhi },
    healthcare:{ lo: 0.014, hi: 0.030, val: f.health_yr / f.hhi },
    transport: { lo: 0.012, hi: 0.022, val: f.transport_yr / f.hhi },
  };
  const norm = (r) => Math.max(0, Math.min(1, (r.val - r.lo) / (r.hi - r.lo)));
  const s = norm(ranges.housing) * W.housing
          + norm(ranges.tax) * W.tax
          + norm(ranges.childcare) * W.childcare
          + norm(ranges.healthcare) * W.healthcare
          + norm(ranges.transport) * W.transport;
  return { score: Math.round(s * 100), f };
}

function verdict(score) {
  if (score >= 80) return { label: 'Wildly Quiet-Broke' };
  if (score >= 65) return { label: 'Comfortably Quiet-Broke' };
  if (score >= 45) return { label: 'Tight' };
  if (score >= 25) return { label: 'Quietly Comfortable' };
  return { label: 'Rich, full stop' };
}

// ---- pick a sample city (New York) ----
const c = DATA.cities.find(x => x.slug === 'new-york-ny');
const r = rawScore(c);
const v = verdict(r.score);

// ---- palette ----
const BG       = '#f7f4ee';
const CARD_BG  = '#fffdf8';
const INK      = '#1b1a17';
const INK_S    = '#4a4742';
const INK_M    = '#7a766f';
const ACCENT   = '#b3361f';
const LINE     = '#d9d2c6';
const LINE_S   = '#ebe6dc';
const ACCENT_S = '#f3dfd6';

const W_PX = 1200, H_PX = 630;
const canvas = createCanvas(W_PX, H_PX);
const ctx = canvas.getContext('2d');

// background
ctx.fillStyle = BG;
ctx.fillRect(0, 0, W_PX, H_PX);

// top accent stripe
ctx.fillStyle = ACCENT;
ctx.fillRect(0, 0, W_PX, 7);

// brand eyebrow
ctx.fillStyle = ACCENT;
ctx.font = "italic bold 15px serif";
ctx.fillText('THE QUIET-BROKE INDEX', 72, 58);

// big score
ctx.fillStyle = INK;
ctx.font = "bold 120px serif";
ctx.fillText(String(r.score), 72, 210);

// " / 100" suffix
ctx.font = "bold 120px serif";
const bigW = ctx.measureText(String(r.score)).width;
ctx.font = "normal 26px serif";
ctx.fillStyle = INK_M;
ctx.fillText('/ 100', 72 + bigW + 10, 210);

// verdict label (word-wrap, 900px max)
const verdictMaxW = 900;
ctx.font = "bold 34px serif";
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
  ctx.font = "bold 34px serif";
  ctx.fillStyle = INK;
  ctx.fillText(ln, 72, verdictBaseY + i * 42);
});

// city name
ctx.font = "normal 18px sans-serif";
ctx.fillStyle = INK_M;
ctx.fillText(c.name + ', ' + c.state, 72, verdictBaseY + verdictLines.length * 42 + 8);

// divider
const divY = verdictBaseY + verdictLines.length * 42 + 38;
ctx.strokeStyle = LINE;
ctx.lineWidth = 1;
ctx.beginPath();
ctx.moveTo(72, divY);
ctx.lineTo(W_PX - 72, divY);
ctx.stroke();

// line items
const footerH = 44;
const available = H_PX - divY - 16 - footerH;
const rowH = Math.floor(available / 5);
const bandY = divY + 16;
const labelW = 130;
const barAreaX = 72 + labelW + 16;
const barAreaW = W_PX - 72 - barAreaX - 200;
const valX = W_PX - 72;

const lines = [
  { label: 'Tax',        amt: r.f.eff_tax * r.f.hhi,  share: r.f.tax_share },
  { label: 'Housing',    amt: r.f.housing_yr,          share: r.f.housing_yr / r.f.hhi },
  { label: 'Childcare',  amt: r.f.childcare_yr,        share: r.f.childcare_yr / r.f.hhi },
  { label: 'Healthcare', amt: r.f.health_yr,            share: r.f.health_yr / r.f.hhi },
  { label: 'Transport',  amt: r.f.transport_yr,         share: r.f.transport_yr / r.f.hhi },
];
const maxShare = Math.max(...lines.map(l => l.share));

lines.forEach((ln, i) => {
  const y = bandY + i * rowH;
  const midY = y + rowH / 2;

  ctx.font = "normal 14px sans-serif";
  ctx.fillStyle = INK_S;
  ctx.fillText(ln.label, 72, midY + 5);

  const barH = 8;
  const barY = midY - barH / 2;
  ctx.fillStyle = LINE_S;
  ctx.fillRect(barAreaX, barY, barAreaW, barH);

  const fillW = Math.round((ln.share / maxShare) * barAreaW);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(barAreaX, barY, fillW, barH);

  ctx.font = "bold 14px sans-serif";
  ctx.fillStyle = INK;
  ctx.textAlign = 'right';
  ctx.fillText(fmt$(ln.amt) + '/yr', valX, midY + 4);

  ctx.font = "normal 12px sans-serif";
  ctx.fillStyle = INK_M;
  ctx.fillText('(' + pct(ln.share) + ')', valX, midY + 18);
  ctx.textAlign = 'left';
});

// footer
const footY = H_PX - 18;
ctx.fillStyle = INK_M;
ctx.font = "normal 13px sans-serif";
ctx.fillText('quietbrokeindex.com  ·  Henry Finance research  ·  henryfinance.substack.com', 72, footY);

// write out
const out = '/tmp/share-card-sample.png';
const buf = canvas.toBuffer('image/png');
fs.writeFileSync(out, buf);
console.log('Wrote', out, '—', Math.round(buf.length / 1024) + ' KB');
console.log('City:', c.name, c.state, '| Score:', r.score, '| Verdict:', v.label);
