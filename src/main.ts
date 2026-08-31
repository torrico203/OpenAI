import { assetUrl, createEngine, type EngineContext, type Scene } from 'pixiengine';
import { Container, Graphics, Rectangle, Sprite, Text, Texture, TilingSprite } from 'pixi.js';
import { PaperDollView, type DollActor, type RigManifest } from './PaperDoll';
import './style.css';

const W = 1280, H = 720, NIGHT = 40_000, DAY = 50_000, LAST = 3;
type Phase = 'night' | 'day';
type ZombieState = 'idle' | 'walk' | 'attack' | 'damaged' | 'death';
type Person = DollActor & {
  doll: PaperDollView; vx: number; vy: number; role: 'citizen' | 'hunter'; deadFor: number;
};

class ZombieView {
  readonly view = new Container();
  private readonly sprite: Sprite;
  private readonly frames: Record<ZombieState, Texture[]>;
  private state: ZombieState = 'idle';
  private frame = 0;
  private elapsed = 0;
  private readonly scale = 116 / 98;

  constructor(textures: Record<ZombieState, Texture>, shadow: Texture) {
    this.frames = Object.fromEntries(Object.entries(textures).map(([state, texture]) => [
      state,
      Array.from({ length: 8 }, (_, i) => new Texture({
        source: texture.source,
        frame: new Rectangle(i * 272, 0, 272, 190),
      })),
    ])) as Record<ZombieState, Texture[]>;
    const shade = new Sprite(shadow);
    shade.anchor.set(0.5); shade.width = 72; shade.height = 16; shade.alpha = 0.5;
    this.sprite = new Sprite(this.frames.idle[0]);
    this.sprite.anchor.set(0.538, 0.916);
    this.sprite.scale.set(this.scale);
    this.view.addChild(shade, this.sprite);
  }

  sync(x: number, y: number, facing: number, state: ZombieState, dt: number): void {
    if (state !== this.state) { this.state = state; this.frame = 0; this.elapsed = 0; }
    const looping = state === 'idle' || state === 'walk';
    const duration = state === 'attack' ? 70 : state === 'walk' ? 90 : 100;
    this.elapsed += dt;
    while (this.elapsed >= duration) {
      this.elapsed -= duration;
      this.frame = looping ? (this.frame + 1) % 8 : Math.min(this.frame + 1, 7);
    }
    this.sprite.texture = this.frames[state][this.frame]!;
    this.sprite.scale.x = this.scale * facing * -1;
    this.view.position.set(x, y);
    this.view.zIndex = Math.round(y);
  }
}

class GameScene implements Scene {
  readonly view = new Container();
  private ctx!: EngineContext;
  private rig!: RigManifest;
  private hero!: ZombieView;
  private shade!: Graphics;
  private backgrounds: { sprite: TilingSprite; effect: number }[] = [];
  private people: Person[] = [];
  private phase: Phase = 'night';
  private elapsed = 0;
  private day = 1;
  private bites = 0;
  private score = 0;
  private hp = 3;
  private heroY = 500;
  private facing = 1;
  private moving = false;
  private attackFor = 0;
  private hurtFor = 0;
  private dead = false;
  private ended = false;
  private cooldown = 0;
  private phaseText!: Text;
  private timer!: Text;
  private scoreText!: Text;
  private status!: Text;
  private fill!: Sprite;
  private moon!: Sprite;
  private sun!: Graphics;
  private joyBase!: Sprite;
  private joyKnob!: Sprite;
  private joyX = 0;
  private joyY = 0;
  private joystickActive = false;

