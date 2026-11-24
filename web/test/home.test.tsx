// @vitest-environment jsdom
// The skunk.club homepage (site/HomeView): the hero loop, the headline, the one input, and one
// demo per upload (picked, or dropped anywhere on the page), which opens its replay once up.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { siteAssets } from '../src/api/site-assets';
import HomeView from '../src/site/HomeView';
import { pickOneDemo } from '../src/site/pick-one-demo';

const upload = vi.hoisted(() => ({
  demoId: 'Jnv7rxggBidutAQ2kv4DRv',
  calls: 0,
}));
vi.mock('../src/api/upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/upload')>()),
  uploadDemo: vi.fn(async () => {
    upload.calls++;
    return { demoId: upload.demoId, cached: false };
  }),
}));

const f = (name: string) => new File(['x'], name);
const entry = (file: string) => ({ file, sha256: 'ab'.repeat(32), bytes: 1 });
const manifest = {
  ranks: { none: entry('ranks/skillgroup_none.webp') },
  steamLogo: entry('steam-logo.svg'),
  home: {
    mp4: entry('home/hero.mp4'),
    webm: entry('home/hero.webm'),
    poster: entry('home/poster.jpg'),
  },
};

function reducedMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: on && q.includes('prefers-reduced-motion'),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(async () => {
  history.replaceState(null, '', '/');
  upload.calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(manifest)))
  );
  await siteAssets({ fresh: true });
  reducedMotion(false);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pickOneDemo', () => {
  it('accepts exactly one demo', () => {
    expect(pickOneDemo([f('a.dem')])).toEqual({ file: expect.anything() });
    expect(pickOneDemo([f('a.dem.bz2')])).toEqual({ file: expect.anything() });
    expect(pickOneDemo([f('a.dem'), f('b.dem')])).toEqual({
      error: 'One demo at a time.',
    });
    expect('error' in pickOneDemo([f('a.dem.info')])).toBe(true);
    expect(pickOneDemo([])).toEqual({
      error: "That isn't a demo: choose a .dem, .dem.bz2 or .dem.gz file.",
    });
    // A folder drops as one entry named as the folder: not a demo.
    expect('error' in pickOneDemo([f('my demos')])).toBe(true);
  });
});

describe('HomeView', () => {
  it('shows the headline alone', () => {
    render(<HomeView />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Watch CS2 demos in 3D, right in your browser.'
    );
    expect(
      screen.getByText("Uploaded matches appear on their players' profiles.")
    ).toBeTruthy();
  });

  it('says what the site does and links every guide, for visitors and search engines alike', () => {
    render(<HomeView />);
    const about = screen.getByTestId('about');
    for (const words of ['share code', 'FACEIT', '.dem', 'ADR']) {
      expect(about.textContent).toContain(words);
    }
    expect(
      within(about)
        .getByRole('link', { name: 'How to watch a CS2 demo in your browser' })
        .getAttribute('href')
    ).toBe('/guides/watch-cs2-demos-in-your-browser');
  });

  it('says a FACEIT demo attaches to its match on the profile when sent from one, and only then', () => {
    const note =
      "Upload your FACEIT demo (download it from the match room) and it will attach to the match on the player's profile";
    render(<HomeView />);
    expect(screen.queryByText(note)).toBeNull();
    cleanup();
    history.replaceState(null, '', '/?hint=faceit');
    render(<HomeView />);
    expect(screen.getByText(note)).toBeTruthy();
    cleanup();
    history.replaceState(null, '', '/?hint=other');
    render(<HomeView />);
    expect(screen.queryByText(note)).toBeNull();
  });

  it('the file picker takes one file', () => {
    render(<HomeView />);
    const input = screen.getByTestId('file-input') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(false);
    expect(input.accept).toBe('.dem,.bz2,.gz');
    expect(screen.getByRole('button', { name: 'Upload a demo' })).toBeTruthy();
  });

  it('plays the loop, WebM first', async () => {
    const { container } = render(<HomeView />);
    await waitFor(() => expect(container.querySelector('video')).toBeTruthy());
    const video = container.querySelector('video')!;
    expect(video.muted && video.loop && video.autoplay).toBe(true);
    expect(video.getAttribute('playsinline')).not.toBeNull();
    const sources = [...video.querySelectorAll('source')].map((s) =>
      s.getAttribute('type')
    );
    expect(sources).toEqual(['video/webm', 'video/mp4']);
    expect(video.getAttribute('poster')).toContain('/site/home/poster.jpg');
  });

  it('shows the still and no video under reduced motion', async () => {
    reducedMotion(true);
    const { container } = render(<HomeView />);
    await waitFor(() =>
      expect(container.querySelector('img[data-poster]')).toBeTruthy()
    );
    expect(container.querySelector('video')).toBeNull();
  });

  it('a dropped demo opens its replay when done', async () => {
    render(<HomeView />);
    fireEvent.drop(screen.getByTestId('drop-zone'), {
      dataTransfer: { files: [f('match.dem')], types: ['Files'] },
    });
    await waitFor(() => expect(location.pathname).toBe(`/d/${upload.demoId}`));
    expect(upload.calls).toBe(1);
  });

  it('turns two dropped files away', () => {
    render(<HomeView />);
    fireEvent.drop(screen.getByTestId('drop-zone'), {
      dataTransfer: { files: [f('a.dem'), f('b.dem')], types: ['Files'] },
    });
    expect(screen.getByRole('alert').textContent).toBe('One demo at a time.');
    expect(upload.calls).toBe(0);
  });
});
