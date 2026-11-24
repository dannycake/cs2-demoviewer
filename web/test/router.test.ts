import { describe, expect, it } from 'vitest';
import { pageTitle, parseRoute, routeToPath, type Route } from '../src/router';

const at = (path: string) => parseRoute(new URL(path, 'http://x'));

describe('parseRoute', () => {
  it('reads / as the home view', () => {
    expect(parseRoute(new URL('http://x/'))).toEqual({ view: 'home' });
  });

  const vanity = { view: 'profile', ref: { kind: 'vanity', name: 'skunk' } };
  const steamid = {
    view: 'profile',
    ref: { kind: 'steamid', id: '76561198000000001' },
  };
  it.each([
    ['/', { view: 'home' }],
    ['/id/skunk', vanity],
    ['/id/skunk/', vanity],
    ['/id/skunk/games', vanity],
    ['/profiles/76561198000000001', steamid],
    ['/profiles/76561198000000001/games/?tab=all', steamid],
    ['/legal', { view: 'legal' }],
    ['/track', { view: 'track' }],
    ['/events', { view: 'events' }],
    ['/events/', { view: 'events' }],
    ['/events/iem_cologne-2026', { view: 'event', slug: 'iem_cologne-2026' }],
    [
      '/guides/watch-faceit-demos',
      { view: 'guide', slug: 'watch-faceit-demos' },
    ],
    ['/guides/Bad_Slug', { view: 'home' }],
    ['/guides', { view: 'guides' }],
    ['/guides/', { view: 'guides' }],
    ['/p/x', { view: 'home' }],
  ])('reads %s', (path, route) =>
    expect(parseRoute(new URL(path, 'https://skunk.club'))).toEqual(route)
  );

  it('reads a percent-escaped custom URL name', () => {
    expect(at('/id/a%2Eb')).toEqual({
      view: 'profile',
      ref: { kind: 'vanity', name: 'a.b' },
    });
  });

  it('reads /d/<id> with round and tick', () => {
    expect(at('/d/AkofogeJhPjXzm7asXSmgN?r=3&t=1234')).toEqual({
      view: 'demo',
      demoId: 'AkofogeJhPjXzm7asXSmgN',
      round: 3,
      tick: 1234,
    });
  });

  it('reads /d/<id> without a query', () => {
    expect(at('/d/abc')).toEqual({ view: 'demo', demoId: 'abc' });
  });

  it('drops a round or tick that is not a number', () => {
    const r = at('/d/abc?r=x');
    expect(r).toEqual({ view: 'demo', demoId: 'abc' });
    expect(r.view === 'demo' && r.round).toBeUndefined();
    expect(at('/d/abc?r=&t=')).toEqual({ view: 'demo', demoId: 'abc' });
    expect(at('/d/abc?r=-1&t=1e3')).toEqual({ view: 'demo', demoId: 'abc' });
    expect(at('/d/abc?r=2.5&t=10.5')).toEqual({
      view: 'demo',
      demoId: 'abc',
      tick: 10.5,
    });
  });

  it('treats any other path as the home view', () => {
    for (const p of [
      '/d',
      '/d/',
      '/d/abc/extra',
      '/x/abc',
      '/upload',
      '/d/a%2Fb',
      '/id/',
      '/profiles/',
      '/profiles/abc',
      '/legal/x',
      '/events/Upper',
      '/events/-a',
      '/events/a/b',
      `/events/${'a'.repeat(65)}`,
    ]) {
      expect(at(p), p).toEqual({ view: 'home' });
    }
  });
});