  async onEnter(ctx: EngineContext): Promise<void> {
    this.ctx = ctx;
    this.rig = await fetch(assetUrl('assets/player/rig/rig.json')).then((r) => r.json()) as RigManifest;
    const manifest: Record<string, string> = {
      far: assetUrl('assets/field/far.png'), mid: assetUrl('assets/field/mid.png'),
      near: assetUrl('assets/field/near.png'), shadow: assetUrl('assets/field/shadow.png'),
      panel: assetUrl('assets/ui/panel.png'), track: assetUrl('assets/ui/gauge_track.png'),
      fill: assetUrl('assets/ui/gauge_fill.png'), moon: assetUrl('assets/ui/menu_night.png'),
      joyBase: assetUrl('assets/ui/joy_base.png'), joyKnob: assetUrl('assets/ui/joy_knob.png'),
    };
    for (let i = 0; i < 8; i++) manifest[`pd_atlas_${i}`] = assetUrl(`assets/player/rig/atlas-${i}.png`);
    for (const state of ['idle', 'walk', 'attack', 'damaged', 'death'])
      manifest[`z_${state}`] = assetUrl(`assets/zombie-hero/monster17_${state}.png`);
    await ctx.assets.load(manifest);

    this.view.sortableChildren = true;
    for (const [alias, effect, z] of [['far', 0.25, -300], ['mid', 0.55, -200], ['near', 1, -100]] as const) {
      const texture = ctx.assets.get(alias);
      const sprite = new TilingSprite({ texture, width: W, height: H });
      sprite.tileScale.set(H / texture.height); sprite.zIndex = z;
      this.backgrounds.push({ sprite, effect }); this.view.addChild(sprite);
    }
    this.shade = new Graphics().rect(0, 0, W, H).fill(0x071426); this.shade.zIndex = -50;
    const heroTextures = Object.fromEntries(['idle', 'walk', 'attack', 'damaged', 'death'].map((s) =>
      [s, ctx.assets.get(`z_${s}`)])) as Record<ZombieState, Texture>;
    this.hero = new ZombieView(heroTextures, ctx.assets.get('shadow'));
    this.view.addChild(this.shade, this.hero.view);
    this.makeHud();
    this.spawnCitizens();
    this.drawHud();
  }

  update(dt: number): void {
    this.attackFor = Math.max(0, this.attackFor - dt);
    this.hurtFor = Math.max(0, this.hurtFor - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.ended) {
      this.hero.sync(640, this.heroY, this.facing, this.dead ? 'death' : 'idle', dt);
      return;
    }
    this.elapsed += dt;
    this.moveHero(dt);
    if (this.phase === 'night') this.updateNight(dt); else this.updateDay(dt);
    if (this.elapsed >= (this.phase === 'night' ? NIGHT : DAY)) this.swapPhase();
    const state: ZombieState = this.dead ? 'death' : this.hurtFor ? 'damaged'
      : this.attackFor ? 'attack' : this.moving ? 'walk' : 'idle';
    this.hero.sync(640, this.heroY, this.facing, state, dt);
    this.drawHud();
  }

  private person(role: Person['role'], outfit: string, gender: string, weapon = ''): Person {
    const doll = new PaperDollView(this.rig, role === 'hunter' ? 126 : 108, gender,
      { top: outfit, bottom: outfit, hat: outfit, shoes: outfit }, weapon);
    const actor: Person = { doll, role, x: 0, y: 0, vx: 0, vy: 0, facing: 1,
      moving: true, dead: false, deadFor: 0, attackVariant: role === 'hunter' ? 3 : 1,
      attackingFor: 0, attackLoop: false, hurtFor: 0, jumpFor: 0, reloadFor: 0,
      shake: 0, hp: 1, maxHp: 1 };
    this.people.push(actor); this.view.addChild(doll.view); return actor;
  }

  private spawnCitizens(): void {
    const outfits = ['hoodie_1', 'hoodie_2', 'jean_1', 'jean_3', 'golf_1', 'apocalypse_2'];
    for (let i = 0; i < 10; i++) {
      const a = this.person('citizen', outfits[i % outfits.length]!, i % 2 ? 'male' : 'female');
      a.x = 70 + Math.random() * 1140; a.y = 320 + Math.random() * 330;
      a.vx = (Math.random() - 0.5) * 90; a.vy = (Math.random() - 0.5) * 55;
    }
  }

  private spawnHunters(): void {
    const count = Math.min(6, 1 + Math.floor(this.bites / 3));
    for (let i = 0; i < count; i++) {
      const swat = i % 2 === 0;
      const a = this.person('hunter', swat ? 'swat_1' : 'soldier_2', i % 2 ? 'female' : 'male',
        swat ? 'rifle_3_1' : 'rifle_2_1');
      a.x = i % 2 ? 1210 : 70; a.y = 330 + Math.random() * 290;
    }
  }

