// @vitest-environment jsdom
// How an open panel closes (state/dismiss `useDismiss`): a press outside it, marked spent for
// the views under it, and an Escape no other panel has spent, which it spends before the key
// map hears it. Then the panels that use it, as the viewer has them.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Highlights from '../src/components/hud/Highlights';
import Scoreboard from '../src/components/hud/Scoreboard';
import { useScoreboard } from '../src/components/hud/scoreboard-state';
import Settings from '../src/components/hud/Settings';
import PlayerList from '../src/components/PlayerList';
import ShareButton from '../src/components/ShareButton';
import {
  isDismissal,
  useDismiss,
  type DismissOptions,
} from '../src/state/dismiss';
import { handleKey } from '../src/state/keys';
import { playbackStore } from '../src/state/store';
import { threeRoundStore } from './helpers/playback-pack';
import { trackPack } from './helpers/track-pack';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  playbackStore.getState().setPack(null);
  useScoreboard.getState().close();
});

const twoPlayers = () =>
  trackPack({ players: [() => ({}), () => ({})], samples: 10 });

/** A panel open from the start, whose `close` the test watches. */
function Panel({
  name,
  close,
  options,
}: {
  name: string;
  close: () => void;
  options?: DismissOptions;
}) {
  const [open, setOpen] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    root,
    () => {
      close();
      setOpen(false);
    },
    options
  );
  return (
    <div ref={root} data-testid={name} data-open={open}>
      <button type="button">inside {name}</button>
    </div>
  );
}

/** A pointerdown on `el`, as the browser sends it (it bubbles to `window`). */
function press(el: Element): Event {
  const e = new Event('pointerdown', { bubbles: true });
  el.dispatchEvent(e);
  return e;
}

/** An Escape keydown on `el`; the event, to read `defaultPrevented`. */
function escape(el: Element = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(e);
  return e;
}

