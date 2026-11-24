import { expect, test, type Page } from '@playwright/test';
import { trackErrors } from './errors';

// How a profile's figures sit, at a phone's, a tablet's and a desktop's width, on a made-up player's profile
// (this test's own, so it needs only the server on 8095 or DEMOVIEWER_E2E_URL): at one width every
// label sits one way, beside its figure or (the narrowest phones) under it, in the stat strip, the
// figures under it and the tables alike; the figures of a row stand on one line; a tournament's
// rows name it in words and show their whole day; "All 34 matches" keeps its spaces. A link that
// is a cell (a teammate, the foot's Contact, the bar's search icon) is the whole cell, a cell
// answers the pointer, and a crimson button's focus ring is white.
const ID = '76561198000000001';
const MAPS = ['de_inferno', 'de_anubis', 'de_mirage', 'de_dust2', 'de_nuke'];

const row = (i: number) => ({
  demoId: `Jnv7rxggBidutAQ2kv4D${String(i).padStart(2, '0')}`,
  map: MAPS[i % MAPS.length],
  mode: 'other',
  event: 'iem_cologne_major_2026',
  playedUnix: 1_792_000_000 - i * 86_400,
  result: i % 4 === 3 ? 'l' : 'w',
  score: [13, 8 + (i % 5)],
  kills: 20 + i,
  deaths: 12 + (i % 6),
  assists: 4,
  adr: 80 + i,
  hsPct: 40 + i,
  kastPct: 70 + i,
  rating: 1.1 + i / 50,
  rank: null,
});

const PROFILE = {
  steamid: ID,
  name: 'Alpha1',
  avatar: null,
  steam: {
    sinceYear: 2012,
    country: 'RU',
    cs2Hours: null,
    cs2RecentMinutes: null,
    level: 111,
    vacBans: 0,
    gameBans: 0,
    communityBanned: false,
    tradeBan: null,
    daysSinceLastBan: null,
  },
  tracking: 'off',
  premier: null,
  competitive: null,
  totals: {
    rating: 1.17,
    openingWon: 95,
    openingLost: 51,
    kd: 1.34,
    adr: 79,
    hsPct: 36,
    matches: 34,
    kills: 589,
    deaths: 441,
    assists: 123,
    rounds: 745,
    kastPct: 77,
    survivalPct: 41,
    multiKills: [112, 30, 7, 0],
    wins: 23,
    losses: 11,
    ties: 0,
    seconds: 100_800,
  },
  replay: {
    matches: 34,
    kills: 589,
    weapons: [
      { weapon: 'awp', kills: 303 },
      { weapon: 'ak47', kills: 105 },
      { weapon: 'm4a1_silencer', kills: 60 },
      { weapon: 'fiveseven', kills: 12 },
      { weapon: 'inferno', kills: 3 },
    ],
    clutches: [10, 6, 3, 1, 0],
    clutchesWon: [6, 2, 1, 0, 0],
    tradeKills: 31,
    tradedDeaths: 24,
    flashAssists: 12,
    enemiesFlashed: 140,
    blindPerRound: 0.84,
    utilityAdr: 7.6,
    plants: 17,
    defuses: 1,
    t: { rounds: 372, kills: 290, deaths: 220, kd: 1.32, adr: 77 },
    ct: { rounds: 373, kills: 299, deaths: 221, kd: 1.35, adr: 81 },
    wallbangs: 9,
    throughSmoke: 4,
    noScopes: 2,
    blindKills: 1,
  },
  maps: MAPS.map((map, i) => ({
    map,
    matches: 8 - i,
    winPct: 60 + i,
    rating: 1.2 + i / 20,
    rank: null,
  })),
  mates: [
    { steamid: '76561198000000002', name: 'Bravo', matches: 34, wins: 23 },
    { steamid: '76561198000000003', name: 'charlie2', matches: 34, wins: 23 },
    {
      steamid: '76561198000000004',
      name: 'Noob Deltaechoes',
      matches: 123,
      wins: 100,
    },
  ],
  matches: Array.from({ length: 34 }, (_, i) => row(i)),
  matchCount: 34,
};

const SIZES = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1200, height: 900 },
];

