// Names and health over heads, as CS2's spectator view draws them: every living player of the
// round gets their name over a dark bar, filled from its left end in their team's colour as far
// as their health goes. A tag keeps one size on screen, as the grenade labels do
// (`utility.ts`), draws after everything else, and shows through walls with the outlines
// (`xray`); the player whose eyes POV looks through has none. The three sprites of a tag share
// one point, and screen-space offsets (their `center`) lay them out, so the layout holds from
// any camera. Every object is made once per player and shown or hidden, and a name's material
// is drawn once and kept (the label cache holds a name for every player), so playing,
// scrubbing and seeking make no sprites, materials or textures. A body (a death's last live
// sample, not alive) has no tag, and no tag takes the fog: inside a smoke it would draw in the
// smoke's colour. Given the camera, the tags keep apart and on screen: a name that would run
// off the side of the view moves in to its edge (its bar stays over the player), and a tag whose
// name would print over a nearer one's fades to a ghost of a name without its bar.

import * as THREE from 'three';
import { UNIT, eyePoint } from '../geo/coords';
import { FLAG, type MatchHeader } from '../pack/types';
import type { PlayerState } from '../sim/sample';
import { LabelSprites, NAME_EM, shortName } from './labels';
import { TEAM_HEX } from './colors';
import type { Team } from './PlayerRig';

export const TAG = Object.freeze({
  /** How far over the eye the tag's foot is, in Source units. */
  aboveEyeUnits: 14,
  /** The name sprite's height on screen, in CSS pixels. */
  namePx: 16,
  /** The health bar on screen, in CSS pixels: its size, and the gap up to the name. */
  bar: { wPx: 44, hPx: 4, gapPx: 2 },
});

/**
 * The canvas of a name, in pixels: wide enough for `shortName`'s 16 characters at full size,
 * so a name `namePx` tall on screen is set in type `NAME_EM` of that.
 */
export const NAME_LABEL_SIZE = Object.freeze({ width: 512, height: 64 });

/** After the grenade labels (10) and damage numbers (11): bar, then fill, then name. */
const ORDER = 20;
const NAME_COLOR = '#ffffff';
/**
 * The name's `center.y`, which puts the bottom of its type `hPx + gapPx` over the tag's foot:
 * a `name` label's line is across the middle of its canvas, `NAME_EM` of its height.
 */
const NAME_CENTER_Y =
  0.5 - NAME_EM / 2 - (TAG.bar.hPx + TAG.bar.gapPx) / TAG.namePx;

/** The point a tag hangs from, in scene metres: the eye point raised by `aboveEyeUnits`. */
export function tagPoint(
  s: { x: number; y: number; z: number; duck: number },
  out: THREE.Vector3
): THREE.Vector3 {
  eyePoint(s, out);
  out.y += TAG.aboveEyeUnits * UNIT;
  return out;
}

export interface TagOptions {
  /** The `nameTags` setting: off, no tag shows. */
  on: boolean;
  /** The `xray` setting: tags draw over the walls instead of behind them. */
  throughWalls: boolean;
  /** The player on screen, or null. */
  shown: number | null;
  /** Leaves `shown` without a tag (POV). */
  hideShown: boolean;
  /** The camera's position, for the constant size. */
  eye: THREE.Vector3;
  /** Metres per screen pixel at one metre from the camera: 2·tan(fov/2) / screen height. */
  worldPerPixel: number;
  /** The camera the tags are drawn for, and the view's size in CSS pixels: they keep apart. */
  camera?: THREE.Camera | null;
  width?: number;
  height?: number;
}

/** A name that would print over a nearer one's is drawn this faint. */
export const FADED_NAME = 0.25;
/** The gap a name keeps from the view's edge, in CSS pixels. */
const EDGE_PX = 4;

