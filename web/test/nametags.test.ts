// Name tags over heads (Task 4): a name, a dark bar and a team-colour fill for every living
// player of the round, kept a constant size on screen. The look is checked in the browser.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { UNIT, eyePoint } from '../src/geo/coords';
import { FLAG, type MatchHeader } from '../src/pack/types';
import { LabelSprites, type LabelCanvas } from '../src/scene/labels';
import {
  NAME_LABEL_SIZE,
  NameTags,
  TAG,
  tagPoint,
  type TagOptions,
} from '../src/scene/nametags';
import { TEAM_HEX } from '../src/scene/colors';
import { newPlayerState, type PlayerState } from '../src/sim/sample';

const ROUND = 2;

/** Canvases that record the text drawn on them, as in labels.test.ts. */
function canvases() {
  const drawn: string[][] = [];
  const make = (width: number, height: number): LabelCanvas => {
    const texts: string[] = [];
    drawn.push(texts);
    const g = {
      clearRect() {},
      fillText(t: string) {
        texts.push(t);
      },
      strokeText() {},
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      textAlign: '',
      textBaseline: '',
      lineJoin: '',
    };
    return { width, height, getContext: () => g };
  };
  return { drawn, make };
}

/**
 * Milo (T) plays the round, eclipse (CT) plays it and has died, ghost is on no team in it, and
 * drifter (CT) is on a team but absent from it.
 */
function header(): MatchHeader {
  const player = (name: string, team: number) => ({
    steamid: '7656119',
    name,
    team_by_round: [team, team, team, team],
    crosshair: null,
  });
  return {
    players: [
      player('Milo', 2),
      player('eclipse', 3),
      player('ghost', 0),
      player('drifter', 3),
    ],
  } as unknown as MatchHeader;
}

function states(): PlayerState[] {
  const milo = {
    ...newPlayerState(),
    x: 1200,
    y: -300,
    z: 40,
    duck: 0,
    health: 47,
    flags: FLAG.alive,
    present: true,
  };
  // The tick of eclipse's death: a sample, at no health.
  const eclipse = {
    ...newPlayerState(),
    x: 900,
    y: 100,
    z: 0,
    health: 0,
    present: true,
  };
  // Present and healthy, but on no team this round.
  const ghost = {
    ...newPlayerState(),
    x: 0,
    y: 0,
    z: 0,
    health: 100,
    flags: FLAG.alive,
    present: true,
  };
  // On a team for the round but with no live sample (disconnected mid-round): a stale position
  // and health.
  const drifter = {
    ...newPlayerState(),
    x: 600,
    y: 200,
    z: 0,
    health: 100,
    flags: FLAG.alive,
    present: false,
  };
  return [milo, eclipse, ghost, drifter];
}

function options(patch: Partial<TagOptions> = {}): TagOptions {
  return {
    on: true,
    throughWalls: true,
    shown: null,
    hideShown: false,
    eye: new THREE.Vector3(-4, 3, 20),
    worldPerPixel: (2 * Math.tan((70 * Math.PI) / 360)) / 1440,
    ...patch,
  };
}

function sprite(tag: THREE.Object3D, name: string): THREE.Sprite {
  const s = tag.getObjectByName(name);
  expect(s).toBeInstanceOf(THREE.Sprite);
  return s as THREE.Sprite;
}

const shownTags = (t: NameTags) =>
  t.root.visible ? t.root.children.filter((c) => c.visible) : [];

describe('tagPoint', () => {
  it('is the eye point raised by aboveEyeUnits', () => {
    expect(TAG).toEqual({
      aboveEyeUnits: 14,
      namePx: 16,
      bar: { wPx: 44, hPx: 4, gapPx: 2 },
    });
    expect(Object.isFrozen(TAG)).toBe(true);
    for (const duck of [0, 128, 255]) {
      const s = { x: 120, y: -40, z: 16, duck };
      const eye = eyePoint(s, new THREE.Vector3());
      const p = tagPoint(s, new THREE.Vector3());
      expect(p.x).toBeCloseTo(eye.x, 9);
      expect(p.z).toBeCloseTo(eye.z, 9);
      expect(p.y - eye.y).toBeCloseTo(14 * UNIT, 9);
    }
  });
});