describe('routeToPath', () => {
  it('writes the demo path with round and tick', () => {
    expect(
      routeToPath({ view: 'demo', demoId: 'abc', round: 2, tick: 10 })
    ).toBe('/d/abc?r=2&t=10');
  });

  it('writes only the parts that are set', () => {
    expect(routeToPath({ view: 'home' })).toBe('/');
    expect(routeToPath({ view: 'legal' })).toBe('/legal');
    expect(routeToPath({ view: 'track' })).toBe('/track');
    expect(routeToPath({ view: 'events' })).toBe('/events');
    expect(routeToPath({ view: 'event', slug: 'iem_x' })).toBe('/events/iem_x');
    expect(routeToPath({ view: 'guide', slug: 'a-b' })).toBe('/guides/a-b');
    expect(routeToPath({ view: 'guides' })).toBe('/guides');
    expect(
      routeToPath({ view: 'profile', ref: { kind: 'vanity', name: 'a b' } })
    ).toBe('/id/a%20b');
    expect(
      routeToPath({
        view: 'profile',
        ref: { kind: 'steamid', id: '76561198000000001' },
      })
    ).toBe('/profiles/76561198000000001');
    expect(routeToPath({ view: 'demo', demoId: 'abc' })).toBe('/d/abc');
    expect(routeToPath({ view: 'demo', demoId: 'abc', tick: 0 })).toBe(
      '/d/abc?t=0'
    );
  });

  it('round-trips through parseRoute', () => {
    const routes: Route[] = [
      { view: 'home' },
      { view: 'legal' },
      { view: 'track' },
      { view: 'events' },
      { view: 'event', slug: 'iem_x' },
      { view: 'guide', slug: 'watch-faceit-demos' },
      { view: 'profile', ref: { kind: 'vanity', name: 'some_one' } },
      { view: 'profile', ref: { kind: 'steamid', id: '76561198000000001' } },
      { view: 'demo', demoId: 'AkofogeJhPjXzm7asXSmgN' },
      { view: 'demo', demoId: 'abc', round: 0, tick: 5 },
      { view: 'demo', demoId: 'abc', round: 23 },
    ];
    for (const r of routes) {
      expect(at(routeToPath(r))).toEqual(r);
    }
  });
});

