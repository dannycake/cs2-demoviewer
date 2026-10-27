import { describe, expect, it, vi } from 'vitest';
import { createSettingsStore } from '../src/state/settings';
import { trackFocus } from '../src/state/focus';
import { escapeCloses } from '../src/state/dismiss';
import { handleKey, keyAction } from '../src/state/keys';
import { createPlaybackStore } from '../src/state/store';
import { playbackPack, threeRoundStore } from './helpers/playback-pack';
import { event } from './helpers/track-pack';

const key = (code: string, k = '') => ({ code, key: k });

describe('handleKey', () => {
  it('Space toggles play', () => {
    const store = threeRoundStore();
    expect(handleKey(key('Space', ' '), store)).toBe(true);
    expect(store.getState().playing).toBe(true);
    expect(handleKey(key('Space', ' '), store)).toBe(true);
    expect(store.getState().playing).toBe(false);
  });

  it('a held Space does not flicker play and pause', () => {
    const store = threeRoundStore();
    handleKey(key('Space', ' '), store);
    expect(handleKey({ ...key('Space', ' '), repeat: true }, store)).toBe(true);
    expect(store.getState().playing).toBe(true);
  });

  it('ArrowRight / ArrowLeft go to the next / previous round at its freeze_end_tick', () => {
    const store = threeRoundStore();
    store.getState().seekTick(200);
    expect(handleKey(key('ArrowRight', 'ArrowRight'), store)).toBe(true);
    expect(store.getState()).toMatchObject({ round: 1, tick: 450 });
    handleKey(key('ArrowRight', 'ArrowRight'), store);
    handleKey(key('ArrowRight', 'ArrowRight'), store); // already on the last round
    expect(store.getState()).toMatchObject({ round: 2, tick: 750 });
    handleKey(key('ArrowLeft', 'ArrowLeft'), store);
    expect(store.getState()).toMatchObject({ round: 1, tick: 450 });
  });

  it('. and , step one sample and pause', () => {
    // Samples of the first round sit at 100 + 8k.
    const store = threeRoundStore();
    store.getState().seekTick(196);
    store.getState().play();
    expect(handleKey(key('Period', '.'), store)).toBe(true);
    expect(store.getState()).toMatchObject({ tick: 204, playing: false });
    handleKey(key('Comma', ','), store);
    handleKey(key('Comma', ','), store);
    expect(store.getState().tick).toBe(188);
    // Off the sample grid: to the neighbouring sample, not a whole step away.
    store.getState().seekTick(199.5);
    handleKey(key('Period', '.'), store);
    expect(store.getState().tick).toBe(204);
    store.getState().seekTick(199.5);
    handleKey(key('Comma', ','), store);
    expect(store.getState().tick).toBe(196);
    // Stepping stays inside the round.
    store.getState().seekTick(100);
    handleKey(key('Comma', ','), store);
    expect(store.getState().tick).toBe(100);
    store.getState().seekTick(300);
    handleKey(key('Period', '.'), store);
    expect(store.getState().tick).toBe(300);
  });

  it('Digit3 follows player index 2 in POV, the default camera', () => {
    const store = threeRoundStore();
    expect(handleKey(key('Digit3', '3'), store)).toBe(true);
    expect(store.getState()).toMatchObject({ follow: 2, camera: 'pov' });
    handleKey(key('Digit0', '0'), store);
    expect(store.getState().follow).toBe(9);
  });

  it('Digit3 with two players does nothing', () => {
    const store = threeRoundStore(2);
    expect(handleKey(key('Digit3', '3'), store)).toBe(false);
    // The first player is followed from the start, not picked by the user.
    expect(store.getState()).toMatchObject({
      follow: 0,
      followPinned: false,
      camera: 'pov',
    });
    handleKey(key('Digit2', '2'), store);
    expect(store.getState()).toMatchObject({ follow: 1, followPinned: true });
    expect(handleKey(key('Digit3', '3'), store)).toBe(false);
    expect(store.getState().follow).toBe(1);
  });

  it('a digit keeps the POV camera and switches whose eyes', () => {
    const store = threeRoundStore();
    handleKey(key('Digit1', '1'), store);
    handleKey(key('KeyV', 'v'), store);
    handleKey(key('Digit4', '4'), store);
    expect(store.getState()).toMatchObject({ follow: 3, camera: 'pov' });
  });

  it('KeyV and KeyC pick the POV and free cameras; KeyF (Follow, gone) and KeyT do nothing', () => {
    const store = threeRoundStore();
    expect(handleKey(key('KeyC', 'c'), store)).toBe(true);
    expect(store.getState()).toMatchObject({ camera: 'free', follow: 0 });
    handleKey(key('KeyV', 'v'), store);
    expect(store.getState().camera).toBe('pov');
    handleKey(key('KeyC', 'c'), store);
    for (const [code, typed] of [
      ['KeyF', 'f'],
      ['KeyF', 'F'],
      ['KeyT', 't'],
    ]) {
      expect(handleKey(key(code, typed), store)).toBe(false);
      expect(keyAction(key(code, typed))).toBeNull();
    }
    expect(store.getState().camera).toBe('free');
  });

  it('KeyA is the director toggle', () => {
    expect(keyAction(key('KeyA', 'a'))).toEqual({ kind: 'director' });
    expect(keyAction(key('KeyV', 'v'))).toEqual({
      kind: 'camera',
      mode: 'pov',
    });
    expect(keyAction(key('KeyC', 'c'))).toEqual({
      kind: 'camera',
      mode: 'free',
    });
  });

  it('R opens and closes the full radar, once per press, with a pack, in Free too', () => {
    expect(keyAction(key('KeyR', 'r'))).toEqual({ kind: 'radar' });
    const empty = createPlaybackStore({ storage: null });
    expect(handleKey(key('KeyR', 'r'), empty)).toBe(false);
    expect(empty.getState().radar).toBe(false);
    const store = threeRoundStore();
    store.getState().setCamera('free');
    expect(handleKey(key('KeyR', 'r'), store)).toBe(true);
    expect(store.getState().radar).toBe(true);
    expect(handleKey({ ...key('KeyR', 'r'), repeat: true }, store)).toBe(true);
    expect(store.getState().radar).toBe(true);
    expect(handleKey(key('KeyR', 'r'), store)).toBe(true);
    expect(store.getState().radar).toBe(false);
  });

  it('A turns the director on and off, once per press, with a pack', () => {
    const empty = createPlaybackStore({ storage: null });
    expect(handleKey(key('KeyA', 'a'), empty)).toBe(false);
    expect(empty.getState().director).toBe(false);
    const store = threeRoundStore();
    expect(handleKey(key('KeyA', 'a'), store)).toBe(true);
    expect(store.getState().director).toBe(true);
    expect(handleKey({ ...key('KeyA', 'a'), repeat: true }, store)).toBe(true);
    expect(store.getState().director).toBe(true);
    expect(handleKey(key('KeyA', 'a'), store)).toBe(true);
    expect(store.getState().director).toBe(false);
  });

  it('in Free, W A S D Q E are left to the fly camera', () => {
    const store = threeRoundStore();
    store.getState().setCamera('free');
    const quality = store.getState().quality;
    for (const [code, k] of [
      ['KeyW', 'w'],
      ['KeyA', 'a'],
      ['KeyS', 's'],
      ['KeyD', 'd'],
      ['KeyQ', 'q'],
      ['KeyE', 'e'],
    ])
      expect(handleKey(key(code, k), store)).toBe(false);
    expect(store.getState()).toMatchObject({ camera: 'free', quality });
    // A digit picks who to follow but leaves the free camera where it is.
    expect(handleKey(key('Digit4', '4'), store)).toBe(true);
    expect(store.getState()).toMatchObject({ camera: 'free', follow: 3 });
    // Outside Free, Q is the quality preset again.
    handleKey(key('KeyV', 'v'), store);
    expect(handleKey(key('KeyQ', 'q'), store)).toBe(true);
    expect(store.getState().quality).not.toBe(quality);
  });

  it('falls back to the typed character when the physical key is unmapped', () => {
    const store = threeRoundStore();
    // AZERTY: "," is on the physical M key.
    expect(handleKey(key('KeyM', ','), store)).toBe(true);
    expect(store.getState().tick).toBe(148); // from freeze end 150
  });

  it('leaves unmapped keys and browser shortcuts alone', () => {
    const store = threeRoundStore();
    expect(handleKey(key('KeyZ', 'z'), store)).toBe(false);
    expect(handleKey({ ...key('KeyC', 'c'), ctrlKey: true }, store)).toBe(
      false
    );
    expect(handleKey({ ...key('KeyC', 'c'), metaKey: true }, store)).toBe(
      false
    );
    expect(store.getState().camera).toBe('pov');
  });

  it('X turns the outlines through walls on and off, once per press, with or without a pack', () => {
    expect(keyAction(key('KeyX', 'x'))).toEqual({ kind: 'xray' });
    const settings = createSettingsStore(null);
    const store = threeRoundStore();
    expect(settings.getState().settings.xray).toBe(true);
    expect(handleKey(key('KeyX', 'x'), store, settings)).toBe(true);
    expect(settings.getState().settings.xray).toBe(false);
    // A held X would flicker the outlines.
    expect(
      handleKey({ ...key('KeyX', 'x'), repeat: true }, store, settings)
    ).toBe(true);
    expect(settings.getState().settings.xray).toBe(false);
    expect(handleKey(key('KeyX', 'x'), store, settings)).toBe(true);
    expect(settings.getState().settings.xray).toBe(true);
    // Not a fly key: Free keeps it.
    store.getState().setCamera('free');
    expect(handleKey(key('KeyX', 'x'), store, settings)).toBe(true);
    expect(settings.getState().settings.xray).toBe(false);
    const empty = createPlaybackStore({ storage: null });
    expect(handleKey(key('KeyX', 'x'), empty, settings)).toBe(true);
    expect(settings.getState().settings.xray).toBe(true);
    // Matched by code: the physical X key on AZERTY too; never with a modifier.
    expect(keyAction(key('KeyX', 'é'))).toEqual({ kind: 'xray' });
    expect(
      handleKey({ ...key('KeyX', 'x'), ctrlKey: true }, store, settings)
    ).toBe(false);
    expect(settings.getState().settings.xray).toBe(true);
  });

  it('X typed into a text field is not a shortcut', () => {
    // The node test environment has no DOM: just enough of its element classes.
    class El {
      isContentEditable = false;
    }
    class Input extends El {
      type = 'text';
    }
    vi.stubGlobal('HTMLElement', El);
    vi.stubGlobal('HTMLInputElement', Input);
    vi.stubGlobal('HTMLTextAreaElement', class extends El {});
    vi.stubGlobal('HTMLSelectElement', class extends El {});
    try {
      const settings = createSettingsStore(null);
      const store = threeRoundStore();
      const field = new Input();
      expect(
        handleKey(
          { ...key('KeyX', 'x'), target: field as never },
          store,
          settings
        )
      ).toBe(false);
      expect(settings.getState().settings.xray).toBe(true);
      // A checkbox is not a text field.
      field.type = 'checkbox';
      expect(
        handleKey(
          { ...key('KeyX', 'x'), target: field as never },
          store,
          settings
        )
      ).toBe(true);
      expect(settings.getState().settings.xray).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves Space and Enter to a checkbox, radio, button or select the keyboard focused', () => {
    // How the element was focused, as `:focus-visible` tells it: by the keyboard, by the mouse,
    // or unknown (a browser without the pseudo-class throws on it).
    class El {
      isContentEditable = false;
      focus: 'keyboard' | 'mouse' | 'unsupported' = 'keyboard';
      matches(selector: string): boolean {
        if (selector !== ':focus-visible') return false;
        if (this.focus === 'unsupported') throw new SyntaxError(selector);
        return this.focus === 'keyboard';
      }
    }
    class Input extends El {
      type = 'checkbox';
    }
    class Button extends El {}
    class Select extends El {}
    vi.stubGlobal('HTMLElement', El);
    vi.stubGlobal('HTMLInputElement', Input);
    vi.stubGlobal('HTMLButtonElement', Button);
    vi.stubGlobal('HTMLTextAreaElement', class extends El {});
    vi.stubGlobal('HTMLSelectElement', Select);
    try {
      const store = threeRoundStore();
      const input = new Input();
      const space = (target: El) =>
        handleKey({ ...key('Space', ' '), target: target as never }, store);
      for (const type of ['checkbox', 'radio', 'button', 'submit', 'reset']) {
        input.type = type;
        expect(space(input), type).toBe(false);
      }
      expect(space(new Button())).toBe(false);
      expect(space(new Select())).toBe(false);
      expect(
        handleKey(
          { ...key('Enter', 'Enter'), target: new Button() as never },
          store
        )
      ).toBe(false);
      expect(store.getState().playing).toBe(false);
      // The other keys still work there, and Space plays from the scrubber and the page.
      input.type = 'checkbox';
      expect(
        handleKey(
          { ...key('ArrowRight', 'ArrowRight'), target: input as never },
          store
        )
      ).toBe(true);
      expect(store.getState().round).toBe(1);
      input.type = 'range';
      expect(space(input)).toBe(true);
      expect(store.getState().playing).toBe(true);
      expect(space(new El())).toBe(true);
      expect(store.getState().playing).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('plays and pauses with Space on a checkbox or button the mouse focused, or with no :focus-visible', () => {
    class El {
      isContentEditable = false;
      focus: 'keyboard' | 'mouse' | 'unsupported' = 'mouse';
      matches(selector: string): boolean {
        if (selector !== ':focus-visible') return false;
        if (this.focus === 'unsupported') throw new SyntaxError(selector);
        return this.focus === 'keyboard';
      }
    }
    class Input extends El {
      type = 'checkbox';
    }
    class Button extends El {}
    vi.stubGlobal('HTMLElement', El);
    vi.stubGlobal('HTMLInputElement', Input);
    vi.stubGlobal('HTMLButtonElement', Button);
    vi.stubGlobal('HTMLTextAreaElement', class extends El {});
    vi.stubGlobal('HTMLSelectElement', class extends El {});
    try {
      const store = threeRoundStore();
      const space = (target: El) =>
        handleKey({ ...key('Space', ' '), target: target as never }, store);
      // Clicked: a camera button, Highlights, a settings checkbox.
      const button = new Button();
      expect(space(button)).toBe(true);
      expect(store.getState().playing).toBe(true);
      const box = new Input();
      expect(space(box)).toBe(true);
      expect(store.getState().playing).toBe(false);
      // A browser without :focus-visible: play and pause, as before.
      button.focus = 'unsupported';
      expect(space(button)).toBe(true);
      expect(store.getState().playing).toBe(true);
      // The same button reached with Tab is the button's.
      button.focus = 'keyboard';
      expect(space(button)).toBe(false);
      expect(store.getState().playing).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads how a control got focus when it took it: a key down makes any focus visible', () => {
    class El {
      isContentEditable = false;
      focus: 'keyboard' | 'mouse' = 'mouse';
      matches(selector: string): boolean {
        return selector === ':focus-visible' && this.focus === 'keyboard';
      }
      closest(): El | null {
        return this instanceof Button ? this : null;
      }
    }
    class Button extends El {}
    vi.stubGlobal('Element', El);
    vi.stubGlobal('HTMLElement', El);
    vi.stubGlobal('HTMLInputElement', class extends El {});
    vi.stubGlobal('HTMLButtonElement', Button);
    vi.stubGlobal('HTMLTextAreaElement', class extends El {});
    vi.stubGlobal('HTMLSelectElement', class extends El {});
    const listeners = new Map<string, (e: Event) => void>();
    const doc = {
      addEventListener: (type: string, f: (e: Event) => void) =>
        void listeners.set(type, f),
      removeEventListener: (type: string) => void listeners.delete(type),
    };
    const fire = (type: string, target: El) =>
      listeners.get(type)!({ target } as unknown as Event);
    const untrack = trackFocus(doc as never);
    try {
      const store = threeRoundStore();
      const space = (target: El) =>
        handleKey({ ...key('Space', ' '), target: target as never }, store);
      // Clicked: focused without a visible focus, which the Space's keydown then turns on.
      const clicked = new Button();
      fire('focusin', clicked);
      clicked.focus = 'keyboard';
      expect(space(clicked)).toBe(true);
      expect(store.getState().playing).toBe(true);
      // Reached with Tab: the button's.
      const tabbed = new Button();
      tabbed.focus = 'keyboard';
      fire('focusin', tabbed);
      expect(space(tabbed)).toBe(false);
      expect(store.getState().playing).toBe(true);
      // Then clicked, keeping focus: Space plays and pauses again.
      fire('pointerdown', tabbed);
      expect(space(tabbed)).toBe(true);
      expect(store.getState().playing).toBe(false);
      untrack();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('playback keys do nothing before a pack is loaded', () => {
    const store = createPlaybackStore({ storage: null });
    expect(handleKey(key('Space', ' '), store)).toBe(false);
    expect(handleKey(key('Digit1', '1'), store)).toBe(false);
    expect(store.getState()).toMatchObject({ playing: false, follow: null });
  });
});

describe('reel keys', () => {
  // Player 1 (index 0) kills player 6 (index 5) at 200, in the first round.
  function reelStore() {
    const store = createPlaybackStore({ storage: null });
    store.getState().setPack(
      playbackPack({
        rounds: [
          { start: 100, freeze: 150, end: 300 },
          { start: 400, freeze: 450, end: 600 },
        ],
        events: [
          event('player_death', 200, {
            user_idx: 5,
            attacker_idx: 0,
            weapon: 'ak47',
          }),
        ],
      })
    );
    store.getState().setFollow(5);
    store.getState().seekTick(250);
    return store;
  }

  it('K, N, H and Escape map by code to the kill cam, next, the highlights and leaving', () => {
    expect(keyAction(key('KeyK', 'k'))).toEqual({ kind: 'killcam' });
    expect(keyAction(key('KeyN', 'n'))).toEqual({ kind: 'next' });
    expect(keyAction(key('KeyH', 'h'))).toEqual({ kind: 'highlights' });
    expect(keyAction(key('Escape', 'Escape'))).toEqual({ kind: 'escape' });
    // The physical keys on another layout.
    expect(keyAction(key('KeyK', 'ĸ'))).toEqual({ kind: 'killcam' });
    expect(keyAction(key('KeyH', 'ħ'))).toEqual({ kind: 'highlights' });
    expect(keyAction({ ...key('KeyK', 'k'), ctrlKey: true })).toBeNull();
  });

  it("K plays the followed player's kill cam, once per press, with a pack", () => {
    const empty = createPlaybackStore({ storage: null });
    expect(handleKey(key('KeyK', 'k'), empty)).toBe(false);
    const store = reelStore();
    expect(handleKey(key('KeyK', 'k'), store)).toBe(true);
    expect(store.getState()).toMatchObject({
      reel: { kind: 'killcam' },
      camera: 'pov',
      follow: 0,
      tick: 150,
    });
    // A held K does not start it again.
    store.setState({ tick: 180 });
    expect(handleKey({ ...key('KeyK', 'k'), repeat: true }, store)).toBe(true);
    expect(store.getState().tick).toBe(180);
  });

  it('N goes to the next segment while a reel plays, once per press; without one it is not used', () => {
    const store = reelStore();
    expect(handleKey(key('KeyN', 'n'), store)).toBe(false);
    const segs = [
      { round: 0, from: 160, to: 200, camera: 'pov', follow: 1, title: 'a' },
      { round: 1, from: 460, to: 500, camera: 'pov', follow: 2, title: 'b' },
      { round: 1, from: 520, to: 560, camera: 'pov', follow: 3, title: 'c' },
    ] as const;
    store.getState().startReel('highlights', segs, 'continue');
    expect(handleKey({ ...key('KeyN', 'n'), repeat: true }, store)).toBe(true);
    expect(store.getState().reel?.index).toBe(0);
    expect(handleKey(key('KeyN', 'n'), store)).toBe(true);
    expect(store.getState()).toMatchObject({
      reel: { index: 1 },
      round: 1,
      tick: 460,
    });
  });

  it('H opens and closes the highlights, once per press, with a pack', () => {
    const empty = createPlaybackStore({ storage: null });
    expect(handleKey(key('KeyH', 'h'), empty)).toBe(false);
    expect(empty.getState().highlights).toBe(false);
    const store = reelStore();
    expect(handleKey(key('KeyH', 'h'), store)).toBe(true);
    expect(store.getState().highlights).toBe(true);
    expect(handleKey({ ...key('KeyH', 'h'), repeat: true }, store)).toBe(true);
    expect(store.getState().highlights).toBe(true);
    expect(handleKey(key('KeyH', 'h'), store)).toBe(true);
    expect(store.getState().highlights).toBe(false);
  });

  it('Escape closes the highlights first, then leaves the reel, then passes through', () => {
    const store = reelStore();
    expect(handleKey(key('Escape', 'Escape'), store)).toBe(false);
    store.getState().killcam();
    store.getState().setHighlights(true);
    expect(handleKey(key('Escape', 'Escape'), store)).toBe(true);
    expect(store.getState().highlights).toBe(false);
    expect(store.getState().reel).not.toBeNull();
    // A held Escape that closed the panel does not leave the reel too.
    expect(handleKey({ ...key('Escape', 'Escape'), repeat: true }, store)).toBe(
      true
    );
    expect(store.getState().reel).not.toBeNull();
    expect(handleKey(key('Escape', 'Escape'), store)).toBe(true);
    expect(store.getState()).toMatchObject({
      reel: null,
      tick: 250,
      camera: 'pov',
      follow: 5,
    });
    expect(handleKey(key('Escape', 'Escape'), store)).toBe(false);
    expect(handleKey({ ...key('Escape', 'Escape'), repeat: true }, store)).toBe(
      false
    );
  });

  it('one Escape does one thing: a panel that takes it leaves the highlights and the reel alone', () => {
    const store = reelStore();
    store.getState().killcam();
    store.getState().setHighlights(true);
    /** A keydown of Escape, as the browser hands it to each listener in turn. */
    const escape = () => {
      const e = {
        ...key('Escape', 'Escape'),
        type: 'keydown',
        defaultPrevented: false,
        preventDefault() {
          e.defaultPrevented = true;
        },
      };
      return e;
    };

    // The settings (or the scoreboard) is open: it takes the Escape, and the key map passes.
    const first = escape();
    expect(escapeCloses(first, true)).toBe(true);
    first.preventDefault();
    expect(handleKey(first, store)).toBe(false);
    expect(store.getState().highlights).toBe(true);
    expect(store.getState().reel).not.toBeNull();
    // A second panel listening for the same key leaves it too.
    expect(escapeCloses(first, true)).toBe(false);

    // With every panel closed, the next Escape reaches the key map: it closes the highlights.
    const second = escape();
    expect(escapeCloses(second, false)).toBe(false);
    expect(handleKey(second, store)).toBe(true);
    expect(store.getState().highlights).toBe(false);
    expect(store.getState().reel).not.toBeNull();

    // Other keys are not a panel's Escape.
    expect(escapeCloses({ key: 'Tab', defaultPrevented: false }, true)).toBe(
      false
    );
  });

  it('are not fly keys: Free keeps them', () => {
    const store = reelStore();
    store.getState().setCamera('free');
    expect(handleKey(key('KeyH', 'h'), store)).toBe(true);
    expect(handleKey(key('Escape', 'Escape'), store)).toBe(true);
    expect(handleKey(key('KeyK', 'k'), store)).toBe(true);
    expect(store.getState().reel).not.toBeNull();
    expect(handleKey(key('KeyN', 'n'), store)).toBe(true);
    expect(store.getState()).toMatchObject({ reel: null, camera: 'free' });
  });

  it('typed into a text field they are not shortcuts', () => {
    class El {
      isContentEditable = false;
    }
    class Input extends El {
      type = 'text';
    }
    vi.stubGlobal('HTMLElement', El);
    vi.stubGlobal('HTMLInputElement', Input);
    vi.stubGlobal('HTMLTextAreaElement', class extends El {});
    vi.stubGlobal('HTMLSelectElement', class extends El {});
    try {
      const store = reelStore();
      const field = new Input() as never;
      for (const [code, k] of [
        ['KeyK', 'k'],
        ['KeyH', 'h'],
        ['KeyN', 'n'],
      ])
        expect(handleKey({ ...key(code, k), target: field }, store)).toBe(
          false
        );
      expect(store.getState()).toMatchObject({ reel: null, highlights: false });
      store.getState().setHighlights(true);
      expect(
        handleKey({ ...key('Escape', 'Escape'), target: field }, store)
      ).toBe(false);
      expect(store.getState().highlights).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
