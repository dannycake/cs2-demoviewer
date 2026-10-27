import { BUDGET, BUDGET_OVERRIDES, FIRST_LOAD_BEFORE_M2A, FIRST_LOAD_EXTRA, FULL_LIGHTING_EXTRA, OVERRIDABLE, budgetFor, kb } from '../lib/budgets.mjs';
import { MAPS } from '../lib/maps.mjs';
import { RADAR_SIZE } from '../lib/overview.mjs';

// BUDGET's values are the plan's Mirage acceptance, tuning that check-map.mjs applies (its rows
// are tested in check-map.test.mjs); these hold what must stay true whatever they are.
test('BUDGET is frozen, Mirage\'s first-load cap, and the radar the overview places points on', () => {
  expect(Object.isFrozen(BUDGET)).toBe(true);
  expect(BUDGET.firstLoadBytes).toBe(FIRST_LOAD_BEFORE_M2A.de_mirage + FIRST_LOAD_EXTRA);
  expect(BUDGET.radarSize).toEqual([RADAR_SIZE, RADAR_SIZE]);
  expect(BUDGET.worldTris[0]).toBeLessThan(BUDGET.worldTris[1]);
});
test('Mirage has no override: its acceptance is always the plain budget', () => {
  expect(Object.hasOwn(BUDGET_OVERRIDES, 'de_mirage')).toBe(false);
  expect(budgetFor('de_mirage', true)).toEqual({ ...BUDGET, overridden: [] });
});
test('without --budget-override every map gets the plain budget', () => {
  for (const map of MAPS) expect(budgetFor(map, false)).toEqual({ ...BUDGET, overridden: [] });
  expect(budgetFor('de_cbble', true)).toEqual({ ...BUDGET, overridden: [] });
  expect(budgetFor('constructor', true)).toEqual({ ...BUDGET, overridden: [] });
});
test('with --budget-override a map\'s entry replaces only the keys it names', () => {
  const [map, entry] = Object.entries(BUDGET_OVERRIDES)[0];
  const b = budgetFor(map, true);
  expect(b.overridden).toEqual(Object.keys(entry));
  for (const k of Object.keys(BUDGET)) expect(b[k]).toEqual(Object.hasOwn(entry, k) ? entry[k] : BUDGET[k]);
});
test('overrides name built maps, only overridable keys, and only ever relax a budget', () => {
  // The radar is the game's size, and entities.glb is held to the same 500 KB on every map.
  expect(OVERRIDABLE.every((k) => Object.hasOwn(BUDGET, k))).toBe(true);
  expect(OVERRIDABLE).not.toContain('radarSize');
  expect(OVERRIDABLE).not.toContain('entitiesBytes');
  for (const [map, entry] of Object.entries(BUDGET_OVERRIDES)) {
    expect(MAPS).toContain(map);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.keys(entry).length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(entry)) {
      expect(OVERRIDABLE).toContain(k);
      if (k === 'worldTris') {
        expect(v[0]).toBe(BUDGET.worldTris[0]);
        expect(v[1]).toBeGreaterThan(BUDGET.worldTris[1]);
      } else {
        expect(v).toBeGreaterThan(BUDGET[k]);
      }
    }
  }
});
test('a map\'s first load may grow by 2.5 MB over what it was before M2a (the user\'s cap), Mirage included', () => {
  expect(FIRST_LOAD_EXTRA).toBe(2.5e6);
  expect(Object.keys(FIRST_LOAD_BEFORE_M2A).sort()).toEqual([...MAPS].sort());
  expect(Object.values(FIRST_LOAD_BEFORE_M2A).every((n) => Number.isInteger(n) && n > 0)).toBe(true);
  expect(budgetFor('de_nuke', true).lightmapBytes).toBe(BUDGET.lightmapBytes);
  for (const map of MAPS) {
    const extra = Object.hasOwn(FULL_LIGHTING_EXTRA, map) ? FULL_LIGHTING_EXTRA[map] : FIRST_LOAD_EXTRA;
    expect(budgetFor(map, true).firstLoadBytes).toBe(FIRST_LOAD_BEFORE_M2A[map] + extra);
  }
});
test('Dust2, Anubis, Overpass and Inferno may grow by 5.0 MB, so they ship the lightmap (the user\'s choice, 2026-10-25)', () => {
  expect(Object.keys(FULL_LIGHTING_EXTRA).sort()).toEqual(['de_anubis', 'de_dust2', 'de_inferno', 'de_overpass']);
  expect(Object.isFrozen(FULL_LIGHTING_EXTRA)).toBe(true);
  for (const map of Object.keys(FULL_LIGHTING_EXTRA)) {
    expect(FULL_LIGHTING_EXTRA[map]).toBe(5e6);
    expect(budgetFor(map, true).firstLoadBytes).toBe(FIRST_LOAD_BEFORE_M2A[map] + 5e6);
  }
  // Inferno's H2 build was 33,992,103 B: under its new cap, over its old one.
  expect(budgetFor('de_inferno', true).firstLoadBytes).toBeGreaterThanOrEqual(33_992_103);
  expect(FIRST_LOAD_BEFORE_M2A.de_inferno + FIRST_LOAD_EXTRA).toBeLessThan(33_992_103);
});

test('the light grid is held to 0.4 MB, but for Vertigo, whose grid spans its 392 m tower', () => {
  expect(BUDGET.gridBytes).toBe(400_000);
  for (const map of MAPS) expect(budgetFor(map, true).gridBytes).toBe(map === 'de_vertigo' ? 450_000 : 400_000);
  expect(budgetFor('de_vertigo', false).gridBytes).toBe(400_000);
});

test('kb writes decimal bytes as whole kilobytes, as the map tools print sizes and budgets', () => {
  expect(kb(BUDGET.entitiesBytes)).toBe('500 KB');
  expect(kb(19_349)).toBe('19 KB');
  expect(kb(1_500)).toBe('2 KB');
  expect(kb(499)).toBe('0 KB');
});