/** Each band of the layout: a phone (labels under, beside), a tablet, a narrow desktop, the
 * desktop whose tables run on from the figures, and the widest rows. */
const BANDS = [320, 390, 480, 600, 700, 768, 900, 1000, 1100, 1200, 1600].map(
  (width) => ({ width, height: 900 })
);

async function open(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.goto(`/profiles/${ID}`);
  await expect(page.getByTestId('stat-strip')).toContainText('1.17');
  await page.evaluate(() => document.fonts.ready);
}

test.beforeEach(async ({ page }) => {
  const up = await page.request.get('/').catch(() => null);
  test.skip(!up?.ok(), 'the server is not running');
  await page.route(new RegExp(`/api/players/${ID}$`), (r) =>
    r.fulfill({ json: PROFILE })
  );
});

test('each weapon keeps its whole name and its silhouette beside it, on a phone too', async ({
  page,
}) => {
  for (const size of SIZES) {
    await open(page, size);
    const rows = await page.getByTestId('weapons').evaluate((block) =>
      [...block.querySelectorAll<HTMLElement>('[data-weapon]')].map((row) => {
        const name = row.querySelector<HTMLElement>('[data-name]')!;
        const icon = row.querySelector<HTMLElement>('[data-icon]');
        const n = name.getBoundingClientRect();
        const i = icon?.getBoundingClientRect();
        return {
          name: name.textContent,
          cut: name.scrollWidth > name.clientWidth + 1,
          // Beside it: the silhouette's middle within the name's line.
          beside:
            !i ||
            Math.abs(i.top + i.height / 2 - (n.top + n.height / 2)) <
              n.height / 2,
        };
      })
    );
    expect(rows.length, `${size.width}px`).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.cut, `${size.width}px: ${r.name} cut`).toBe(false);
      expect(r.beside, `${size.width}px: ${r.name}'s silhouette`).toBe(true);
    }
  }
});

test('the Premier box and the Competitive rank are one size', async ({
  page,
}) => {
  for (const size of SIZES) {
    await open(page, size);
    const boxes = await page.getByTestId('ranks').evaluate((ranks) =>
      [...ranks.children].map((rank) => {
        const r = rank.firstElementChild!.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      })
    );
    expect(boxes[0], `${size.width}px`).toEqual(boxes[1]);
  }
});

