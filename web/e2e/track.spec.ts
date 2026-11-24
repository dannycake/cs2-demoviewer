import { expect, test, type Page } from '@playwright/test';

// /track on a phone, signed in (the session answered by a stub of /api/me): every field is at
// least 16 px, as iOS Safari zooms the whole page into a smaller one on focus, a whole match
// token fits a 390 px phone, and nothing scrolls sideways. Needs the server on 8095 (or
// DEMOVIEWER_E2E_URL) serving the built web app.
const CODE = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';

async function serverUp(page: Page): Promise<boolean> {
  const up = await page.request.get('/').catch(() => null);
  return !!up?.ok();
}

for (const size of [
  { width: 375, height: 667 },
  { width: 390, height: 664 },
] as const) {
  test(`the tracking form on a ${size.width} px phone: no zoom on focus, no sideways scroll`, async ({
    page,
  }) => {
    test.skip(!(await serverUp(page)), 'the server is not running');
    await page.setViewportSize(size);
    await page.route('**/api/me', (r) =>
      r.fulfill({
        json: {
          steamid: '76561198000000001',
          name: 'skunk',
          avatar: null,
          tracking: 'off',
        },
      })
    );
    await page.goto('/track');
    const token = page.getByLabel('Most recently completed match token');
    await expect(token).toBeVisible();
    const sizes = await page
      .locator('main input')
      .evaluateAll((els) =>
        els.map((e) => parseFloat(getComputedStyle(e).fontSize))
      );
    expect(sizes.length).toBe(3);
    for (const px of sizes) expect(px).toBeGreaterThanOrEqual(16);
    await token.fill(CODE);
    if (size.width >= 390)
      expect(await token.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
        true
      );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });
}
