import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { trackErrors } from './errors';
import { trackLoads } from './wait';

// The replay viewer in the skunk.club look, as a browser draws it: the play button crimson, the
// active camera tab filled white, words in Archivo and the clock and health in JetBrains Mono,
// labels in sentence case, panels square. Shots of a desktop and a phone go to e2e/out to look at.
// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) and DEMOVIEWER_E2E_DEMO (the Mirage pack).
const demoId = process.env.DEMOVIEWER_E2E_DEMO;
const out = (name: string) =>
  fileURLToPath(new URL(`./out/${name}`, import.meta.url));

test.skip(
  !demoId,
  'set DEMOVIEWER_E2E_DEMO=<demo id of the Mirage pack> with the server running'
);

async function open(page: Page): Promise<string[]> {
  const errors = trackErrors(page);
  await trackLoads(page);
  await page.goto(`/d/${demoId}?r=1&t=40&cam=pov&p=1`);
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
  return errors;
}

const style = (page: Page, selector: string, prop: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

for (const [name, size] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`the viewer wears the skunk.club look on a ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const errors = await open(page);
    const play = page.getByRole('button', { name: /^(Play|Pause) \(Space\)$/ });
    expect(
      await play.evaluate((el) => getComputedStyle(el).backgroundColor)
    ).toBe('rgb(228, 22, 58)');
    const pov = page.getByRole('button', { name: /^POV/ });
    await expect(pov).toHaveAttribute('aria-pressed', 'true');
    expect(
      await pov.evaluate((el) => [
        getComputedStyle(el).backgroundColor,
        getComputedStyle(el).textTransform,
      ])
    ).toEqual(['rgb(246, 246, 246)', 'none']);
    expect(
      await page.evaluate(() => getComputedStyle(document.body).fontFamily)
    ).toMatch(/^"?Archivo/);
    for (const selector of [
      '[class*="_time_"]',
      '[class*="_hpNum_"]',
      '[class*="_cash_"]',
      '[data-testid="clock"]',
    ]) {
      if (await page.locator(selector).count())
        expect(await style(page, selector, 'font-family'), selector).toMatch(
          /JetBrains Mono/
        );
    }
    for (const selector of ['[class*="_clock_"]', '[class*="_card_"]']) {
      if (await page.locator(selector).count())
        expect(
          await style(page, selector, 'border-top-left-radius'),
          selector
        ).toBe('0px');
    }
    await page.screenshot({
      path: out(`viewer-look-${name}.jpg`),
      quality: 80,
    });
    expect(errors).toEqual([]);
  });
}
