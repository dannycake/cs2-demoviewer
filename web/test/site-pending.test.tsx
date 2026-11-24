// @vitest-environment jsdom
// While a site page's own chunk loads, the page is not blank: the site's bar, a loading bar and
// its foot show, then the page.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { dropPre, putPre } from './helpers/pre';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 }))
  );
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  history.replaceState(null, '', '/legal');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
  dropPre();
});

describe('a site page loading', () => {
  it('shows the bar, a loading bar and the foot, then the page', async () => {
    render(<App />);
    expect(screen.getByRole('progressbar', { name: 'Loading' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /skunk\.club/ })).toBeTruthy();
    expect(screen.getByRole('contentinfo')).toBeTruthy();
    expect(
      await screen.findByRole('heading', { name: 'Contact' })
    ).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it("over the server's body, shows the bar and a loading bar but no foot, which would sit between them", async () => {
    putPre();
    render(<App />);
    expect(screen.getByRole('progressbar', { name: 'Loading' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /skunk\.club/ })).toBeTruthy();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(
      await screen.findByRole('heading', { name: 'Contact' })
    ).toBeTruthy();
  });
});