describe('NameTags', () => {
  it('tags only the living players of the round, at the point over their eyes, with health as the fill', () => {
    const c = canvases();
    const tags = new NameTags(new LabelSprites(c.make, 16, NAME_LABEL_SIZE));
    const s = states();
    const o = options();
    tags.update(s, header(), ROUND, o);
    const shown = shownTags(tags);
    expect(shown).toHaveLength(1);
    // Drifter, on a team but absent, keeps no tag despite a stale position and health.
    expect(tags.root.children[3].visible).toBe(false);
    const tag = shown[0];
    const at = tagPoint(s[0], new THREE.Vector3());
    expect(tag.position.distanceTo(at)).toBeLessThan(1e-9);
    const d = at.distanceTo(o.eye);
    const full = TAG.bar.wPx * o.worldPerPixel * d;
    const bar = sprite(tag, 'tag-bar');
    const fill = sprite(tag, 'tag-fill');
    expect(bar.scale.x).toBeCloseTo(full, 9);
    expect(fill.scale.x / full).toBeCloseTo(0.47, 9);
    // The same point, and on screen the same left end: center.x counts in each one's width.
    expect(fill.position.equals(bar.position)).toBe(true);
    expect(fill.center.x * fill.scale.x).toBeCloseTo(
      bar.center.x * bar.scale.x,
      9
    );
    expect(fill.scale.y).toBeCloseTo(TAG.bar.hPx * o.worldPerPixel * d, 9);
    expect(fill.material.color.getHex()).toBe(TEAM_HEX[2]);
    // Only Milo's name was ever drawn.
    expect(c.drawn).toEqual([['Milo']]);
  });

  it('keeps the name a constant size on screen', () => {
    const tags = new NameTags(
      new LabelSprites(canvases().make, 16, NAME_LABEL_SIZE)
    );
    const s = states();
    for (const eye of [
      new THREE.Vector3(-4, 3, 20),
      new THREE.Vector3(60, 10, -40),
    ]) {
      const o = options({ eye });
      tags.update(s, header(), ROUND, o);
      const name = sprite(shownTags(tags)[0], 'tag-name');
      const d = tagPoint(s[0], new THREE.Vector3()).distanceTo(eye);
      const want = TAG.namePx * o.worldPerPixel * d;
      expect(Math.abs(name.scale.y - want) / want).toBeLessThan(0.01);
    }
  });

  it('hides the shown player when told to, and every tag when off', () => {
    const tags = new NameTags(
      new LabelSprites(canvases().make, 16, NAME_LABEL_SIZE)
    );
    const s = states();
    tags.update(s, header(), ROUND, options({ shown: 0, hideShown: true }));
    expect(shownTags(tags)).toHaveLength(0);
    // In Free, the followed player keeps their tag.
    tags.update(s, header(), ROUND, options({ shown: 0, hideShown: false }));
    expect(shownTags(tags)).toHaveLength(1);
    tags.update(s, header(), ROUND, options({ shown: 1, hideShown: true }));
    expect(shownTags(tags)).toHaveLength(1);
    tags.update(s, header(), ROUND, options({ on: false }));
    expect(shownTags(tags)).toHaveLength(0);
    tags.update(s, header(), ROUND, options());
    expect(shownTags(tags)).toHaveLength(1);
  });

  it('draws through walls only when throughWalls is on', () => {
    const tags = new NameTags(
      new LabelSprites(canvases().make, 16, NAME_LABEL_SIZE)
    );
    const s = states();
    const materials = () => {
      const all: THREE.SpriteMaterial[] = [];
      tags.root.traverse((o) => {
        if (o instanceof THREE.Sprite) all.push(o.material);
      });
      return all;
    };
    tags.update(s, header(), ROUND, options({ throughWalls: true }));
    expect(materials().length).toBeGreaterThanOrEqual(9);
    for (const m of materials()) expect(m.depthTest).toBe(false);
    tags.update(s, header(), ROUND, options({ throughWalls: false }));
    for (const m of materials()) expect(m.depthTest).toBe(true);
    tags.update(s, header(), ROUND, options({ throughWalls: true }));
    for (const m of materials()) expect(m.depthTest).toBe(false);
  });

  it('tags no dying body: a death keeps its last live sample, present with its health, but not alive', () => {
    const c = canvases();
    const tags = new NameTags(new LabelSprites(c.make, 16, NAME_LABEL_SIZE));
    const s = states();
    // As FrameSolver.body() leaves a player for the seconds their body falls.
    s[0] = { ...s[0], health: 47, present: true, flags: 0 };
    tags.update(s, header(), ROUND, options());
    expect(shownTags(tags)).toHaveLength(0);
    expect(c.drawn).toEqual([]);
  });

  it('draws in no fog: a tag in a smoke keeps its colours', () => {
    const tags = new NameTags(
      new LabelSprites(canvases().make, 16, NAME_LABEL_SIZE)
    );
    tags.update(states(), header(), ROUND, options());
    const all: THREE.SpriteMaterial[] = [];
    tags.root.traverse((o) => {
      if (o instanceof THREE.Sprite) all.push(o.material);
    });
    // The name, the bar and the fill of the shown tag, and the hidden tags' placeholders.
    expect(all.length).toBeGreaterThanOrEqual(9);
    for (const m of all) expect(m.fog).toBe(false);
  });

  it('keeps every name of more than 16 players: a second update reuses each material', () => {
    const c = canvases();
    const tags = new NameTags(new LabelSprites(c.make, 16, NAME_LABEL_SIZE));
    const n = 20;
    const many = {
      players: Array.from({ length: n }, (_, i) => ({
        steamid: '7656119',
        name: `player${i}`,
        team_by_round: [2 + (i % 2), 2 + (i % 2), 2 + (i % 2), 2 + (i % 2)],
        crosshair: null,
      })),
    } as unknown as MatchHeader;
    const s = Array.from({ length: n }, (_, i) => ({
      ...newPlayerState(),
      x: 100 * i,
      y: 0,
      z: 0,
      health: 100,
      flags: FLAG.alive,
      present: true,
    }));
    const names = () =>
      tags.root.children.map((t) => sprite(t, 'tag-name').material);
    tags.update(s, many, ROUND, options());
    expect(shownTags(tags)).toHaveLength(n);
    const first = names();
    let freed = 0;
    for (const m of first) m.addEventListener('dispose', () => freed++);
    tags.update(s, many, ROUND, options());
    const second = names();
    for (let i = 0; i < n; i++) expect(second[i]).toBe(first[i]);
    expect(c.drawn).toHaveLength(n);
    expect(freed).toBe(0);
  });

  it('reuses the name material while the names stay the same, and frees it on dispose', () => {
    const c = canvases();
    const tags = new NameTags(new LabelSprites(c.make, 16, NAME_LABEL_SIZE));
    const s = states();
    tags.update(s, header(), ROUND, options());
    const first = sprite(shownTags(tags)[0], 'tag-name').material;
    s[0].health = 12;
    tags.update(s, header(), ROUND, options());
    expect(sprite(shownTags(tags)[0], 'tag-name').material).toBe(first);
    expect(c.drawn).toHaveLength(1);
    let freed = 0;
    first.addEventListener('dispose', () => freed++);
    const parent = new THREE.Group();
    parent.add(tags.root);
    tags.dispose();
    expect(freed).toBe(1);
    expect(tags.root.parent).toBeNull();
  });
});
