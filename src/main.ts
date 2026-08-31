import { assetUrl, createEngine, type EngineContext, type Scene } from 'pixiengine';
import { Container, Graphics, Rectangle, Sprite, Text, Texture, TilingSprite } from 'pixi.js';
import { PaperDollView, type DollActor, type RigManifest } from './PaperDoll';
import './style.css';

const W = 1280, H = 720, NIGHT = 40_000, DAY = 50_000, LAST = 3;
type Phase = 'night' | 'day';
type ZombieState = 'idle' | 'walk' | 'attack' | 'damaged' | 'death';
type Person = DollActor & {
  doll: PaperDollView; vx: number; vy: number; role: 'citizen' | 'hunter'; deadFor: number; shotFor: number;
};
type Infected = { view: ZombieView; x: number; y: number; vx: number; vy: number; facing: number };
type Bullet = { view: Graphics; x: number; y: number; vx: number; vy: number };
type Fx = { view: Graphics; life: number; max: number };

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

  sync(x: number, y: number, facing: number, state: ZombieState, dt: number, sliding = false): void {
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
    this.sprite.scale.y = this.scale * (sliding ? 0.62 : 1);
    this.sprite.rotation = sliding ? -0.18 * facing : 0;
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
  private infected: Infected[] = [];
  private bullets: Bullet[] = [];
  private effects: Fx[] = [];
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
  private rollFor = 0;
  private rollCooldown = 0;
  private dashFor = 0;
  private dashCooldown = 0;
  private rollText!: Text;
  private dashText!: Text;
  private lobby: Container | null = null;
  private upgrades = { run: 0, slide: 0, dash: 0 };
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
    for (const kind of ['citizen', 'student', 'police', 'doctor'])
      for (const state of ['idle', 'walk', 'attack', 'damaged', 'death'])
        manifest[`infected_${kind}_${state}`] = assetUrl(`assets/infected/${kind}/${state}.png`);
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
    this.showLobby('NIGHT 1 · THE HUNT BEGINS');
  }

  update(dt: number): void {
    this.attackFor = Math.max(0, this.attackFor - dt);
    this.hurtFor = Math.max(0, this.hurtFor - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.rollFor = Math.max(0, this.rollFor - dt);
    this.rollCooldown = Math.max(0, this.rollCooldown - dt);
    this.dashFor = Math.max(0, this.dashFor - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.updateBullets(dt);
    this.updateEffects(dt);
    if (this.lobby) {
      this.hero.sync(640, this.heroY, this.facing, 'idle', dt);
      this.drawHud();
      return;
    }
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
    this.hero.sync(640, this.heroY, this.facing, state, dt, this.rollFor > 0);
    this.drawHud();
  }

  private person(role: Person['role'], outfit: string, gender: string, weapon = ''): Person {
    const doll = new PaperDollView(this.rig, role === 'hunter' ? 126 : 108, gender,
      { top: outfit, bottom: outfit, hat: outfit, shoes: outfit }, weapon);
    const actor: Person = { doll, role, x: 0, y: 0, vx: 0, vy: 0, facing: 1,
      moving: true, dead: false, deadFor: 0, shotFor: Math.random() * 700, attackVariant: role === 'hunter' ? 3 : 1,
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
      const a = this.person('hunter', swat ? 'swat_1' : 'soldier_2', 'male',
        swat ? 'rifle_3_1' : 'rifle_2_1');
      a.x = i % 2 ? 1210 : 70; a.y = 330 + Math.random() * 290;
    }
  }

  private moveHero(dt: number): void {
    this.updateJoystick();
    let { x, y } = this.ctx.input.axis();
    if (Math.hypot(x, y) < 0.05 && (this.rollFor || this.dashFor)) { x = this.facing; y = 0; }
    const len = Math.hypot(x, y);
    this.moving = len > 0.05;
    if (!this.moving) return;
    const runBonus = 1 + this.upgrades.run * 0.1;
    const speed = (this.phase === 'night' ? 230 : 250) * runBonus
      * (this.dashFor ? 2.5 + this.upgrades.dash * 0.25 : this.rollFor ? 1.65 + this.upgrades.slide * 0.12 : 1);
    const mx = x / len * speed * dt / 1000, my = y / len * speed * dt / 1000;
    if (Math.abs(mx) > 0.01) this.facing = mx < 0 ? -1 : 1;
    this.heroY = Math.max(300, Math.min(H - 35, this.heroY + my));
    for (const bg of this.backgrounds) bg.sprite.tilePosition.x -= mx * bg.effect;
    for (const a of this.people) {
      a.x -= mx;
      if (a.x < -120) a.x += W + 240;
      if (a.x > W + 120) a.x -= W + 240;
    }
    for (const a of this.infected) {
      a.x -= mx;
      if (a.x < -120) a.x += W + 240;
      if (a.x > W + 120) a.x -= W + 240;
    }
    for (const b of this.bullets) b.x -= mx;
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
        if (a.deadFor > 700) {
          const { x, y } = a;
          this.removePerson(a); this.spawnInfected(x, y); this.burst(x, y, 0x7cff6b);
        }
        continue;
      }
      const dx = a.x - 640, dy = a.y - this.heroY, danger = Math.hypot(dx, dy);
      if (danger < 300) {
        const len = danger || 1;
        a.vx += dx / len * 420 * dt / 1000; a.vy += dy / len * 300 * dt / 1000;
      } else if (Math.random() < 0.008) {
        a.vx += (Math.random() - 0.5) * 80; a.vy += (Math.random() - 0.5) * 50;
      }
      const speed = Math.hypot(a.vx, a.vy) || 1, cap = danger < 300 ? 175 : 80;
      if (speed > cap) { a.vx *= cap / speed; a.vy *= cap / speed; }
      a.x += a.vx * dt / 1000; a.y += a.vy * dt / 1000;
      if (a.y < 300 || a.y > H - 35) a.vy *= -1;
      a.facing = a.vx < 0 ? -1 : 1; a.moving = true; a.doll.sync(a, dt);
      if (Math.hypot(640 - a.x, this.heroY - a.y) < 58) {
        a.dead = true; a.moving = false; this.attackFor = 380; this.bites++; this.score += 100;
        this.burst(a.x, a.y - 55, 0xff4f63);
      }
    }
    this.updateInfected(dt);
    if (!this.people.some((a) => a.role === 'citizen' && !a.dead)) this.spawnCitizens();
  }

  private updateDay(dt: number): void {
    for (const a of this.people) {
      if (a.role !== 'hunter') continue;
      const dx = 640 - a.x, dy = this.heroY - a.y, len = Math.hypot(dx, dy) || 1;
      const speed = 105 + this.day * 15;
      const range = 390;
      if (len > range * 0.8) {
        a.x += dx / len * speed * dt / 1000; a.y += dy / len * speed * dt / 1000;
      }
      a.shotFor -= dt;
      if (len < range && a.shotFor <= 0) {
        a.shotFor = 850 + Math.random() * 350;
        a.attackingFor = 380; this.shoot(a.x, a.y - 70, dx, dy + 15);
      } else a.attackingFor = Math.max(0, a.attackingFor - dt);
      a.facing = dx < 0 ? -1 : 1; a.moving = len > range * 0.8;
      a.doll.sync(a, dt);
    }
  }

  private shoot(x: number, y: number, dx: number, dy: number): void {
    const len = Math.hypot(dx, dy) || 1, speed = 560;
    const view = new Graphics().circle(0, 0, 7).fill(0xffe26a)
      .circle(0, 0, 13).stroke({ color: 0xff6b35, width: 3, alpha: 0.75 });
    view.position.set(x, y); view.zIndex = 900_000; this.view.addChild(view);
    this.bullets.push({ view, x, y, vx: dx / len * speed, vy: dy / len * speed });
    this.burst(x, y, 0xffd75a, 5);
  }

  private updateBullets(dt: number): void {
    for (const b of [...this.bullets]) {
      b.x += b.vx * dt / 1000; b.y += b.vy * dt / 1000; b.view.position.set(b.x, b.y);
      if (Math.hypot(640 - b.x, this.heroY - 55 - b.y) < 38) {
        this.removeBullet(b);
        if (!this.rollFor && !this.cooldown && !this.ended) {
          this.hp--; this.cooldown = 900; this.hurtFor = 220; this.burst(640, this.heroY - 55, 0xff3f45);
          if (!this.hp) this.finish(false);
        }
      } else if (b.x < -30 || b.x > W + 30 || b.y < 250 || b.y > H + 30) this.removeBullet(b);
    }
  }

  private removeBullet(b: Bullet): void {
    const i = this.bullets.indexOf(b); if (i >= 0) this.bullets.splice(i, 1); b.view.destroy();
  }

  private spawnInfected(x: number, y: number): void {
    const kinds = ['citizen', 'student', 'police', 'doctor'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)]!;
    const textures = Object.fromEntries(['idle', 'walk', 'attack', 'damaged', 'death'].map((state) =>
      [state, this.ctx.assets.get(`infected_${kind}_${state}`)])) as Record<ZombieState, Texture>;
    const infected: Infected = { view: new ZombieView(textures, this.ctx.assets.get('shadow')),
      x, y, vx: (Math.random() - 0.5) * 55, vy: (Math.random() - 0.5) * 30, facing: 1 };
    this.infected.push(infected); this.view.addChild(infected.view.view);
  }

  private updateInfected(dt: number): void {
    for (const a of this.infected) {
      a.x += a.vx * dt / 1000; a.y += a.vy * dt / 1000;
      if (a.y < 310 || a.y > H - 35) a.vy *= -1;
      if (Math.random() < 0.004) { a.vx *= -1; a.vy += (Math.random() - 0.5) * 25; }
      a.facing = a.vx < 0 ? -1 : 1; a.view.sync(a.x, a.y, a.facing, 'walk', dt);
    }
  }

  private burst(x: number, y: number, color: number, count = 10): void {
    const view = new Graphics();
    for (let i = 0; i < count; i++) {
      const angle = Math.PI * 2 * i / count, distance = 18 + Math.random() * 30;
      view.circle(Math.cos(angle) * distance, Math.sin(angle) * distance, 3 + Math.random() * 4).fill(color);
    }
    view.circle(0, 0, 28).stroke({ color, width: 5 });
    view.position.set(x, y); view.zIndex = 950_000; this.view.addChild(view);
    this.effects.push({ view, life: 420, max: 420 });
  }

  private updateEffects(dt: number): void {
    for (const fx of [...this.effects]) {
      fx.life -= dt; fx.view.alpha = Math.max(0, fx.life / fx.max); fx.view.scale.set(1 + (1 - fx.life / fx.max));
      if (fx.life <= 0) { this.effects.splice(this.effects.indexOf(fx), 1); fx.view.destroy(); }
    }
  }

  private useRoll(): void {
    if (this.rollCooldown || this.ended) return;
    this.rollFor = 440 + this.upgrades.slide * 60;
    this.rollCooldown = Math.max(1800, 3400 - this.upgrades.slide * 350);
    this.burst(640, this.heroY, 0x7ee8ff, 7);
  }

  private useDash(): void {
    if (this.dashCooldown || this.ended) return;
    this.dashFor = 260 + this.upgrades.dash * 45;
    this.dashCooldown = Math.max(1200, 2400 - this.upgrades.dash * 250);
    this.burst(640 - this.facing * 45, this.heroY, 0xffffff, 6);
  }

  private removePerson(a: Person): void {
    this.people.splice(this.people.indexOf(a), 1); a.doll.destroy();
  }

  private clearPeople(): void {
    for (const a of [...this.people]) this.removePerson(a);
    for (const a of this.infected) a.view.view.destroy({ children: true });
    this.infected.length = 0;
    for (const b of [...this.bullets]) this.removeBullet(b);
  }

  private swapPhase(): void {
    this.elapsed = 0; this.clearPeople();
    if (this.phase === 'night') {
      this.phase = 'day'; this.spawnHunters(); this.showLobby(`DAY ${this.day} · SURVIVE`); return;
    }
    this.score += 500;
    if (this.day >= LAST) this.finish(true);
    else {
      this.day++; this.phase = 'night'; this.spawnCitizens(); this.showLobby(`NIGHT ${this.day} · HUNT`);
    }
  }

  private showLobby(title: string): void {
    this.lobby?.destroy({ children: true });
    const lobby = new Container(); lobby.zIndex = 3_000_000;
    const cover = new Graphics().rect(0, 0, W, H).fill({ color: 0x07101d, alpha: 0.94 });
    cover.eventMode = 'static'; lobby.addChild(cover);
    const heading = this.label(640, 105, 44); heading.text = title;
    const wallet = this.label(640, 160, 24); wallet.text = `UPGRADE POINTS · ${this.score}`;
    lobby.addChild(heading, wallet);
    const choices = [
      ['run', 'RUN', 'MOVE SPEED +10%', 0x3c9f63],
      ['slide', 'SLIDE', 'LONGER · COOLDOWN ↓', 0x197b9b],
      ['dash', 'DASH', 'RANGE ↑ · COOLDOWN ↓', 0x9b4b19],
    ] as const;
    choices.forEach(([key, name, detail, color], i) => {
      const level = this.upgrades[key], cost = 200 * (level + 1), x = 260 + i * 380;
      const card = new Graphics().roundRect(x - 155, 220, 310, 250, 22)
        .fill({ color, alpha: 0.65 }).stroke({ color: 0xffffff, width: 3, alpha: 0.55 });
      card.eventMode = 'static'; card.cursor = 'pointer';
      card.on('pointertap', () => this.buyUpgrade(key, title));
      const nameText = this.label(x, 275, 31); nameText.text = name;
      const levelText = this.label(x, 338, 25); levelText.text = `LEVEL ${level}/5`;
      const detailText = this.label(x, 390, 17); detailText.text = detail;
      const costText = this.label(x, 438, 22);
      costText.text = level >= 5 ? 'MAX' : `${cost} PTS`;
      costText.style.fill = level >= 5 || this.score >= cost ? 0xffffff : 0xff7777;
      lobby.addChild(card, nameText, levelText, detailText, costText);
    });
    const start = new Graphics().roundRect(490, 535, 300, 82, 18)
      .fill(0xd73547).stroke({ color: 0xffffff, width: 4 });
    start.eventMode = 'static'; start.cursor = 'pointer'; start.on('pointertap', () => {
      lobby.destroy({ children: true }); this.lobby = null;
    });
    const startText = this.label(640, 576, 30);
    startText.text = title === 'NIGHT 1 · THE HUNT BEGINS' ? 'START' : 'CONTINUE';
    lobby.addChild(start, startText); this.lobby = lobby; this.view.addChild(lobby);
  }

  private buyUpgrade(key: 'run' | 'slide' | 'dash', title: string): void {
    const level = this.upgrades[key], cost = 200 * (level + 1);
    if (level >= 5 || this.score < cost) return;
    this.score -= cost; this.upgrades[key]++; this.showLobby(title); this.drawHud();
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
    const help = this.label(640, 690, 18); help.text = 'MOVE: WASD / ARROWS / LEFT TOUCH';
    this.joyBase = this.ctx.assets.makeSprite('joyBase', { scale: 0.75 }); this.joyBase.visible = false;
    this.joyKnob = this.ctx.assets.makeSprite('joyKnob', { scale: 0.75 }); this.joyKnob.visible = false;
    const roll = new Graphics().circle(1050, 590, 54).fill({ color: 0x197b9b, alpha: 0.9 })
      .circle(1050, 590, 48).stroke({ color: 0x9defff, width: 4 });
    roll.eventMode = 'static'; roll.cursor = 'pointer'; roll.on('pointertap', () => this.useRoll());
    this.rollText = this.label(1050, 590, 18); this.rollText.text = 'SLIDE';
    const dash = new Graphics().circle(1170, 590, 54).fill({ color: 0x9b4b19, alpha: 0.9 })
      .circle(1170, 590, 48).stroke({ color: 0xffd49d, width: 4 });
    dash.eventMode = 'static'; dash.cursor = 'pointer'; dash.on('pointertap', () => this.useDash());
    this.dashText = this.label(1170, 590, 18); this.dashText.text = 'DASH';
    const hud = [panel, this.moon, this.sun, this.phaseText, this.timer, track, this.fill,
      this.scoreText, this.status, help, roll, this.rollText, dash, this.dashText, this.joyBase, this.joyKnob];
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
    this.rollText.text = this.rollCooldown ? `SLIDE\n${(this.rollCooldown / 1000).toFixed(1)}` : 'SLIDE';
    this.dashText.text = this.dashCooldown ? `DASH\n${(this.dashCooldown / 1000).toFixed(1)}` : 'DASH';
  }
}

async function main(): Promise<void> {
  const parent = document.querySelector<HTMLElement>('#app');
  if (!parent) throw new Error('#app not found');
  const engine = await createEngine({ parent, design: { width: W, height: H }, background: 0x111827 });
  await engine.start(new GameScene());
}
void main();