test('at one width every label sits one way, and a row’s figures stand on one line', async ({
  page,
}) => {
  const errors = trackErrors(page);
  for (const size of SIZES) {
    await open(page, size);
    const seen = await page.evaluate(() => {
      const cells = [
        ...document.querySelectorAll<HTMLElement>(
          [
            '[data-testid="stat-strip"] > *',
            '[data-testid="stat-grid"] > *',
            '[data-cell]',
            // A map's figures: not its name, its rank or its toggle.
            '[data-map] > :not(:first-child):not(:nth-last-child(-n + 2))',
            '[data-mate] > :not(:first-child)',
            '[data-weapon] > :not(:first-child)',
            '[data-testid="sides"] > * > :not(:first-child)',
          ].join(', ')
        ),
      ];
      const ways = new Map<string, string[]>();
      for (const c of cells) {
        const n = c.querySelector('.n')!;
        const label =
          c.querySelector('[data-label]') ??
          c.querySelector(':scope > span:not(.n)')!;
        const a = n.getBoundingClientRect();
        const b = label.getBoundingClientRect();
        const way = b.top >= a.bottom - 4 ? 'under' : 'beside';
        ways.set(way, [...(ways.get(way) ?? []), c.textContent!]);
      }
      // A figure's baseline: the foot of an empty inline box after its text.
      const baselines = (id: string) => {
        const rows = new Map<number, number[]>();
        for (const c of document.querySelectorAll<HTMLElement>(
          `[data-testid="${id}"] > *`
        )) {
          const n = c.querySelector('.n')!;
          const mark = document.createElement('span');
          mark.style.cssText = 'display:inline-block;width:0;height:0';
          n.appendChild(mark);
          const top = Math.round(c.getBoundingClientRect().top);
          rows.set(top, [
            ...(rows.get(top) ?? []),
            Math.round(mark.getBoundingClientRect().bottom),
          ]);
          mark.remove();
        }
        return [...rows.values()].filter((ys) => new Set(ys).size > 1);
      };
      return {
        ways: Object.fromEntries(ways),
        uneven: [...baselines('stat-strip'), ...baselines('stat-grid')],
      };
    });
    const at = `${size.width}px`;
    const want = size.width <= 380 ? 'under' : 'beside';
    expect(
      Object.keys(seen.ways),
      `${at}: ${JSON.stringify(seen.ways)}`
    ).toEqual([want]);
    expect(seen.uneven, at).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test('a tournament’s rows name it in words and show their whole day; "All 34 matches" keeps its spaces', async ({
  page,
}) => {
  const errors = trackErrors(page);
  for (const size of SIZES) {
    await open(page, size);
    const rows = page.getByTestId('match-rows');
    await expect(rows.locator('[data-mode]').first()).toHaveText(
      'IEM Cologne Major 2026,'
    );
    const cut = await rows.evaluate((r) =>
      [...r.querySelectorAll<HTMLElement>('[data-day]')]
        .filter((d) => {
          const box = d.getBoundingClientRect();
          const cell = d
            .closest('small')!
            .parentElement!.getBoundingClientRect();
          return d.scrollWidth > d.clientWidth || box.right > cell.right + 0.5;
        })
        .map((d) => d.textContent)
    );
    expect(cut, `${size.width}px`).toEqual([]);
    await expect(
      page.getByRole('button', { name: 'All 34 matches' })
    ).toHaveJSProperty('innerText', 'All 34 matches');
  }
  expect(errors).toEqual([]);
});

test('a link that is a cell is the whole cell', async ({ page }) => {
  const errors = trackErrors(page);
  for (const size of SIZES) {
    await open(page, size);
    const links = [
      page.getByRole('link', { name: 'Bravo' }),
      page.getByRole('contentinfo').getByRole('link', { name: 'Contact' }),
    ];
    if (size.width <= 800)
      links.push(
        page.getByRole('banner').getByRole('link', { name: 'Search' })
      );
    for (const link of links) {
      const [own, cell] = await link.evaluate((a) => {
        const box = (e: Element) => {
          const r = e.getBoundingClientRect();
          return [r.left, r.top, r.right, r.bottom].map(Math.round);
        };
        return [box(a), box(a.parentElement!)];
      });
      expect(own, `${size.width}px: ${await link.textContent()}`).toEqual(cell);
    }
  }
  expect(errors).toEqual([]);
});

test('a cell answers the pointer, and a crimson button rings white', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await open(page, SIZES[3]);
  const background = (l: ReturnType<Page['locator']>) =>
    l.evaluate((e) => getComputedStyle(e).backgroundColor);
  const tab = page.getByRole('tab', { name: 'Premier' });
  const idle = await background(tab);
  await tab.hover();
  await expect.poll(() => background(tab)).not.toBe(idle);
  const replay = page.getByRole('link', { name: /^Replay/ }).first();
  const red = await background(replay);
  await replay.hover();
  await expect.poll(() => background(replay)).not.toBe(red);
  await replay.focus();
  expect(
    await replay.evaluate((e) => [
      e.matches(':focus-visible'),
      getComputedStyle(e).outlineColor,
    ])
  ).toEqual([true, 'rgb(255, 255, 255)']);
  expect(errors).toEqual([]);
});

test('the column has one text edge and closed lines; the tables’ lines run on from the figures’', async ({
  page,
}) => {
  const errors = trackErrors(page);
  for (const size of BANDS) {
    await open(page, size);
    const seen = await page.evaluate(() => {
      const stack = document.querySelector<HTMLElement>('[aria-busy]')!;
      const edge = stack.getBoundingClientRect().left;
      // Where a cell's first text starts, from the column's edge.
      const textLeft = (el: Element) => {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let t = walk.nextNode();
        while (t && !t.textContent!.trim()) t = walk.nextNode();
        const r = document.createRange();
        r.selectNodeContents(t!);
        return Math.round(r.getBoundingClientRect().left - edge);
      };
      const firsts = [
        ...document.querySelectorAll('h2'),
        ...[
          ...document.querySelectorAll(
            '[data-testid="stat-strip"], [data-testid="stat-grid"], [data-cell]'
          ),
        ]
          .filter(
            (c) =>
              c.matches('[data-cell]:first-child') || !c.matches('[data-cell]')
          )
          .map((c) => (c.matches('[data-cell]') ? c : c.firstElementChild!)),
        ...[
          ...document.querySelectorAll(
            '[data-map], [data-mate], [data-weapon], [data-side]'
          ),
        ].map((r) => r.firstElementChild!),
      ];
      const edges = new Map<number, string[]>();
      for (const f of firsts) {
        // The second of a pair (the trades beside the bomb) starts in the middle.
        if (f.getBoundingClientRect().left > edge + 2) continue;
        const x = textLeft(f);
        edges.set(x, [...(edges.get(x) ?? []), f.textContent!.slice(0, 12)]);
      }
      // The figures' lines (four a row) and the map table's.
      const lefts = (row: Element) =>
        [...row.children].map((c) =>
          Math.round(c.getBoundingClientRect().left)
        );
      const grid = document.querySelector('[data-testid="stat-grid"]')!;
      const perRow =
        getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      return {
        edges: Object.fromEntries(edges),
        bottom: getComputedStyle(stack).borderBottomWidth,
        figs: lefts(grid).slice(0, perRow),
        map: lefts(document.querySelector('[data-map]')!),
      };
    });
    const at = `${size.width}px`;
    expect(
      Object.keys(seen.edges),
      `${at}: ${JSON.stringify(seen.edges)}`
    ).toHaveLength(1);
    expect(seen.bottom, at).toBe('1px');
    if (size.width > 960)
      expect(seen.map.slice(0, 4), at).toEqual(seen.figs.slice(0, 4));
  }
  expect(errors).toEqual([]);
});

test('every figure and label stands whole in its cell, clear of its edge; a phone’s name column is the widest', async ({
  page,
}) => {
  const errors = trackErrors(page);
  for (const size of BANDS) {
    await open(page, size);
    const seen = await page.evaluate(() => {
      const cells = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-match] > *, [data-map] > *, [data-mate] > *, [data-weapon] > *, [data-side] > *'
        ),
      ].filter((c) => c.querySelector('.n'));
      const out: string[] = [];
      for (const c of cells) {
        const cell = c.getBoundingClientRect();
        if (cell.width === 0) continue;
        for (const part of c.children) {
          const r = part.getBoundingClientRect();
          if (r.right > cell.right - 8 || r.left < cell.left)
            out.push(`${c.textContent} (${Math.round(cell.right - r.right)})`);
        }
      }
      const widths = [...document.querySelectorAll('[data-mate]')].map((r) =>
        [...r.children].map((c) => c.getBoundingClientRect().width)
      );
      return { out, widths };
    });
    const at = `${size.width}px`;
    expect(seen.out, at).toEqual([]);
    if (size.width <= 560)
      for (const w of seen.widths)
        expect(w[0], `${at}: ${w}`).toBeGreaterThanOrEqual(
          Math.max(...w.slice(1))
        );
  }
  expect(errors).toEqual([]);
});

