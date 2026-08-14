// Automated confirmation for the anti-meridian picking repro. Hovers + clicks every
// point in every wiring mode and reports which produce picks.
//
// Usage: start `yarn dev`, then run with playwright resolvable, e.g.:
//   NODE_PATH=<somewhere-with-playwright>/node_modules node src/examples/antimeridian-picking/repro.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.REPRO_URL || 'http://localhost:5173';
const MODES = ['overlay-interleaved', 'overlay-overlaid', 'deckgl-default', 'deckgl-repeat'];
const POINT_IDS = [1, 2, 3, 4, 5, 6];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const results = {};
for (const mode of MODES) {
  await page.goto(`${BASE}/?example=antimeridian-picking&mode=${mode}`);
  await page.waitForFunction(() => window.__ready);
  // Let the basemap style + first deck frame settle.
  await page.waitForTimeout(3000);

  await page.evaluate(() => (window.__pickLog = []));
  for (const id of POINT_IDS) {
    const pos = await page.evaluate((pointId) => window.__screenPos(pointId), id);
    if (!pos) throw new Error(`no screen pos for point ${id}`);
    await page.mouse.move(pos.x, pos.y);
    await page.waitForTimeout(200);
    await page.mouse.click(pos.x, pos.y);
    await page.waitForTimeout(200);
  }

  const log = await page.evaluate(() => window.__pickLog);
  results[mode] = POINT_IDS.map((id) => ({
    id,
    hover: log.some((e) => e.event === 'hover' && e.pointId === id),
    click: log.some((e) => e.event === 'click' && e.pointId === id)
  }));
}

await browser.close();

for (const [mode, points] of Object.entries(results)) {
  const fmt = (p) => `#${p.id}:${p.hover ? 'H' : '-'}${p.click ? 'C' : '-'}`;
  console.log(mode.padEnd(20), points.map(fmt).join(' '));
}