/** Where a tag's name is on screen, for keeping tags apart. */
interface Placed {
  tag: number;
  distance: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const _ndc = new THREE.Vector3();

interface Tag {
  group: THREE.Group;
  name: THREE.Sprite;
  bar: THREE.Sprite;
  fill: THREE.Sprite;
}

export class NameTags {
  readonly root = new THREE.Group();
  /** The names, apart from the grenade labels' cache, so neither evicts the other. */
  private readonly labels: LabelSprites;
  private readonly tags: Tag[] = [];
  /** The tags shown at the last update, nearest first: made once, reused every frame. */
  private readonly placed: Placed[] = [];
  /** What a hidden tag's name shows, so it never holds a name the cache may free. */
  private readonly placeholder = new THREE.SpriteMaterial({
    visible: false,
    fog: false,
  });
  private readonly bar = new THREE.SpriteMaterial({
    color: 0x000000,
    opacity: 0.6,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  private readonly fills: Record<Team, THREE.SpriteMaterial> = {
    2: fillMaterial(2),
    3: fillMaterial(3),
  };
  /** The materials every tag shares, whose depth test follows `throughWalls`. */
  private readonly shared = [
    this.placeholder,
    this.bar,
    this.fills[2],
    this.fills[3],
  ];

  /**
   * `labels` (freed on dispose) draws the names in its `name` style: by default on canvases of
   * `NAME_LABEL_SIZE`, holding 16 names, or one per player when there are more.
   */
  constructor(
    labels: LabelSprites = new LabelSprites(undefined, 16, NAME_LABEL_SIZE)
  ) {
    this.labels = labels;
    this.root.name = 'name-tags';
  }

  /** Poses the tag of every player of `header` from `states` in round `round`. */
  update(
    states: readonly PlayerState[],
    header: MatchHeader,
    round: number,
    o: TagOptions
  ): void {
    const players = header.players;
    while (this.tags.length < players.length) this.tags.push(this.make());
    // Fewer names than tags would free a name in use at every frame.
    this.labels.reserve(players.length);
    const depthTest = !o.throughWalls;
    for (const m of this.shared) m.depthTest = depthTest;
    let shown = 0;
    for (let i = 0; i < this.tags.length; i++) {
      const tag = this.tags[i];
      const s = states[i];
      const team = players[i]?.team_by_round[round];
      if (
        !o.on ||
        !s?.present ||
        (s.flags & FLAG.alive) === 0 ||
        s.health <= 0 ||
        (team !== 2 && team !== 3) ||
        (o.hideShown && o.shown === i)
      ) {
        tag.group.visible = false;
        tag.name.material = this.placeholder;
        continue;
      }
      tag.group.visible = true;
      tagPoint(s, tag.group.position);
      const px = o.worldPerPixel * tag.group.position.distanceTo(o.eye);
      const name = this.labels.material(
        shortName(players[i].name),
        '',
        NAME_COLOR,
        'name'
      );
      name.depthTest = depthTest;
      name.toneMapped = false;
      name.fog = false;
      tag.name.material = name;
      const h = TAG.namePx * px;
      tag.name.scale.set(h * this.labels.aspect, h, 1);
      tag.bar.scale.set(TAG.bar.wPx * px, TAG.bar.hPx * px, 1);
      // The fill grows from the bar's left end. `center.x` counts in the fill's own widths, so
      // half the bar is 0.5 / health of them; at 0 the fill would start at the bar's middle,
      // and moving it half a bar left in the world takes the camera's right.
      const health = Math.min(1, s.health / 100);
      tag.fill.material = this.fills[team];
      tag.fill.scale.set(TAG.bar.wPx * px * health, TAG.bar.hPx * px, 1);
      tag.fill.center.set(0.5 / health, 0);
      tag.name.center.x = 0.5;
      tag.bar.visible = tag.fill.visible = true;
      name.opacity = 1;
      if (this.placed.length <= shown)
        this.placed.push({
          tag: 0,
          distance: 0,
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
        });
      const p = this.placed[shown++];
      p.tag = i;
      p.distance = tag.group.position.distanceTo(o.eye);
    }
    if (o.camera && o.width && o.height) this.keepApart(shown, o);
  }

  /**
   * Keeps the `shown` tags of the last update on screen and apart, as `o.camera` draws them in
   * a view `o.width` × `o.height`: a name moves in from the edge, and the farther of two names
   * that would print over each other fades, its bar hidden.
   */
  private keepApart(shown: number, o: TagOptions): void {
    const camera = o.camera!;
    const w = o.width!;
    const h = o.height!;
    camera.updateMatrixWorld();
    const nameW = TAG.namePx * this.labels.aspect;
    const above = TAG.bar.hPx + TAG.bar.gapPx + TAG.namePx * NAME_EM;
    const list = this.placed;
    for (let k = 0; k < shown; k++) {
      const p = list[k];
      const tag = this.tags[p.tag];
      _ndc.copy(tag.group.position).project(camera);
      const x = ((_ndc.x + 1) / 2) * w;
      const y = ((1 - _ndc.y) / 2) * h;
      const material = tag.name.material as THREE.SpriteMaterial;
      const textW = nameW * ((material.userData.textWidth as number) ?? 1);
      let shift = 0;
      // In front of the camera and across the view: its name stays whole on screen.
      if (_ndc.z < 1 && x >= 0 && x <= w) {
        if (x - textW / 2 < EDGE_PX) shift = EDGE_PX - (x - textW / 2);
        else if (x + textW / 2 > w - EDGE_PX)
          shift = w - EDGE_PX - (x + textW / 2);
      }
      tag.name.center.x = 0.5 - shift / nameW;
      p.left = x + shift - textW / 2;
      p.right = x + shift + textW / 2;
      p.top = y - above;
      p.bottom = y;
      // Behind the camera, nothing to keep apart from.
      if (_ndc.z >= 1) p.distance = Infinity;
    }
    // Nearest first (sorted in place: a handful, every frame): a name keeps its place against
    // those farther than it.
    for (let k = 1; k < shown; k++) {
      const p = list[k];
      let j = k - 1;
      for (; j >= 0 && list[j].distance > p.distance; j--)
        list[j + 1] = list[j];
      list[j + 1] = p;
    }
    for (let k = 0; k < shown; k++) {
      const p = list[k];
      const tag = this.tags[p.tag];
      let over = false;
      for (let j = 0; j < k && !over; j++) {
        const q = list[j];
        if (q.distance === Infinity || this.tags[q.tag].bar.visible === false)
          continue;
        over =
          p.left < q.right &&
          q.left < p.right &&
          p.top < q.bottom &&
          q.top < p.bottom;
      }
      if (!over) continue;
      (tag.name.material as THREE.SpriteMaterial).opacity = FADED_NAME;
      tag.bar.visible = tag.fill.visible = false;
    }
  }

  dispose(): void {
    this.labels.dispose();
    this.placeholder.dispose();
    this.bar.dispose();
    this.fills[2].dispose();
    this.fills[3].dispose();
    this.root.removeFromParent();
  }

  private make(): Tag {
    const group = new THREE.Group();
    group.name = 'tag';
    group.visible = false;
    const sprite = (name: string, m: THREE.SpriteMaterial, order: number) => {
      const s = new THREE.Sprite(m);
      s.name = name;
      s.renderOrder = order;
      group.add(s);
      return s;
    };
    const bar = sprite('tag-bar', this.bar, ORDER);
    bar.center.set(0.5, 0);
    const fill = sprite('tag-fill', this.fills[2], ORDER + 1);
    const name = sprite('tag-name', this.placeholder, ORDER + 2);
    name.center.set(0.5, NAME_CENTER_Y);
    this.root.add(group);
    return { group, name, bar, fill };
  }
}

function fillMaterial(team: Team): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({
    color: TEAM_HEX[team],
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
}