test('match rows have hairlines between their cells', async ({ page }) => {
  await open(page, SIZES[3]);
  const [row, cell] = await page
    .locator('[data-match]')
    .first()
    .evaluate((r) => [
      getComputedStyle(r).backgroundColor,
      getComputedStyle(r.children[1]).backgroundColor,
    ]);
  expect(row).toBe('rgb(38, 38, 38)');
  expect(cell).toBe('rgb(0, 0, 0)');
});

test('a long name keeps its letters on the narrowest phone, and "Asking Steam…" is set upright', async ({
  page,
}) => {
  await page.route(new RegExp(`/api/players/${ID}$`), (r) =>
    r.fulfill({
      json: { ...PROFILE, name: 'F00L1SH_N1NJ4', steamPending: true },
    })
  );
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/profiles/${ID}`);
  const name = page.getByRole('heading', { name: 'F00L1SH_N1NJ4' });
  await expect(name).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await name.evaluate((h) => h.scrollWidth <= h.clientWidth)).toBe(true);
  const asking = page.getByText('Asking Steam…');
  await expect(asking).toBeVisible();
  expect(await asking.evaluate((e) => getComputedStyle(e).fontStyle)).toBe(
    'normal'
  );
});

test('the player’s Steam profile is linked, and FACEIT’s with its mark, level and Elo and its win rate and match count beside it when they have one, whole on a phone and a desktop, without a sideways scroll', async ({
  page,
}) => {
  const errors = trackErrors(page);
  // Without a FACEIT account, the Steam link alone.
  await open(page, { width: 390, height: 844 });
  const who = page.getByTestId('who');
  await expect(who.getByRole('link', { name: 'Steam profile' })).toBeVisible();
  await expect(who.getByRole('link')).toHaveCount(1);
  await page.route(new RegExp(`/api/players/${ID}$`), (r) =>
    r.fulfill({
      json: {
        ...PROFILE,
        faceit: {
          nickname: 'Alpha1',
          level: 10,
          elo: 3609,
          playerId: 'a1b2c3d4-0000-4000-8000-000000000001',
          winsPct: 61,
          matches: 1204,
        },
      },
    })
  );
  for (const size of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    const at = `${size.width}px`;
    await open(page, size);
    const steam = who.getByRole('link', { name: 'Steam profile' });
    const faceit = who.getByRole('link', { name: /^FACEIT/ });
    await expect(steam).toHaveAttribute(
      'href',
      `https://steamcommunity.com/profiles/${ID}`
    );
    await expect(faceit).toHaveAttribute(
      'href',
      'https://www.faceit.com/en/players/Alpha1'
    );
    for (const link of [steam, faceit]) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    await expect(faceit).toHaveText('FACEIT · Level 10 · 3,609 Elo');
    await expect(who.locator('[data-faceit-stats]')).toHaveText(
      '61% wins · 1,204 matches'
    );
    // FACEIT's mark is loaded, 16 px.
    const mark = faceit.locator('img');
    await expect(mark).toHaveAttribute('src', '/faceit.svg');
    const drawn = await mark.evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const box = img.getBoundingClientRect();
      return {
        size: [box.width, box.height],
        loaded: img.naturalWidth > 0,
      };
    });
    expect(drawn, at).toEqual({ size: [16, 16], loaded: true });
    const seen = await page.evaluate(() => {
      const block = document.querySelector('[data-testid="who"]')!;
      const box = block.getBoundingClientRect();
      const facts = [
        ...block.querySelector('[data-link]')!.parentElement!.children,
      ] as HTMLElement[];
      const name = block.querySelector('h1')!;
      return {
        sideways: document.documentElement.scrollWidth - window.innerWidth,
        // Every cell of the row, the links' too, on one line of its 36 px, whole, in the block.
        cells: facts
          .filter((c) => c.textContent)
          .filter(
            (c) =>
              c.getBoundingClientRect().height !== 36 ||
              c.scrollWidth > c.clientWidth ||
              c.getBoundingClientRect().right > box.right + 0.5
          )
          .map((c) => c.textContent),
        nameLines: (() => {
          const r = document.createRange();
          r.selectNodeContents(name);
          return r.getClientRects().length;
        })(),
      };
    });
    expect(seen.sideways, at).toBeLessThanOrEqual(0);
    expect(seen.cells, at).toEqual([]);
    expect(seen.nameLines, at).toBe(1);
  }
  expect(errors).toEqual([]);
});