  private moveHero(dt: number): void {
    this.updateJoystick();
    const { x, y } = this.ctx.input.axis();
    const len = Math.hypot(x, y);
    this.moving = len > 0.05;
    if (!this.moving) return;
    const speed = this.phase === 'night' ? 230 : 250;
    const mx = x / len * speed * dt / 1000, my = y / len * speed * dt / 1000;
    if (Math.abs(mx) > 0.01) this.facing = mx < 0 ? -1 : 1;
    this.heroY = Math.max(300, Math.min(H - 35, this.heroY + my));
    for (const bg of this.backgrounds) bg.sprite.tilePosition.x -= mx * bg.effect;
    for (const a of this.people) {
      a.x -= mx;
      if (a.x < -120) a.x += W + 240;
      if (a.x > W + 120) a.x -= W + 240;
    }
  }

  private updateJoystick(): void {
    const pointer = this.ctx.input.pointer;
    if (pointer.down) {
      const p = this.ctx.toDesign(pointer.x, pointer.y);
      if (!this.joystickActive && p.x < W * 0.6) {
        this.joystickActive = true; this.joyX = p.x; this.joyY = p.y;
        this.joyBase.position.set(p.x, p.y); this.joyKnob.position.set(p.x, p.y);
        this.joyBase.visible = true; this.joyKnob.visible = true;
      }
      if (this.joystickActive) {
        const dx = p.x - this.joyX, dy = p.y - this.joyY;
        const len = Math.hypot(dx, dy) || 1, reach = Math.min(len, 52);
        this.joyKnob.position.set(this.joyX + dx / len * reach, this.joyY + dy / len * reach);
        this.ctx.input.setJoystick(dx / len * reach / 52, dy / len * reach / 52);
      }
    } else if (this.joystickActive) {
      this.joystickActive = false; this.joyBase.visible = false; this.joyKnob.visible = false;
      this.ctx.input.setJoystick(0, 0);
    }
  }

  private updateNight(dt: number): void {
    for (const a of [...this.people]) {
      if (a.role !== 'citizen') continue;
      if (a.dead) {
        a.deadFor += dt; a.doll.sync(a, dt);
        if (a.deadFor > 900) this.removePerson(a);
        continue;
      }
      a.x += a.vx * dt / 1000; a.y += a.vy * dt / 1000;
      if (a.y < 300 || a.y > H - 35) a.vy *= -1;
      a.facing = a.vx < 0 ? -1 : 1; a.moving = true; a.doll.sync(a, dt);
      if (Math.hypot(640 - a.x, this.heroY - a.y) < 58) {
        a.dead = true; a.moving = false; this.attackFor = 380; this.bites++; this.score += 100;
      }
    }
    if (!this.people.some((a) => a.role === 'citizen' && !a.dead)) this.spawnCitizens();
  }

  private updateDay(dt: number): void {
    for (const a of this.people) {
      if (a.role !== 'hunter') continue;
      const dx = 640 - a.x, dy = this.heroY - a.y, len = Math.hypot(dx, dy) || 1;
      const speed = 105 + this.day * 15;
      a.x += dx / len * speed * dt / 1000; a.y += dy / len * speed * dt / 1000;
      a.facing = dx < 0 ? -1 : 1; a.moving = len > 55; a.attackingFor = len < 70 ? 180 : 0;
      a.doll.sync(a, dt);
      if (len < 58 && !this.cooldown) {
        this.hp--; this.cooldown = 1200; this.hurtFor = 220;
        if (!this.hp) this.finish(false);
      }
    }
  }

  private removePerson(a: Person): void {
    this.people.splice(this.people.indexOf(a), 1); a.doll.destroy();
  }

  private clearPeople(): void {
    for (const a of [...this.people]) this.removePerson(a);
  }

