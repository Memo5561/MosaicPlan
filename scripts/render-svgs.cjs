// Rendert die Test-/Beispielbilder (SVG → PNG) mit Chromium.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jobs = [
    ['scripts/svg/portrait.svg', 'public/samples/portrait.png'],
    ['scripts/svg/landscape.svg', 'public/samples/landscape.png'],
    ['scripts/svg/animal.svg', 'public/samples/animal.png'],
    ['scripts/svg/city.svg', 'public/samples/city.png'],
    ['public/icon.svg', 'public/icon-512.png', 512],
    ['public/icon.svg', 'public/icon-192.png', 192],
  ];
  for (const [src, dst, size] of jobs) {
    const svg = fs.readFileSync(src, 'utf8');
    const m = /width="(\d+)" height="(\d+)"/.exec(svg);
    const w = size || +m[1];
    const h = size || +m[2];
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<html><body style="margin:0"><img style="display:block;width:${w}px;height:${h}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`);
    await page.waitForTimeout(100);
    await page.screenshot({ path: dst, omitBackground: true });
    console.log('ok', dst);
  }
  await browser.close();
})();