/** The map cells: the table's, then the match rows'. */
const MAP_CELLS =
  '[data-testid="map-table"] [data-map] > :first-child, [data-match] > :nth-child(2)';

test('a map’s strip lies behind its name, which keeps 4.5:1 over it, and is gone to black at the cell’s edge; without strips the rows are plain', async ({
  page,
}) => {
  const site = await page.request.get('/site/manifest.json');
  const manifest = site.ok() ? await site.json() : null;
  test.skip(
    !manifest?.maps || !Object.keys(manifest.maps).length,
    'the server has no map strips (tools/build-site.mjs)'
  );
  const errors = trackErrors(page);
  const fetched = new Map<string, { type: string; bytes: number }>();
  page.on('response', async (r) => {
    if (r.url().includes('/site/maps/'))
      fetched.set(new URL(r.url()).pathname + new URL(r.url()).search, {
        type: r.headers()['content-type'],
        bytes: (await r.body()).length,
      });
  });
  for (const size of SIZES) {
    await open(page, size);
    await page.waitForLoadState('networkidle');
    const at = `${size.width}px`;
    const cells = page.locator(MAP_CELLS);
    const seen = await cells.evaluateAll((els) =>
      els.map((c) => ({
        name: c.firstChild!.textContent,
        image: getComputedStyle(c).backgroundImage,
        dim: getComputedStyle(c.querySelector('small') ?? c).color,
      }))
    );
    expect(seen, at).toHaveLength(MAPS.length + 10);
    const maps = [...MAPS, ...PROFILE.matches.slice(0, 10).map((m) => m.map)];
    seen.forEach((c, i) => {
      const strip = manifest.maps[maps[i]];
      if (!strip) expect(c.image, `${at} ${c.name}`).toBe('none');
      else
        expect(c.image, `${at} ${c.name}`).toContain(
          `/site/${strip.file}?v=${strip.sha256.slice(0, 8)}`
        );
    });
    // The picture alone: the words hidden, each cell's brightest pixel and its last two columns'.
    const hide = await page.addStyleTag({
      content: `${MAP_CELLS}, ${MAP_CELLS.split(', ')
        .map((s) => `${s} *`)
        .join(', ')} { color: transparent !important; }`,
    });
    for (let i = 0; i < seen.length; i++) {
      // A pixel inside the cell's box all round (in the page's coordinates, as a full page's
      // shot takes them), clear of the hairlines about it.
      const box = await cells.nth(i).evaluate((c) => {
        const r = c.getBoundingClientRect();
        return {
          x: r.x + scrollX,
          y: r.y + scrollY,
          width: r.width,
          height: r.height,
        };
      });
      const x = Math.ceil(box.x) + 1;
      const y = Math.ceil(box.y) + 1;
      const shot = await page.screenshot({
        fullPage: true,
        clip: {
          x,
          y,
          width: Math.floor(box.x + box.width) - 1 - x,
          height: Math.floor(box.y + box.height) - 1 - y,
        },
      });
      const { max, edge } = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
        const lin = (v: number) =>
          (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        let max = 0;
        let edge = 0;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
            const l =
              0.2126 * lin(data[p]) +
              0.7152 * lin(data[p + 1]) +
              0.0722 * lin(data[p + 2]);
            max = Math.max(max, l);
            if (x >= width - 2) edge = Math.max(edge, l);
          }
        return { max, edge };
      }, shot.toString('base64'));
      const [r, g, b] = seen[i].dim.match(/\d+/g)!.map(Number);
      const lin = (v: number) =>
        (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      const dim = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const ratio = (dim + 0.05) / (max + 0.05);
      expect(ratio, `${at} ${seen[i].name}`).toBeGreaterThanOrEqual(4.5);
      expect(edge, `${at} ${seen[i].name}: its right edge`).toBeLessThan(0.002);
    }
    await hide.evaluate((s) => (s as HTMLElement).remove());
  }
  // Small and versioned: a phone never fetches a map's megabyte screenshot.
  expect(fetched.size).toBeGreaterThan(0);
  for (const [url, r] of fetched) {
    expect(url).toMatch(/^\/site\/maps\/[a-z0-9_]+\.webp\?v=[0-9a-f]{8}$/);
    expect(r.type, url).toBe('image/webp');
    expect(r.bytes, url).toBeLessThanOrEqual(32_000);
  }
  // A manifest from before the strips: every row as it was, plain black, nothing asked for.
  fetched.clear();
  const old = { ...manifest, maps: undefined };
  await page.route('**/site/manifest.json', (r) => r.fulfill({ json: old }));
  await open(page, SIZES[0]);
  await page.waitForLoadState('networkidle');
  const plain = await page
    .locator(MAP_CELLS)
    .evaluateAll((els) =>
      els.map((c) => [
        getComputedStyle(c).backgroundImage,
        getComputedStyle(c).backgroundColor,
      ])
    );
  expect(new Set(plain.map(String))).toEqual(new Set(['none,rgb(0, 0, 0)']));
  expect(fetched.size).toBe(0);
  expect(errors).toEqual([]);
});