describe('useDismiss', () => {
  it('closes on a press outside the panel and marks that press spent; a press inside is not', () => {
    const close = vi.fn();
    render(
      <>
        <Panel name="a" close={close} />
        <p data-testid="outside">elsewhere</p>
      </>
    );
    const inside = press(screen.getByText('inside a'));
    expect(close).not.toHaveBeenCalled();
    expect(isDismissal(inside)).toBe(false);
    let outside!: Event;
    act(() => {
      outside = press(screen.getByTestId('outside'));
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(isDismissal(outside)).toBe(true);
    expect(screen.getByTestId('a').dataset.open).toBe('false');
    // Closed, it hears nothing more.
    press(screen.getByTestId('outside'));
    escape();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('leaves a press on what `ignore` names alone', () => {
    const close = vi.fn();
    render(
      <>
        <Panel
          name="a"
          close={close}
          options={{ ignore: (t) => t.closest('[data-toggle]') !== null }}
        />
        <button type="button" data-toggle>
          <span data-testid="toggle">toggle</span>
        </button>
      </>
    );
    const e = press(screen.getByTestId('toggle'));
    expect(close).not.toHaveBeenCalled();
    expect(isDismissal(e)).toBe(false);
  });

  it('closes on Escape and spends it: one Escape closes one panel, and the key map leaves it', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    render(
      <>
        <Panel name="a" close={closeA} />
        <Panel name="b" close={closeB} />
      </>
    );
    const store = threeRoundStore();
    store.getState().setHighlights(true);
    let first!: KeyboardEvent;
    act(() => {
      first = escape();
    });
    expect(first.defaultPrevented).toBe(true);
    expect(closeA.mock.calls.length + closeB.mock.calls.length).toBe(1);
    // The key map (DemoView, on `window` after the panels) leaves the spent Escape alone.
    expect(handleKey(first, store)).toBe(false);
    expect(store.getState().highlights).toBe(true);
    act(() => {
      escape();
    });
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    // With both closed, the next Escape is the key map's.
    const third = escape();
    expect(third.defaultPrevented).toBe(false);
    expect(handleKey(third, store)).toBe(true);
    expect(store.getState().highlights).toBe(false);
  });

  it('leaves Escape alone with `escape: false`, and one another panel spent', () => {
    const close = vi.fn();
    render(<Panel name="a" close={close} options={{ escape: false }} />);
    const e = escape();
    expect(e.defaultPrevented).toBe(false);
    expect(close).not.toHaveBeenCalled();

    cleanup();
    render(<Panel name="b" close={close} />);
    const spent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    spent.preventDefault();
    window.dispatchEvent(spent);
    expect(close).not.toHaveBeenCalled();
  });

  it('calls the close of the latest render, without listening again', () => {
    const first = vi.fn();
    const second = vi.fn();
    const root = { current: null as HTMLDivElement | null };
    function Host({ close }: { close: () => void }) {
      useDismiss(true, root, close);
      return <div ref={root} />;
    }
    const add = vi.spyOn(window, 'addEventListener');
    const { rerender } = render(<Host close={first} />);
    const added = add.mock.calls.length;
    rerender(<Host close={second} />);
    expect(add.mock.calls.length).toBe(added);
    press(document.body);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops listening when the panel unmounts', () => {
    const close = vi.fn();
    const { unmount } = render(<Panel name="a" close={close} />);
    unmount();
    press(document.body);
    escape();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('the panels that close with it', () => {
  it('the settings close on a press outside (marked) and on Escape (spent)', () => {
    render(
      <>
        <Settings />
        <p data-testid="outside">elsewhere</p>
      </>
    );
    const gear = screen.getByRole('button', { name: 'Settings' });
    fireEvent.click(gear);
    expect(gear.getAttribute('aria-expanded')).toBe('true');
    let e!: Event;
    act(() => {
      e = press(screen.getByTestId('outside'));
    });
    expect(gear.getAttribute('aria-expanded')).toBe('false');
    expect(isDismissal(e)).toBe(true);

    fireEvent.click(gear);
    // A press inside the panel keeps it open.
    press(gear);
    expect(gear.getAttribute('aria-expanded')).toBe('true');
    let key!: KeyboardEvent;
    act(() => {
      key = escape();
    });
    expect(gear.getAttribute('aria-expanded')).toBe('false');
    expect(key.defaultPrevented).toBe(true);
  });

  it('the Share field (no clipboard here) opens selected and closes on Escape or a press outside', async () => {
    playbackStore.getState().setPack(twoPlayers());
    render(
      <>
        <ShareButton />
        <p data-testid="outside">elsewhere</p>
      </>
    );
    const button = screen.getByRole('button', { name: /share/i });
    fireEvent.click(button);
    const field = await screen.findByRole('textbox');
    // Focused by the effect that runs with the one that listens.
    await waitFor(() => expect(document.activeElement).toBe(field));
    // A press in the field keeps it.
    press(field);
    expect(screen.queryByRole('textbox')).not.toBeNull();
    let key!: KeyboardEvent;
    act(() => {
      key = escape(field);
    });
    expect(key.defaultPrevented).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(button);
    const again = await screen.findByRole('textbox');
    // Focused by the effect that runs with the one that listens.
    await waitFor(() => expect(document.activeElement).toBe(again));
    let e!: Event;
    act(() => {
      e = press(screen.getByTestId('outside'));
    });
    expect(isDismissal(e)).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('the player sheet closes on a press outside (marked) and on Escape (spent)', () => {
    playbackStore.getState().setPack(twoPlayers());
    render(
      <>
        <PlayerList mode="sheet" />
        <p data-testid="outside">elsewhere</p>
      </>
    );
    const sheet = screen.getByRole('complementary', { name: 'Players' });
    const toggle = sheet.querySelector('button')!;
    fireEvent.click(toggle);
    expect(sheet.dataset.open).toBe('true');
    let e!: Event;
    act(() => {
      e = press(screen.getByTestId('outside'));
    });
    expect(sheet.dataset.open).toBe('false');
    expect(isDismissal(e)).toBe(true);
    fireEvent.click(toggle);
    let key!: KeyboardEvent;
    act(() => {
      key = escape();
    });
    expect(sheet.dataset.open).toBe('false');
    expect(key.defaultPrevented).toBe(true);
  });

  it('the highlights close on a press outside but not on their toggle, and leave Escape to the key map', () => {
    playbackStore.getState().setPack(twoPlayers());
    playbackStore.getState().setHighlights(true);
    render(
      <>
        <Highlights />
        <button type="button" data-highlights-toggle>
          Highlights
        </button>
        <p data-testid="outside">elsewhere</p>
      </>
    );
    expect(screen.queryByRole('dialog', { name: 'Highlights' })).not.toBeNull();
    press(screen.getByRole('button', { name: 'Highlights' }));
    const key = escape();
    expect(key.defaultPrevented).toBe(false);
    expect(playbackStore.getState().highlights).toBe(true);
    let e!: Event;
    act(() => {
      e = press(screen.getByTestId('outside'));
    });
    expect(isDismissal(e)).toBe(true);
    expect(playbackStore.getState().highlights).toBe(false);
  });

  it('the scoreboard, opened by a click, closes on a press outside but not on the player card', () => {
    playbackStore.getState().setPack(twoPlayers());
    render(
      <>
        <Scoreboard />
        <button type="button" data-scoreboard-toggle>
          card
        </button>
        <p data-testid="outside">elsewhere</p>
      </>
    );
    act(() => useScoreboard.getState().togglePinned());
    expect(screen.queryByRole('dialog', { name: 'Scoreboard' })).not.toBeNull();
    press(screen.getByRole('button', { name: 'card' }));
    expect(useScoreboard.getState().pinned).toBe(true);
    let e!: Event;
    act(() => {
      e = press(screen.getByTestId('outside'));
    });
    expect(isDismissal(e)).toBe(true);
    expect(useScoreboard.getState().pinned).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Scoreboard' })).toBeNull();
  });
});
