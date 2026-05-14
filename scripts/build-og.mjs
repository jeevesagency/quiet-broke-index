// Build the static OG card at docs/assets/og.png (1200x630).
// Generates SVG then rasterizes via ImageMagick. Pure-static, runs once per release.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/data/cities.json'), 'utf8'));
const ASSETS = path.join(ROOT, 'docs/assets');
fs.mkdirSync(ASSETS, { recursive: true });

const W = DATA.weights;
const DEFAULT_HHI = DATA._meta.default_hhi;

function rawScore(c) {
  const hhi = DEFAULT_HHI;
  const eff_tax = c.eff_combined_tax_400k;
  const housing_yr = c.median_3br_rent_mo * 12;
  const childcare_yr = 2 * c.median_ft_daycare_mo * 12;
  const health_yr = c.family_health_premium_mo * 12;
  const transport_yr = c.commute_cost_mo * 12;
  const ranges = {
    housing:   { lo: 0.06,  hi: 0.20,  val: housing_yr / hhi },
    tax:       { lo: 0.30,  hi: 0.45,  val: eff_tax },
    childcare: { lo: 0.00,  hi: 0.16,  val: childcare_yr / hhi },
    healthcare:{ lo: 0.014, hi: 0.030, val: health_yr / hhi },
    transport: { lo: 0.012, hi: 0.022, val: transport_yr / hhi }
  };
  const norm = (r) => Math.max(0, Math.min(1, (r.val - r.lo) / (r.hi - r.lo)));
  const s = norm(ranges.housing) * W.housing
          + norm(ranges.tax) * W.tax
          + norm(ranges.childcare) * W.childcare
          + norm(ranges.healthcare) * W.healthcare
          + norm(ranges.transport) * W.transport;
  return Math.round(s * 100);
}

const ranked = DATA.cities.map((c) => ({ c, s: rawScore(c) })).sort((a, b) => b.s - a.s);
// Pick four illustrative cities: top, near-top, mid, bottom.
const samples = [ranked[0], ranked[3], ranked[Math.floor(ranked.length / 2)], ranked[ranked.length - 1]];

// Colors (brand)
const BG = '#f7f4ee';
const INK = '#1b1a17';
const INK_SOFT = '#4a4742';
const INK_MUTE = '#7a766f';
const ACCENT = '#b3361f';
const LINE = '#d9d2c6';

// Build SVG. Use Georgia (Fraunces fallback per the site CSS) for serif headlines,
// system sans for the supporting text.
const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';

const cardX = 76;
const cardY = 410;
const cardW = 240;
const cardGap = 18;

function sampleCard(i, row) {
  const x = cardX + i * (cardW + cardGap);
  const y = cardY;
  return `
    <rect x="${x}" y="${y}" width="${cardW}" height="158" rx="8" fill="#fffdf8" stroke="${LINE}" stroke-width="1" />
    <text x="${x + 22}" y="${y + 40}" font-family="${SANS}" font-size="14" fill="${INK_MUTE}" letter-spacing="1.4">SCORE</text>
    <text x="${x + 22}" y="${y + 96}" font-family="${SERIF}" font-size="62" font-weight="700" fill="${INK}">${row.s}</text>
    <text x="${x + cardW - 22}" y="${y + 96}" text-anchor="end" font-family="${SANS}" font-size="16" fill="${INK_MUTE}">/ 100</text>
    <text x="${x + 22}" y="${y + 130}" font-family="${SERIF}" font-size="22" font-weight="600" fill="${INK}">${row.c.name}, ${row.c.state}</text>
  `;
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}" />

  <!-- subtle border -->
  <rect x="0" y="0" width="1200" height="8" fill="${ACCENT}" />

  <!-- eyebrow -->
  <text x="76" y="92" font-family="${SANS}" font-size="18" fill="${INK_MUTE}" letter-spacing="2.2" font-weight="500">HENRY FINANCE RESEARCH · v0.1</text>

  <!-- headline -->
  <text x="76" y="190" font-family="${SERIF}" font-size="84" font-weight="700" fill="${INK}" letter-spacing="-2">The </text>
  <text x="206" y="190" font-family="${SERIF}" font-size="84" font-weight="700" font-style="italic" fill="${ACCENT}" letter-spacing="-2">Quiet-Broke</text>
  <text x="708" y="190" font-family="${SERIF}" font-size="84" font-weight="700" fill="${INK}" letter-spacing="-2"> Index</text>

  <!-- subhead -->
  <text x="76" y="260" font-family="${SERIF}" font-size="32" fill="${INK_SOFT}">How squeezed is a $400K household in your city?</text>

  <!-- divider -->
  <line x1="76" y1="320" x2="1124" y2="320" stroke="${LINE}" stroke-width="1" />

  <!-- sample cards label -->
  <text x="76" y="370" font-family="${SANS}" font-size="15" fill="${INK_MUTE}" letter-spacing="1.4" font-weight="500">SAMPLE METROS · HIGHER = MORE SQUEEZED</text>

  <!-- four sample cards -->
  ${samples.map((r, i) => sampleCard(i, r)).join('')}

  <!-- footer brand -->
  <text x="76" y="600" font-family="${SANS}" font-size="18" fill="${INK_SOFT}">A Henry Finance research project · henryfinance.substack.com</text>
</svg>
`;

const svgPath = path.join(ASSETS, 'og.svg');
const pngPath = path.join(ASSETS, 'og.png');
fs.writeFileSync(svgPath, svg);

// Rasterize. ImageMagick handles SVG via librsvg/MSVG.
try {
  execFileSync('magick', [
    '-background', BG,
    '-density', '144',
    svgPath,
    '-resize', '1200x630',
    pngPath
  ], { stdio: 'inherit' });
  console.log('Wrote', pngPath);
} catch (e) {
  console.error('ImageMagick rasterize failed:', e.message);
  process.exit(1);
}
