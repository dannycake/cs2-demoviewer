import { describe, expect, it } from 'vitest';
import { mapName } from '../src/components/hud/models';
import { mapNotice, noRoundsNotice } from '../src/views/notices';

describe('mapName', () => {
  it('names the Active Duty maps and older ones as players call them', () => {
    expect(mapName('de_dust2')).toBe('Dust II');
    expect(mapName('de_mirage')).toBe('Mirage');
    expect(mapName('de_cache')).toBe('Cache');
    expect(mapName('de_cbble')).toBe('Cobblestone');
    expect(mapName('cs_office')).toBe('Office');
    expect(mapName('de_some_workshop_map')).toBe('Some workshop map');
  });
});

describe('mapNotice', () => {
  it('says the map is not supported, which maps are, and what still works', () => {
    const n = mapNotice('de_cbble');
    expect(n.title).toBe('Cobblestone is not supported yet');
    expect(n.text).toContain(
      'Ancient, Anubis, Cache, Dust II, Inferno, Mirage, Nuke, Overpass, Train and Vertigo'
    );
    expect(n.text).toMatch(/scoreboard, the kill feed and the rounds/);
  });
});

describe('noRoundsNotice', () => {
  it('explains a demo without a single round', () => {
    const n = noRoundsNotice();
    expect(n.title).toBe('This demo has no rounds');
    expect(n.text).toMatch(/warmup/);
  });
});
