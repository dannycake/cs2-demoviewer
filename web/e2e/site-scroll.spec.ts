import { expect, test, type Page } from '@playwright/test';

// The site's pages scroll like pages on a phone: a page taller than the screen moves under a
// finger (here, the wheel), so its last buttons can be reached; and there is room under them.
// The 3D viewer is full-screen and does not scroll. Needs the server on 8095 (or
// DEMOVIEWER_E2E_URL) serving the built web app.
async function serverUp(page: Page): Promise<boolean> {
  const up = await page.request.get('/').catch(() => null);
  return !!up?.ok();
}

for (const path of ['/legal', '/']) {
  test(`${path} scrolls on a short phone screen, its foot reachable`, async ({
    page,
  }) => {
    test.skip(!(await serverUp(page)), 'the server is not running');
    await page.setViewportSize({ width: 390, height: 420 });
    await page.goto(path);
    await expect(page.locator('footer')).toBeAttached();
    await page.mouse.move(195, 210);
    await page.mouse.wheel(0, 3000);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
    const foot = await page.locator('footer').boundingBox();
    // Within a pixel: layout rounds to fractions of one.
    expect(foot!.y + foot!.height).toBeLessThanOrEqual(421);
  });
}