describe('the moment in a link', () => {
  it('reads cam and p, and round-trips through routeToPath', () => {
    const r = at('/d/abc?r=3&t=12345&cam=pov&p=4');
    expect(r).toEqual({
      view: 'demo',
      demoId: 'abc',
      round: 3,
      tick: 12345,
      cam: 'pov',
      p: 4,
    });
    expect(routeToPath(r)).toBe('/d/abc?r=3&t=12345&cam=pov&p=4');
    expect(at(routeToPath(r))).toEqual(r);
  });

  it('reads each of the three cameras', () => {
    for (const cam of ['pov', 'free', 'auto'] as const)
      expect(at(`/d/abc?cam=${cam}`)).toEqual({
        view: 'demo',
        demoId: 'abc',
        cam,
      });
  });

  it('reads the old Follow camera as POV, so an old link opens in POV', () => {
    expect(at('/d/abc?r=2&t=520&cam=follow&p=3')).toEqual({
      view: 'demo',
      demoId: 'abc',
      round: 2,
      tick: 520,
      cam: 'pov',
      p: 3,
    });
  });

  it('drops an unknown cam', () => {
    expect(at('/d/abc?r=3&cam=orbit')).toEqual({
      view: 'demo',
      demoId: 'abc',
      round: 3,
    });
    expect(at('/d/abc?cam=')).toEqual({ view: 'demo', demoId: 'abc' });
    expect(at('/d/abc?cam=POV')).toEqual({ view: 'demo', demoId: 'abc' });
  });

  it('drops a p that is not an integer of 1 or more', () => {
    for (const p of ['0', 'x', '', '-1', '1.5', '1e1', '+2'])
      expect(at(`/d/abc?r=2&p=${p}`), p).toEqual({
        view: 'demo',
        demoId: 'abc',
        round: 2,
      });
  });

  it('drops an at that is not five finite numbers, keeping r and t', () => {
    for (const a of [
      '1,2,3',
      '1,2,3,4,5,60,7',
      '1,2,3,4,x',
      '1,,3,4,5',
      '1,2,3,4,',
      '1 2 3 4 5',
      'NaN,2,3,4,5',
      `1${'0'.repeat(400)},2,3,4,5`,
    ])
      expect(at(`/d/abc?r=3&t=12345&cam=free&at=${a}`), a).toEqual({
        view: 'demo',
        demoId: 'abc',
        round: 3,
        tick: 12345,
        cam: 'free',
      });
  });

  it('reads an at of five numbers as a pose', () => {
    expect(at('/d/abc?cam=free&at=1.5,2,-3,90,-10.5')).toEqual({
      view: 'demo',
      demoId: 'abc',
      cam: 'free',
      at: { x: 1.5, y: 2, z: -3, yaw: 90, pitch: -10.5 },
    });
    // An escaped comma reads the same.
    expect(at('/d/abc?at=1.5%2C2%2C-3%2C90%2C-10.5')).toEqual({
      view: 'demo',
      demoId: 'abc',
      at: { x: 1.5, y: 2, z: -3, yaw: 90, pitch: -10.5 },
    });
  });

  it('reads a sixth number as the field of view, in degrees', () => {
    expect(at('/d/abc?cam=free&at=1.5,2,-3,90,-10.5,73.7')).toEqual({
      view: 'demo',
      demoId: 'abc',
      cam: 'free',
      at: { x: 1.5, y: 2, z: -3, yaw: 90, pitch: -10.5, fov: 73.7 },
    });
    // Five numbers still read, with no field of view.
    const five = at('/d/abc?at=1,2,3,4,5');
    expect(five.view === 'demo' && five.at).toEqual({
      x: 1,
      y: 2,
      z: 3,
      yaw: 4,
      pitch: 5,
    });
    expect(five.view === 'demo' && five.at && 'fov' in five.at).toBe(false);
  });

  it('drops an at whose field of view is not a number from 1 to 179', () => {
    for (const fov of ['x', '', '0', '0.5', '179.5', '180', '-60', '1e2'])
      expect(at(`/d/abc?r=3&cam=free&at=1,2,3,4,5,${fov}`), fov).toEqual({
        view: 'demo',
        demoId: 'abc',
        round: 3,
        cam: 'free',
      });
    for (const fov of ['1', '179', '60'])
      expect(at(`/d/abc?at=1,2,3,4,5,${fov}`), fov).toMatchObject({
        at: { fov: Number(fov) },
      });
  });

  it('writes an at with metres to 2 decimals and degrees to 1, commas unescaped', () => {
    const path = routeToPath({
      view: 'demo',
      demoId: 'abc',
      round: 5,
      tick: 8000,
      cam: 'free',
      at: { x: 1.234, y: 4, z: -5.678, yaw: 90, pitch: -12.34 },
    });
    expect(path).toBe(
      '/d/abc?r=5&t=8000&cam=free&at=1.23,4.00,-5.68,90.0,-12.3'
    );
    expect(at(path)).toEqual({
      view: 'demo',
      demoId: 'abc',
      round: 5,
      tick: 8000,
      cam: 'free',
      at: { x: 1.23, y: 4, z: -5.68, yaw: 90, pitch: -12.3 },
    });
    // The field of view, when there is one, to 1 decimal.
    expect(
      routeToPath({
        view: 'demo',
        demoId: 'abc',
        cam: 'free',
        at: { x: 1, y: 2, z: 3, yaw: 4, pitch: 5, fov: 73.7397 },
      })
    ).toBe('/d/abc?cam=free&at=1.00,2.00,3.00,4.0,5.0,73.7');
    // No "-0.00": a value that rounds to zero is written as zero.
    expect(
      routeToPath({
        view: 'demo',
        demoId: 'abc',
        at: { x: -0.001, y: 0, z: 0, yaw: -0.04, pitch: 0 },
      })
    ).toBe('/d/abc?at=0.00,0.00,0.00,0.0,0.0');
  });

  it('drops each bad part on its own and keeps the rest', () => {
    expect(at('/d/abc?r=3&t=12345&cam=orbit&p=0&at=1,2,3&debug=1')).toEqual({
      view: 'demo',
      demoId: 'abc',
      round: 3,
      tick: 12345,
    });
    expect(at('/d/abc?r=x&t=12345&cam=pov&p=4')).toEqual({
      view: 'demo',
      demoId: 'abc',
      tick: 12345,
      cam: 'pov',
      p: 4,
    });
  });
});

describe('pageTitle', () => {
  it('names the page, then the date when known, then the site, as the server does', () => {
    expect(pageTitle('de_mirage', '2026-10-21')).toBe(
      'de_mirage · 2026-10-21 · skunk.club'
    );
    expect(pageTitle('Alpha1')).toBe('Alpha1 · skunk.club');
    expect(pageTitle(null, '2026-10-21')).toBe('skunk.club');
    expect(pageTitle()).toBe('skunk.club');
  });

  it('never writes an em dash', () => {
    expect(pageTitle('Mirage 13–9', '2026-10-21')).not.toContain('—');
  });
});
