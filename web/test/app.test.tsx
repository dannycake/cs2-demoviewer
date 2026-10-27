// @vitest-environment jsdom
// App's routing between the upload page and the viewer: the viewer as soon as its chunk is in,
// the upload page kept until then, and a view that fails giving way to the error screen until
// the route changes. Both views are stubbed, and the viewer's chunk loads when the test says
// (`chunk`).

import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, type ComponentType } from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import ErrorBoundary from '../src/components/ErrorBoundary';

/**
 * The viewer's chunk: in once `arrive()` is called, or failed once `fail()` is; whether the
 * viewer throws in render; how often an upload page was mounted.
 */
const chunk = vi.hoisted(() => ({
  arrive: () => {},
  fail: (() => {}) as (e: unknown) => void,
  arrived: Promise.resolve(),
  broken: false,
  uploadMounts: 0,
}));

vi.mock('../src/chunk', () => ({
  importOrReload: <T,>(load: () => Promise<T>) => chunk.arrived.then(load),
}));

vi.mock('../src/views/UploadView', () => ({
  default: function UploadView() {
    useEffect(() => {
      chunk.uploadMounts++;
    }, []);
    return <div data-testid="upload-view" />;
  },
}));

vi.mock('../src/views/DemoView', () => ({
  default: function DemoView({ demoId }: { demoId: string }) {
    if (chunk.broken) throw new Error('the viewer is broken');
    return <div data-testid="demo-view">{demoId}</div>;
  },
}));

/** A fresh App, whose lazy viewer has not loaded yet. */
async function freshApp(): Promise<ComponentType> {
  vi.resetModules();
  return (await import('../src/App')).default;
}

/** Moves the app to `path` as the upload page's openDemo does, or as Back does. */
async function go(path: string) {
  await act(async () => {
    history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

let errors: MockInstance<typeof console.error>;

beforeEach(() => {
  chunk.arrived = new Promise<void>((resolve, reject) => {
    chunk.arrive = resolve;
    chunk.fail = reject;
  });
  chunk.broken = false;
  chunk.uploadMounts = 0;
  // React reports each caught error too.
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

describe('App', () => {
  it('keeps the upload page up while the viewer’s chunk loads', async () => {
    const App = await freshApp();
    const { container } = render(<App />);
    expect(screen.getByTestId('upload-view')).toBeTruthy();

    // An upload done: openDemo, before the chunk is in.
    await go('/d/demo1');
    expect(screen.getByTestId('upload-view')).toBeTruthy();
    expect(container.childElementCount).toBe(1);

    await act(async () => chunk.arrive());
    expect((await screen.findByTestId('demo-view')).textContent).toBe('demo1');
    expect(screen.queryByTestId('upload-view')).toBeNull();
    // The same upload page all along, not one made again.
    expect(chunk.uploadMounts).toBe(1);
  });

  it('shows nothing on a demo’s own link until the chunk is in', async () => {
    history.replaceState(null, '', '/d/demo1');
    const App = await freshApp();
    const { container } = render(<App />);
    expect(container.childElementCount).toBe(0);
    await act(async () => chunk.arrive());
    expect((await screen.findByTestId('demo-view')).textContent).toBe('demo1');
  });

  it('shows the viewer as soon as its chunk is in, without the 300 ms React holds a lazy reveal to', async () => {
    history.replaceState(null, '', '/d/demo1');
    const App = await freshApp();
    render(<App />);
    const arrived = performance.now();
    chunk.arrive();
    await screen.findByTestId('demo-view');
    // React.lazy under Suspense showed it 300 ms after its fallback (the first render), however
    // soon the chunk came.
    expect(performance.now() - arrived).toBeLessThan(250);
  });

  it('ends a viewer chunk that will not load on the error screen', async () => {
    history.replaceState(null, '', '/d/demo1');
    const App = await freshApp();
    render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    );
    await act(async () =>
      chunk.fail(new TypeError('Failed to fetch dynamically imported module'))
    );
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(
      screen.getByText('Failed to fetch dynamically imported module')
    ).toBeTruthy();
    // Back to the upload page.
    await go('/');
    expect(screen.getByTestId('upload-view')).toBeTruthy();
  });

  it('goes back to the upload page from the error screen', async () => {
    chunk.broken = true;
    chunk.arrive();
    history.replaceState(null, '', '/d/demo1');
    const App = await freshApp();
    // As main.tsx renders it, under the root boundary.
    render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    );
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('the viewer is broken')).toBeTruthy();
    expect(
      errors.mock.calls.some((c) =>
        String(c[0]).startsWith('demoviewer: render error')
      )
    ).toBe(true);

    await go('/');
    expect(screen.getByTestId('upload-view')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();

    // And a demo again tries the viewer again.
    chunk.broken = false;
    await go('/d/demo2');
    expect((await screen.findByTestId('demo-view')).textContent).toBe('demo2');
  });
});
