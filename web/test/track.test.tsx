// @vitest-environment jsdom
// Sharing match history (site/TrackView): sign in through Steam, then the two steps and the code
// and token; Steam's refusal goes under the field it names; once on, a confirmation, the profile,
// and a way to stop. The bar shows who is signed in.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMe } from '../src/api/me';
import { siteAssets } from '../src/api/site-assets';
import SiteBar from '../src/site/SiteBar';
import TrackView from '../src/site/TrackView';

// A match share code (the server's sharecode tests use it too).
const CODE = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';
const ME = {
  steamid: '76561198000000001',
  name: 'skunk',
  avatar: null,
  tracking: 'off',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let routes: Record<string, (init?: RequestInit) => Response>;
let calls: { url: string; init?: RequestInit }[];

beforeEach(async () => {
  calls = [];
  routes = { 'GET /api/me': () => json(ME) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const route = routes[`${init?.method ?? 'GET'} ${url}`];
      return route ? route(init) : new Response('', { status: 404 });
    })
  );
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  history.replaceState(null, '', '/track');
  await getMe({ fresh: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fill = () => {
  fireEvent.change(screen.getByLabelText('Authentication code'), {
    target: { value: 'abcd-efghi-jklm' },
  });
  fireEvent.change(
    screen.getByLabelText('Most recently completed match token'),
    {
      target: { value: CODE },
    }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Start tracking' }));
};

describe('TrackView', () => {
  it('asks to sign in first', async () => {
    // Signed out is an answer (200), not an error: no console line on every page.
    routes['GET /api/me'] = () => json({ signedIn: false });
    await getMe({ fresh: true });
    render(<TrackView />);
    const signIn = await screen.findAllByRole('link', {
      name: 'Sign in through Steam',
    });
    expect(signIn.some((a) => a.getAttribute('href') === '/auth/steam')).toBe(
      true
    );
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
  });

  it("signs in through Steam with Steam's logo, as the bar does", async () => {
    const entry = (file: string) => ({
      file,
      sha256: 'cd'.repeat(32),
      bytes: 1,
    });
    routes['GET /api/me'] = () => json({ signedIn: false });
    routes['GET /site/manifest.json'] = () =>
      json({ ranks: {}, steamLogo: entry('steam-logo.svg'), home: null });
    await siteAssets({ fresh: true });
    await getMe({ fresh: true });
    render(<TrackView />);
    const main = await screen.findByRole('main');
    const button = await within(main).findByRole('link', {
      name: 'Sign in through Steam',
    });
    const logo = await waitFor(() => {
      const img = button.querySelector('img');
      expect(img).not.toBeNull();
      return img!;
    });
    expect(logo.getAttribute('src')).toBe('/site/steam-logo.svg?v=cdcdcdcd');
    expect(logo.getAttribute('alt')).toBe('');
    const bar = screen.getByRole('banner').querySelector('img')!;
    expect(bar.getAttribute('src')).toBe(logo.getAttribute('src'));
  });

  it('shows the two steps and both fields', async () => {
    render(<TrackView />);
    expect(
      await screen.findByRole('heading', { name: 'Track your matches' })
    ).toBeTruthy();
    const support = screen.getByRole('link', { name: /Steam Support/ });
    expect(support.getAttribute('href')).toBe(
      'https://help.steampowered.com/en/wizard/HelpWithGameIssue/?appid=730&issueid=128'
    );
    expect(support.getAttribute('target')).toBe('_blank');
    expect(
      (screen.getByLabelText('Authentication code') as HTMLInputElement)
        .placeholder
    ).toBe('ABCD-EFGHI-JKLM');
    expect(
      (
        screen.getByLabelText(
          'Most recently completed match token'
        ) as HTMLInputElement
      ).placeholder
    ).toBe('CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx');
    expect(
      screen.getByLabelText('An older match token (optional)')
    ).toBeTruthy();
  });

  it("puts Steam's 403 under the code field", async () => {
    const msg =
      'Steam rejected this code (403). Open the support page again, press Create Authentication Code and paste the new one.';
    routes['POST /api/me/tracking'] = () =>
      json({ field: 'authCode', error: msg }, 400);
    render(<TrackView />);
    await screen.findByLabelText('Authentication code');
    fill();
    expect(await screen.findByText(msg)).toBeTruthy();
    expect(
      screen.getByLabelText('Authentication code').getAttribute('aria-invalid')
    ).toBe('true');
    const body = JSON.parse(
      String(calls.find((c) => c.init?.method === 'POST')!.init!.body)
    );
    expect(body).toEqual({
      authCode: 'abcd-efghi-jklm',
      token: CODE,
    });
  });

  it("puts Steam's 412 under the token field", async () => {
    const msg =
      'Steam rejected this match token (412). Copy Your most recently completed match token from the same page again.';
    routes['POST /api/me/tracking'] = () =>
      json({ field: 'token', error: msg }, 400);
    render(<TrackView />);
    await screen.findByLabelText('Authentication code');
    fill();
    expect(await screen.findByText(msg)).toBeTruthy();
    expect(
      screen
        .getByLabelText('Most recently completed match token')
        .getAttribute('aria-invalid')
    ).toBe('true');
    expect(
      screen.getByLabelText('Authentication code').getAttribute('aria-invalid')
    ).toBe('false');
  });

  it('confirms tracking and offers the profile', async () => {
    routes['POST /api/me/tracking'] = () => json({ tracking: 'on' }, 202);
    render(<TrackView />);
    await screen.findByLabelText('Authentication code');
    fill();
    expect(
      await screen.findByRole('heading', { name: 'Tracking on' })
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Open my profile' }).getAttribute('href')
    ).toBe(`/profiles/${ME.steamid}`);
  });

  it('stop tracking asks the server and returns to the form', async () => {
    routes['GET /api/me'] = () => json({ ...ME, tracking: 'on' });
    routes['DELETE /api/me/tracking'] = () =>
      new Response(null, { status: 204 });
    await getMe({ fresh: true });
    render(<TrackView />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Stop tracking' })
    );
    expect(
      await screen.findByRole('heading', { name: 'Track your matches' })
    ).toBeTruthy();
    expect(
      calls.some(
        (c) => c.init?.method === 'DELETE' && c.url === '/api/me/tracking'
      )
    ).toBe(true);
  });

  it('says when tracking stopped and offers the form again', async () => {
    routes['GET /api/me'] = () => json({ ...ME, tracking: 'stopped' });
    await getMe({ fresh: true });
    render(<TrackView />);
    expect(
      await screen.findByRole('heading', { name: 'Tracking stopped' })
    ).toBeTruthy();
    expect(screen.getByLabelText('Authentication code')).toBeTruthy();
  });
});

describe('TrackView on a shared device', () => {
  for (const tracking of ['off', 'stopped'] as const) {
    it(`offers sign-out with tracking ${tracking}`, async () => {
      routes['GET /api/me'] = () => json({ ...ME, tracking });
      routes['POST /auth/signout'] = () => new Response(null, { status: 204 });
      await getMe({ fresh: true });
      render(<TrackView />);
      fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
      await waitFor(() =>
        expect(
          calls.some(
            (c) => c.init?.method === 'POST' && c.url === '/auth/signout'
          )
        ).toBe(true)
      );
      expect(
        (await screen.findAllByRole('link', { name: 'Sign in through Steam' }))
          .length
      ).toBeGreaterThan(0);
    });
  }

  it('keeps the code hidden until asked to show it', async () => {
    render(<TrackView />);
    const code = (await screen.findByLabelText(
      'Authentication code'
    )) as HTMLInputElement;
    expect(code.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show the code' }));
    expect(code.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide the code' }));
    expect(code.type).toBe('password');
  });

  it('forgets the code when the page is put away', async () => {
    render(<TrackView />);
    const code = (await screen.findByLabelText(
      'Authentication code'
    )) as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'abcd-efghi-jklm' } });
    expect(code.value).toBe('abcd-efghi-jklm');
    fireEvent(window, new Event('pagehide'));
    await waitFor(() => expect(code.value).toBe(''));
  });

  it('looks again at who is signed in when the tab comes back', async () => {
    // The page's own bar shows who is signed in too.
    render(<TrackView />);
    expect(
      await screen.findByRole('heading', { name: 'Track your matches' })
    ).toBeTruthy();
    // Meanwhile, in another tab: another player signed in, with tracking on.
    routes['GET /api/me'] = () =>
      json({
        ...ME,
        steamid: '76561198000000002',
        name: 'other',
        tracking: 'on',
      });
    fireEvent(window, new Event('focus'));
    expect(
      await screen.findByRole('heading', { name: 'Tracking on' })
    ).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'other' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'skunk' })).toBeNull();
  });
});

describe('SiteBar right after signing in', () => {
  afterEach(() => vi.useRealTimers());

  it('asks again while Steam fills in the player, and shows their name', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let asked = 0;
    routes['GET /api/me'] = () =>
      json(
        asked++ === 0
          ? { ...ME, name: null, steamPending: true }
          : { ...ME, steamPending: false }
      );
    await getMe({ fresh: true });
    render(<SiteBar />);
    expect(await screen.findByRole('link', { name: 'Signed in' })).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2600);
    expect(await screen.findByRole('link', { name: 'skunk' })).toBeTruthy();
  });
});

describe('SiteBar', () => {
  it('the bar shows the signed-in player', async () => {
    render(<SiteBar />);
    const me = await screen.findByRole('link', { name: 'skunk' });
    expect(me.getAttribute('href')).toBe('/track');
    expect(
      screen.queryByRole('link', { name: 'Sign in through Steam' })
    ).toBeNull();
  });
});