  private swapPhase(): void {
    this.elapsed = 0; this.clearPeople();
    if (this.phase === 'night') { this.phase = 'day'; this.spawnHunters(); return; }
    this.score += 500;
    if (this.day >= LAST) this.finish(true);
    else { this.day++; this.phase = 'night'; this.spawnCitizens(); }
  }

  private finish(win: boolean): void {
    this.ended = true; this.dead = !win;
    const cover = new Graphics().rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.72 }); cover.zIndex = 2_000_000;
    const title = this.label(640, 300, 54); title.text = win ? 'YOU SURVIVED' : 'HUNTED DOWN'; title.zIndex = 2_000_001;
    const result = this.label(640, 380, 28); result.text = `SCORE ${this.score}  ·  BITES ${this.bites}`; result.zIndex = 2_000_001;
    this.view.addChild(cover, title, result);
  }

  private makeHud(): void {
    const panel = this.ctx.assets.makeSprite('panel', { anchor: 0, x: 1090, y: 24 }); panel.width = 160; panel.height = 210;
    const track = this.ctx.assets.makeSprite('track', { anchor: 0, x: 1110, y: 191 }); track.width = 120; track.height = 13;
    this.fill = this.ctx.assets.makeSprite('fill', { anchor: 0, x: 1110, y: 191 }); this.fill.height = 13;
    this.moon = this.ctx.assets.makeSprite('moon', { x: 1170, y: 72, scale: 0.75 });
    this.sun = new Graphics().circle(1170, 72, 25).fill(0xffd54a);
    this.phaseText = this.label(1170, 116, 24); this.timer = this.label(1170, 154, 31, 'monospace');
    this.scoreText = this.label(24, 28, 25); this.scoreText.anchor.set(0);
    this.status = this.label(640, 650, 25);
    const help = this.label(640, 690, 18); help.text = 'WASD / ARROWS / LEFT-SIDE TOUCH';
    this.joyBase = this.ctx.assets.makeSprite('joyBase', { scale: 0.75 }); this.joyBase.visible = false;
    this.joyKnob = this.ctx.assets.makeSprite('joyKnob', { scale: 0.75 }); this.joyKnob.visible = false;
    const hud = [panel, this.moon, this.sun, this.phaseText, this.timer, track, this.fill,
      this.scoreText, this.status, help, this.joyBase, this.joyKnob];
    for (const child of hud) child.zIndex = 1_000_000;
    this.view.addChild(...hud);
  }

  private label(x: number, y: number, size: number, family = 'sans-serif'): Text {
    const text = new Text({ text: '', style: { fill: 0xffffff, fontFamily: family, fontSize: size,
      fontWeight: 'bold', stroke: { color: 0x111111, width: 5 } } });
    text.anchor.set(0.5); text.position.set(x, y); return text;
  }

  private drawHud(): void {
    const duration = this.phase === 'night' ? NIGHT : DAY;
    const left = Math.max(0, Math.ceil((duration - this.elapsed) / 1000));
    this.shade.alpha = this.phase === 'night' ? 0.5 : 0.08;
    this.moon.visible = this.phase === 'night'; this.sun.visible = this.phase === 'day';
    this.phaseText.text = this.phase === 'night' ? 'HUNT' : 'SURVIVE';
    this.phaseText.style.fill = left <= 5 ? 0xff655f : 0xffffff;
    this.timer.text = `00:${String(left).padStart(2, '0')}`; this.fill.width = 120 * (1 - this.elapsed / duration);
    this.scoreText.text = `DAY ${this.day}/${LAST}   SCORE ${this.score}   HP ${'♥'.repeat(this.hp)}`;
    const hunters = this.people.filter((a) => a.role === 'hunter').length;
    this.status.text = this.phase === 'night' ? `BITE THE LIVING  ·  ${this.bites} INFECTED`
      : `${hunters} HUNTERS  ·  SURVIVE UNTIL SUNSET`;
  }
}

async function main(): Promise<void> {
  const parent = document.querySelector<HTMLElement>('#app');
  if (!parent) throw new Error('#app not found');
  const engine = await createEngine({ parent, design: { width: W, height: H }, background: 0x111827 });
  await engine.start(new GameScene());
}
void main();
