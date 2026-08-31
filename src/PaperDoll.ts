import { Assets, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';

const getTexture = (alias: string): Texture => Assets.get(alias) as Texture;

export interface DollActor {
  x: number; y: number; facing: number; moving: boolean; dead: boolean;
  attackVariant: number; attackingFor: number; attackLoop: boolean;
  hurtFor: number; jumpFor: number; reloadFor: number; shake: number;
  hp: number; maxHp: number;
}

export interface RigLayer {
  name: string;
  kind: 'base' | 'cos' | 'weapon';
  part?: string;
  slot?: string;
}
export interface WeaponDef {
  name: string;
  subType: string;
  attackType: number;
}
export interface RigManifest {
  frameW: number;
  frameH: number;
  pivotX: number;
  pivotY: number;
  charH: number;
  states: Record<string, number>;
  order: RigLayer[];
  genders: string[];
  costumes: string[];
  weapons: WeaponDef[];
  defaultGender: string;
  defaultCostume: string;
  defaultWeapon: string;
  thumbs: Record<string, string>;
  weaponThumbs: Record<string, string>;
  atlasPages: { alias: string; src: string }[];
  /** 프레임명("<alias>#<i>") → [page, x, y, w, h, ox, oy] (아틀라스 rect + 트림 오프셋). */
  frames: Record<string, [number, number, number, number, number, number, number]>;
}

type DollState =
  | 'idle' | 'move' | 'attack1' | 'attack2' | 'attack3' | 'attack4'
  | 'damage' | 'death' | 'jump' | 'reload';
const STATE_DUR: Record<DollState, number> = {
  idle: 90, move: 90, attack1: 60, attack2: 60, attack3: 60, attack4: 60,
  damage: 70, death: 90, jump: 90, reload: 70,
};
const LOOPING = new Set<DollState>(['idle', 'move']); // 그 외는 원샷(마지막 프레임 유지)

/** 하체 레이어(다리 + 하의/신발 장비) — 상체 액션 중에도 이동 시 걷기 유지 대상. */
function isLowerLayer(l: RigLayer): boolean {
  if (l.kind === 'base') return l.name === 'leg';
  if (l.kind === 'cos') {
    const slot = LAYER_SLOT[l.name];
    return slot === 'bottom' || slot === 'shoes';
  }
  return false;
}

/** 코스튬 레이어 → 장비 슬롯 (슬롯별 독립 교체). top=상의(shirt/sleeve/face), bottom=하의, hat=모자(hat/hair), shoes=신발. */
const LAYER_SLOT: Record<string, 'top' | 'bottom' | 'hat' | 'shoes'> = {
  shirt: 'top', sleeve: 'top', face: 'top',
  bottom: 'bottom', shoes: 'shoes', hair: 'hat', hat: 'hat',
};
export type EquipSlot = 'top' | 'bottom' | 'hat' | 'shoes';
export const EQUIP_SLOTS: EquipSlot[] = ['top', 'bottom', 'hat', 'shoes'];

let loadedRig: RigManifest | null = null;
export function setRig(r: RigManifest): void {
  loadedRig = r;
}
export function getRig(): RigManifest {
  if (!loadedRig) throw new Error('player rig가 아직 로드되지 않음 (LoadScene 먼저)');
  return loadedRig;
}

/** 멀티파츠 페이퍼돌 — 레이어 z순서로 쌓고 모든 레이어가 같은 상태/프레임으로 동기 재생.
 *  성별/코스튬/무기 라이브 교체. ActorView와 같은 인터페이스(drop-in). */
export class PaperDollView {
  readonly view = new Container();
  private readonly hpBg = new Graphics();
  private readonly hpFg = new Graphics();
  private readonly barWidth = 46;
  private readonly displayHeight: number;
  private readonly baseScale: number;
  private readonly baseFacing = -1; // 원본 왼쪽향 → facing=1에서 뒤집어 오른쪽향 (공격 팔 방향으로 검증)
  private readonly layers: { layer: RigLayer; sprite: Sprite; frames: Record<string, Texture[]> }[] = [];
  private gender: string;
  private equip: Record<EquipSlot, string>; // 슬롯별 코스튬 세트
  private weapon: string;

  private cur: DollState = 'idle';
  private frame = 0;
  private timer = 0;
  private lastRatio = -1; // HP바 마지막 비율 — 변동 시에만 재드로우
  private hpBgDrawn = false;
  // 하체(다리/하의/신발) 분리 상태 — 원작: leg 파츠엔 shooting_position 클립이 없어
  // 상체가 공격/조준 자세여도 다리는 walk/idle을 계속 돈다 (이동 사격).
  private curLower: DollState = 'idle';
  private lowerFrame = 0;
  private lowerTimer = 0;
  private lastAtkFor = 0; // 공격 재발동 감지(스윙 재시작)용
  private lastHurtFor = 0; // 피격 재발동 감지(플래시)용
  private flash = 0; // 피격 플래시 남은 시간(ms)

  constructor(
    private readonly rig: RigManifest,
    charHeight = 150,
    gender = rig.defaultGender,
    equip: Partial<Record<EquipSlot, string>> = {},
    weapon = rig.defaultWeapon,
  ) {
    this.displayHeight = charHeight;
    this.baseScale = charHeight / rig.charH;
    this.gender = gender;
    const dc = rig.defaultCostume;
    this.equip = { top: equip.top ?? dc, bottom: equip.bottom ?? dc, hat: equip.hat ?? dc, shoes: equip.shoes ?? dc };
    this.weapon = weapon;
    const anchorY = 1 - rig.pivotY;

    // 발밑 그림자 (원작 image/shadow.png). 하니스 등 미로드 환경은 생략.
    try {
      const sh = new Sprite(getTexture('shadow'));
      sh.anchor.set(0.5, 0.5);
      sh.width = charHeight * 0.5;
      sh.height = charHeight * 0.11;
      sh.alpha = 0.5;
      this.view.addChild(sh);
    } catch { /* shadow 텍스처 없음 — 생략 */ }

    for (const layer of rig.order) {
      const frames = this.buildFrames(layer);
      const sprite = new Sprite(frames['idle']?.[0]);
      sprite.anchor.set(rig.pivotX, anchorY);
      sprite.scale.set(this.baseScale);
      this.view.addChild(sprite);
      this.layers.push({ layer, sprite, frames });
    }
    this.view.addChild(this.hpBg, this.hpFg);
  }

  private aliasFor(layer: RigLayer, state: string): string | null {
    if (layer.kind === 'base') return `pd_${this.gender}_base_${layer.name}_${state}`;
    if (layer.kind === 'cos') {
      const slot = LAYER_SLOT[layer.name] ?? 'top'; // 레이어의 장비 슬롯 → 해당 코스튬
      return `pd_${this.gender}_cos_${this.equip[slot]}_${layer.slot}_${state}`;
    }
    if (layer.kind === 'weapon') return this.weapon ? `pd_weapon_${this.weapon}_${state}` : null;
    return null;
  }

  private buildFrames(layer: RigLayer): Record<string, Texture[]> {
    const frames: Record<string, Texture[]> = {};
    const FW = this.rig.frameW, FH = this.rig.frameH;
    for (const [state, count] of Object.entries(this.rig.states)) {
      const base = this.aliasFor(layer, state);
      const arr: Texture[] = [];
      if (base) {
        for (let i = 0; i < count; i++) {
          const e = this.rig.frames[`${base}#${i}`];
          if (!e) continue; // 빈 프레임 → 그 프레임 비표시
          const [page, x, y, w, h, ox, oy] = e;
          const src = getTexture(`pd_atlas_${page}`);
          if (!src) continue;
          arr[i] = new Texture({
            source: src.source,
            frame: new Rectangle(x, y, w, h),
            orig: new Rectangle(0, 0, FW, FH), // 앵커는 풀프레임 기준 (트림으로 정렬 유지)
            trim: new Rectangle(ox, oy, w, h),
          });
        }
      }
      frames[state] = arr;
    }
    return frames;
  }

  private rebuild(kinds: RigLayer['kind'][]): void {
    for (const l of this.layers) {
      if (!kinds.includes(l.layer.kind)) continue;
      l.frames = this.buildFrames(l.layer);
      const arr = l.frames[this.cur]?.length ? l.frames[this.cur] : l.frames['idle'];
      l.sprite.texture = arr?.[this.frame] ?? arr?.[0] ?? Texture.EMPTY;
    }
  }

  setGender(g: string): void {
    if (g === this.gender) return;
    this.gender = g;
    this.rebuild(['base', 'cos']); // 무기는 성별 무관
  }
  /** 슬롯별 코스튬 교체 (해당 슬롯 레이어만 갱신). */
  setSlot(slot: EquipSlot, costume: string): void {
    if (this.equip[slot] === costume) return;
    this.equip[slot] = costume;
    for (const l of this.layers) {
      if (l.layer.kind === 'cos' && LAYER_SLOT[l.layer.name] === slot) {
        l.frames = this.buildFrames(l.layer);
        const arr = l.frames[this.cur]?.length ? l.frames[this.cur] : l.frames['idle'];
        l.sprite.texture = arr?.[this.frame] ?? arr?.[0] ?? Texture.EMPTY;
      }
    }
  }
  /** 전 슬롯을 한 세트로 (코스튬 카드 프리셋). */
  setOutfit(costume: string): void {
    for (const s of EQUIP_SLOTS) this.setSlot(s, costume);
  }
  setWeapon(name: string): void {
    if (name === this.weapon) return;
    this.weapon = name;
    this.rebuild(['weapon']);
  }
  get currentGender(): string { return this.gender; }
  get currentEquip(): Record<EquipSlot, string> { return this.equip; }
  get currentWeapon(): string { return this.weapon; }

  sync(a: DollActor, dt: number): void {
    const atk = `attack${Math.min(4, Math.max(1, a.attackVariant))}` as DollState;
    // 공격이 피격보다 우선 — 둘러싸여 연타당해도 스윙이 끊기지 않게(비주얼 스턴락 방지).
    // 피격 피드백은 모션 대신 빨강 플래시+셰이크로 전달.
    const state: DollState = a.dead
      ? 'death'
      : a.jumpFor > 0 ? 'jump'
      : a.reloadFor > 0 ? 'reload'
      : a.attackingFor > 0 ? atk
      : a.hurtFor > 0 ? 'damage'
      : a.moving ? 'move' : 'idle';
    // 피격 플래시 (몬스터와 동일한 타격 피드백)
    if (a.hurtFor > this.lastHurtFor) this.flash = 120;
    this.lastHurtFor = a.hurtFor;
    this.flash = Math.max(0, this.flash - dt);
    const tint = this.flash > 0 ? 0xff8076 : 0xffffff;
    for (const { sprite } of this.layers) sprite.tint = tint;
    if (state !== this.cur) {
      this.cur = state;
      this.frame = 0;
      this.timer = 0;
    } else if (a.attackingFor > this.lastAtkFor && state === atk && !a.attackLoop) {
      // 같은 공격 상태에서 재발동(attackingFor가 다시 차오름) — 스윙을 처음부터 재생.
      // attackLoop(전기톱 등 채널)는 루프 유지라 재시작하지 않음.
      this.frame = 0;
      this.timer = 0;
    }
    this.lastAtkFor = a.attackingFor;
    const count = this.rig.states[state] ?? 1;
    const loop = LOOPING.has(state) || (a.attackLoop && state === atk); // 채널 스킬은 공격 모션 루프
    this.timer += dt;
    while (this.timer >= STATE_DUR[state]) {
      this.timer -= STATE_DUR[state];
      this.frame = loop ? (this.frame + 1) % count : Math.min(this.frame + 1, count - 1);
    }

    // 하체 상태 — 공격/장전(상체 액션) 중 이동하면 다리는 walk (원작 이동 사격 자세)
    const upperAction = state === atk || state === 'reload';
    const lowerState: DollState = upperAction && a.moving ? 'move' : state;
    if (lowerState !== this.curLower) {
      this.curLower = lowerState;
      this.lowerFrame = 0;
      this.lowerTimer = 0;
    }
    if (lowerState === state) {
      this.lowerFrame = this.frame; // 전신 동기 — 같은 카운터
      this.lowerTimer = this.timer;
    } else {
      const lc = this.rig.states[lowerState] ?? 1;
      const ll = LOOPING.has(lowerState);
      this.lowerTimer += dt;
      while (this.lowerTimer >= STATE_DUR[lowerState]) {
        this.lowerTimer -= STATE_DUR[lowerState];
        this.lowerFrame = ll ? (this.lowerFrame + 1) % lc : Math.min(this.lowerFrame + 1, lc - 1);
      }
    }

    const sx = this.baseScale * a.facing * this.baseFacing;
    for (const { layer, sprite, frames } of this.layers) {
      const lower = isLowerLayer(layer) && lowerState !== state;
      const st = lower ? lowerState : state;
      const fr = lower ? this.lowerFrame : this.frame;
      const arr = frames[st]?.length ? frames[st] : frames['idle'];
      const tex = arr?.[fr] ?? arr?.[0];
      sprite.visible = !!tex;
      if (tex) sprite.texture = tex;
      sprite.scale.x = sx;
      sprite.scale.y = this.baseScale;
    }

    const shakeX = a.shake > 0 ? (Math.random() - 0.5) * 6 : 0;
    this.view.position.set(a.x + shakeX, a.y);
    this.view.zIndex = Math.round(a.y);

    if (a.maxHp <= 5) {
      this.hpBg.visible = false;
      this.hpFg.visible = false;
      return;
    }
    const ratio = Math.max(0, Math.min(1, a.hp / a.maxHp));
    if (ratio === this.lastRatio) return; // HP 변동 없으면 재드로우 생략
    this.lastRatio = ratio;
    const top = -this.displayHeight - 10;
    const w = this.barWidth;
    this.hpBg.visible = true;
    this.hpFg.visible = true;
    if (!this.hpBgDrawn) { // 배경은 크기 고정 — 1회만
      this.hpBgDrawn = true;
      this.hpBg.roundRect(-w / 2, top, w, 5, 2).fill({ color: 0x000000, alpha: 0.55 });
    }
    this.hpFg.clear().roundRect(-w / 2, top, Math.max(0, w * ratio), 5, 2).fill({ color: 0x5dd35d });
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
