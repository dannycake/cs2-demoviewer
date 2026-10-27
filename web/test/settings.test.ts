import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  createSettingsStore,
} from '../src/state/settings';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('settings', () => {
  it('starts with labels, trails and damage numbers on at scale 1', () => {
    const s = createSettingsStore(memory());
    expect(s.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      labels: true,
      trails: true,
      damageNumbers: true,
      hudScale: 1,
      minimap: true,
      xray: true,
      nameTags: true,
      autoKillcam: false,
      roundSummary: true,
      volume: 0.6,
      muted: false,
    });
  });

  it('keeps the volume between 0 and 1, 0.6 when it cannot read it', () => {
    const storage = memory();
    const s = createSettingsStore(storage);
    expect(s.getState().settings.volume).toBe(0.6);
    s.getState().set({ volume: 1.7 });
    expect(s.getState().settings.volume).toBe(1);
    s.getState().set({ volume: -0.2 });
    expect(s.getState().settings.volume).toBe(0);
    s.getState().set({ volume: 0.35 });
    expect(createSettingsStore(storage).getState().settings.volume).toBe(0.35);
    for (const odd of ['x', null, {}, true])
      expect(
        createSettingsStore(
          memory({ [SETTINGS_KEY]: JSON.stringify({ volume: odd }) })
        ).getState().settings.volume
      ).toBe(0.6);
  });

  it('keeps the sound muted across a reload, on unless a boolean says muted', () => {
    const storage = memory();
    const s = createSettingsStore(storage);
    expect(s.getState().settings.muted).toBe(false);
    s.getState().set({ muted: true });
    expect(createSettingsStore(storage).getState().settings.muted).toBe(true);
    for (const odd of ['yes', 1, null, {}])
      expect(
        createSettingsStore(
          memory({ [SETTINGS_KEY]: JSON.stringify({ muted: odd }) })
        ).getState().settings.muted
      ).toBe(false);
  });

  it('keeps the round summary, and reads anything but a boolean as on', () => {
    const storage = memory();
    const s = createSettingsStore(storage);
    expect(s.getState().settings.roundSummary).toBe(true);
    s.getState().set({ roundSummary: false });
    expect(createSettingsStore(storage).getState().settings.roundSummary).toBe(
      false
    );
    for (const odd of ['no', 0, null, {}])
      expect(
        createSettingsStore(
          memory({ [SETTINGS_KEY]: JSON.stringify({ roundSummary: odd }) })
        ).getState().settings.roundSummary
      ).toBe(true);
  });

  it('keeps the kill cam after each death, off unless a boolean says on', () => {
    const storage = memory();
    const s = createSettingsStore(storage);
    expect(s.getState().settings.autoKillcam).toBe(false);
    s.getState().set({ autoKillcam: true });
    expect(createSettingsStore(storage).getState().settings.autoKillcam).toBe(
      true
    );
    for (const odd of ['yes', 1, null, {}])
      expect(
        createSettingsStore(
          memory({ [SETTINGS_KEY]: JSON.stringify({ autoKillcam: odd }) })
        ).getState().settings.autoKillcam
      ).toBe(false);
  });

  it('keeps the names over heads, and reads anything but a boolean as on', () => {
    const storage = memory();
    const s = createSettingsStore(storage);
    expect(s.getState().settings.nameTags).toBe(true);
    s.getState().set({ nameTags: false });
    expect(createSettingsStore(storage).getState().settings.nameTags).toBe(
      false
    );
    for (const odd of ['no', 0, null, {}])
      expect(
        createSettingsStore(
          memory({ [SETTINGS_KEY]: JSON.stringify({ nameTags: odd }) })
        ).getState().settings.nameTags
      ).toBe(true);
  });

  it('keeps the outlines through walls, and reads anything but a boolean as on', () => {
    const storage = memory();
    const s = createSettingsStore(storage);
    expect(s.getState().settings.xray).toBe(true);
    s.getState().set({ xray: false });
    expect(createSettingsStore(storage).getState().settings.xray).toBe(false);
    for (const odd of ['no', 0, null, {}])
      expect(
        createSettingsStore(
          memory({ [SETTINGS_KEY]: JSON.stringify({ xray: odd }) })
        ).getState().settings.xray
      ).toBe(true);
  });

  it('keeps the minimap switch, and reads anything but a boolean as on', () => {
    const storage = memory();
    const s = createSettingsStore(storage);
    s.getState().set({ minimap: false });
    expect(createSettingsStore(storage).getState().settings.minimap).toBe(
      false
    );
    storage.data.set(SETTINGS_KEY, JSON.stringify({ minimap: 'no' }));
    expect(createSettingsStore(storage).getState().settings.minimap).toBe(true);
  });

  it('remembers a change under demoviewer.settings and reads it back', () => {
    const storage = memory();
    const s = createSettingsStore(storage);
    s.getState().set({ trails: false, hudScale: 1.2 });
    expect(SETTINGS_KEY).toBe('demoviewer.settings');
    expect(JSON.parse(storage.data.get(SETTINGS_KEY)!)).toMatchObject({
      trails: false,
      hudScale: 1.2,
    });
    expect(createSettingsStore(storage).getState().settings).toMatchObject({
      trails: false,
      hudScale: 1.2,
      labels: true,
    });
  });

  it('keeps the HUD scale between 0.8 and 1.4 and ignores what it cannot read', () => {
    const s = createSettingsStore(memory());
    s.getState().set({ hudScale: 3 });
    expect(s.getState().settings.hudScale).toBe(1.4);
    s.getState().set({ hudScale: 0.1 });
    expect(s.getState().settings.hudScale).toBe(0.8);
    const broken = createSettingsStore(
      memory({ [SETTINGS_KEY]: '{"labels":"yes","hudScale":"big"' })
    );
    expect(broken.getState().settings).toEqual(DEFAULT_SETTINGS);
    const odd = createSettingsStore(
      memory({ [SETTINGS_KEY]: '{"labels":false,"hudScale":"big"}' })
    );
    expect(odd.getState().settings).toEqual({
      ...DEFAULT_SETTINGS,
      labels: false,
    });
  });

  it('works without storage', () => {
    const s = createSettingsStore(null);
    s.getState().set({ labels: false });
    expect(s.getState().settings.labels).toBe(false);
  });
});
