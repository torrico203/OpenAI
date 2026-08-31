import { assetUrl, createEngine, type EngineContext, type Scene } from 'pixiengine';
import { Container, Graphics, Rectangle, Sprite, Text, Texture, TilingSprite } from 'pixi.js';
import { PaperDollView, type DollActor, type RigManifest } from './PaperDoll';
import './style.css';

const W = 1280, H = 720, NIGHT = 40_000, DAY = 50_000;
type Phase = 'night' | 'day';
type ZombieState = 'idle' | 'walk' | 'attack' | 'damaged' | 'death';
type Person = DollActor & {
  doll: PaperDollView; vx: number; vy: number; role: 'citizen' | 'hunter'; deadFor: number; shotFor: number;
  hunterType: 'ranged' | 'melee'; panicFor: number; safeFor: number; dashFor: number; dashCooldown: number;
};
type Infected = { view: ZombieView; x: number; y: number; vx: number; vy: number; facing: number };
type Bullet = { view: Graphics; x: number; y: number; vx: number; vy: number };
type Fx = { view: Graphics; life: number; max: number };
type Hideout = { view: Container; sprite: Sprite; hpText: Text; x: number; y: number; hp: number; maxHp: number;
  kind: 'bronze' | 'silver' | 'gold'; reward: number; citizens: number; hitFor: number };
type DamageText = { view: Text; life: number };
type UpgradeKey = 'run' | 'slide' | 'dash' | 'attack' | 'heal';

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

  sync(x: number, y: number, facing: number, state: ZombieState, dt: number, slidePose = 0): void {
    if (state !== this.state) { this.state = state; this.frame = 0; this.elapsed = 0; }
    const looping = state === 'idle' || state === 'walk';
    const duration = state === 'attack' ? 70 : state === 'walk' ? 90 : 100;
    this.elapsed += dt;
    while (this.elapsed >= duration) {
      this.elapsed -= duration;
      this.frame = looping ? (this.frame + 1) % 8 : Math.min(this.frame + 1, 7);
    }
    this.sprite.texture = this.frames[state][this.frame]!;
    this.sprite.tint = state === 'damaged' ? 0xff4d4d : 0xffffff;
    this.sprite.anchor.set(0.538 + (0.5 - 0.538) * slidePose, 0.916 + (0.5 - 0.916) * slidePose);
    this.sprite.position.y = -48 * slidePose;
    this.sprite.scale.x = this.scale * facing * -1;
    this.sprite.scale.y = this.scale;
    this.sprite.rotation = -Math.PI / 2 * facing * slidePose;
    this.view.position.set(x, y);
    this.view.zIndex = Math.round(y);
  }
}

class GameScene implements Scene {
  readonly view = new Container();
  constructor(private readonly skipTitle = false) {}
  private ctx!: EngineContext;
  private rig!: RigManifest;
  private hero!: ZombieView;
  private shade!: Graphics;
  private backgrounds: { sprite: TilingSprite; effect: number }[] = [];
  private people: Person[] = [];
  private infected: Infected[] = [];
  private bullets: Bullet[] = [];
  private effects: Fx[] = [];
  private damageTexts: DamageText[] = [];
  private hideout: Hideout | null = null;
  private phase: Phase = 'night';
  private elapsed = 0;
  private day = 1;
  private bites = 0;
  private score = 0;
  private hp = 3;
  private readonly maxHp = 3;
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
  private attackCooldown = 0;
  private rollText!: Text;
  private dashText!: Text;
  private rollButton!: Graphics;
  private dashButton!: Graphics;
  private attackButton!: Graphics;
  private attackText!: Text;
  private lobby: Container | null = null;
  private titlePrompt: Text | null = null;
  private titlePulse = 0;
  private transitionTimer = 0;
  private upgradeTimer = 0;
  private resultTimer = 0;
  private introTimer = 0;
  private shakeFor = 0;
  private hitFlash!: Graphics;
  private minimap!: Graphics;
  private upgrades = { run: 0, slide: 0, dash: 0, attack: 0 };
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
  private audio: Record<string, HTMLAudioElement> = {};
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || this.lobby || this.ended) return;
    if (event.code === 'KeyZ') this.useAttack();
    else if (event.code === 'KeyX') this.useRoll();
    else if (event.code === 'KeyC') this.useDash();
    else return;
    event.preventDefault();
  };

  async onEnter(ctx: EngineContext): Promise<void> {
    this.ctx = ctx;
    this.view.sortableChildren = true;
    const loading = new Container(); loading.zIndex = 5_000_000;
    const loadingBg = new Graphics().rect(0, 0, W, H).fill(0x08111f);
    const loadingTitle = this.label(640, 205, 46); loadingTitle.text = 'GO LIMITLESS';
    const loadingText = this.label(640, 535, 21); loadingText.text = 'LOADING 0%';
    const track = new Graphics().roundRect(390, 565, 500, 16, 8).fill(0x1b2b43);
    const bar = new Graphics(); loading.addChild(loadingBg, loadingTitle, loadingText, track, bar);
    this.view.addChild(loading);
    await ctx.assets.load({
      loadingCat: assetUrl('assets/loading/cat_walk.png'),
      loadingCopycat: assetUrl('assets/loading/copycat_walk.png'),
    });
    const catTex = ctx.assets.get('loadingCat'), copyTex = ctx.assets.get('loadingCopycat');
    const cat = new Sprite(), copycat = new Sprite(); cat.anchor.set(0.5); copycat.anchor.set(0.5);
    cat.scale.set(0.9); copycat.scale.set(0.52); cat.position.set(1120, 450); copycat.position.set(1360, 415);
    loading.addChild(cat, copycat);
    let loadingFrame = 0;
    const loadingTimer = window.setInterval(() => {
      const frame = loadingFrame++ % 8;
      cat.texture = new Texture({ source: catTex.source, frame: new Rectangle(frame * 150, 0, 150, 150) });
      copycat.texture = new Texture({ source: copyTex.source,
        frame: new Rectangle(frame % 4 * 400, Math.floor(frame / 4) * 400, 400, 400) });
      cat.x -= 18; copycat.x -= 18;
      if (cat.x < -180) { cat.x = 1350; copycat.x = 1590; }
    }, 90);
    this.rig = await fetch(assetUrl('assets/player/rig/rig.json')).then((r) => r.json()) as RigManifest;
    const manifest: Record<string, string> = {
      far: assetUrl('assets/field/far.png'), mid: assetUrl('assets/field/mid.png'),
      near: assetUrl('assets/field/near.png'), shadow: assetUrl('assets/field/shadow.png'),
      town: assetUrl('assets/field/themes/town.png'), street: assetUrl('assets/field/themes/street.png'),
      panel: assetUrl('assets/ui/panel.png'), track: assetUrl('assets/ui/gauge_track.png'),
      fill: assetUrl('assets/ui/gauge_fill.png'), moon: assetUrl('assets/ui/menu_night.png'),
      joyBase: assetUrl('assets/ui/joy_base.png'), joyKnob: assetUrl('assets/ui/joy_knob.png'),
      titleScreen: assetUrl('assets/title/title-screen.jpg'),
      hideoutBronze: assetUrl('assets/hideout/bronze.png'), hideoutSilver: assetUrl('assets/hideout/silver.png'),
      hideoutGold: assetUrl('assets/hideout/gold.png'),
    };
    for (let i = 0; i < 8; i++) manifest[`pd_atlas_${i}`] = assetUrl(`assets/player/rig/atlas-${i}.webp`);
    for (const state of ['idle', 'walk', 'attack', 'damaged', 'death'])
      manifest[`z_${state}`] = assetUrl(`assets/zombie-hero/monster17_${state}.png`);
    for (const kind of ['citizen', 'student', 'police', 'doctor'])
      for (const state of ['idle', 'walk', 'attack', 'damaged', 'death'])
        manifest[`infected_${kind}_${state}`] = assetUrl(`assets/infected/${kind}/${state}.png`);
    await ctx.assets.load(manifest, ({ loaded, total }) => {
      const ratio = loaded / total;
      bar.clear().roundRect(392, 567, 496 * ratio, 12, 6).fill(0xe54858);
      loadingText.text = `LOADING ${Math.round(ratio * 100)}%`;
    });
    for (const name of ['bgm', 'infect', 'hurt', 'ui', 'slide', 'dash']) {
      const sound = new Audio(assetUrl(`assets/audio/${name}.mp3`)); sound.preload = 'auto';
      this.audio[name] = sound;
    }
    this.audio.bgm!.loop = true; this.audio.bgm!.volume = 0.22;
    window.clearInterval(loadingTimer); loading.destroy({ children: true });

    const theme = Math.floor(Math.random() * 3);
    const layers = theme === 0 ? [['far', 0.25, -300], ['mid', 0.55, -200], ['near', 1, -100]] as const
      : [[theme === 1 ? 'town' : 'street', 1, -100]] as const;
    for (const [alias, effect, z] of layers) {
      const texture = ctx.assets.get(alias);
      const sprite = new TilingSprite({ texture, width: W, height: H });
      sprite.tileScale.set(H / texture.height); sprite.zIndex = z;
      this.backgrounds.push({ sprite, effect }); this.view.addChild(sprite);
    }
    this.shade = new Graphics().rect(0, 0, W, H).fill(0x071426); this.shade.zIndex = -50;
    const heroTextures = Object.fromEntries(['idle', 'walk', 'attack', 'damaged', 'death'].map((s) =>
      [s, ctx.assets.get(`z_${s}`)])) as Record<ZombieState, Texture>;
    this.hero = new ZombieView(heroTextures, ctx.assets.get('shadow'));
    this.hitFlash = new Graphics().rect(0, 0, W, H).fill(0xff1f2d); this.hitFlash.alpha = 0; this.hitFlash.zIndex = 999_999;
    this.view.addChild(this.shade, this.hero.view, this.hitFlash);
    this.makeHud();
    window.addEventListener('keydown', this.onKeyDown);
    this.spawnCitizens();
    this.spawnHideout();
    this.drawHud();
    if (this.skipTitle) this.showLobby('NIGHT 1 · THE HUNT BEGINS'); else this.showTitle();
  }

  update(dt: number): void {
    if (this.lobby) {
      if (this.titlePrompt) {
        this.titlePulse += dt;
        this.titlePrompt.alpha = 0.45 + Math.sin(this.titlePulse / 260) * 0.35;
      }
      this.hero.sync(640, this.heroY, this.facing, 'idle', dt);
      this.drawHud();
      return;
    }
    this.attackFor = Math.max(0, this.attackFor - dt);
    this.hurtFor = Math.max(0, this.hurtFor - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.rollFor = Math.max(0, this.rollFor - dt);
    const rollWasCooling = this.rollCooldown > 0, dashWasCooling = this.dashCooldown > 0,
      attackWasCooling = this.attackCooldown > 0;
    this.rollCooldown = Math.max(0, this.rollCooldown - dt);
    this.dashFor = Math.max(0, this.dashFor - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    if (rollWasCooling && !this.rollCooldown) this.readyFx(1050, 590, 0x9defff);
    if (dashWasCooling && !this.dashCooldown) this.readyFx(1170, 590, 0xffd49d);
    if (attackWasCooling && !this.attackCooldown && this.phase === 'night') this.readyFx(1110, 455, 0xffef8a);
    this.updateBullets(dt);
    this.updateEffects(dt);
    this.updateDamageTexts(dt);
    this.shakeFor = Math.max(0, this.shakeFor - dt);
    this.view.position.set(this.shakeFor ? (Math.random() - 0.5) * 10 : 0,
      this.shakeFor ? (Math.random() - 0.5) * 7 : 0);
    this.hitFlash.alpha = this.hurtFor > 0 ? Math.min(0.22, this.hurtFor / 700) : 0;
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
    this.hero.sync(640, this.heroY, this.facing, state, dt, Math.min(1, this.rollFor / 130));
    this.drawHud();
  }

  private person(role: Person['role'], outfit: string, gender: string, weapon = ''): Person {
    const doll = new PaperDollView(this.rig, role === 'hunter' ? 126 : 108, gender,
      { top: outfit, bottom: outfit, hat: outfit, shoes: outfit }, weapon);
    const actor: Person = { doll, role, x: 0, y: 0, vx: 0, vy: 0, facing: 1,
      moving: true, dead: false, deadFor: 0, shotFor: Math.random() * 700,
      hunterType: 'ranged', panicFor: 0, safeFor: 0, dashFor: 0, dashCooldown: 5000 + Math.random() * 4000,
      attackVariant: role === 'hunter' ? 3 : 1,
      attackingFor: 0, attackLoop: false, hurtFor: 0, jumpFor: 0, reloadFor: 0,
      shake: 0, hp: 1, maxHp: 1 };
    this.people.push(actor); this.view.addChild(doll.view); return actor;
  }

  private spawnCitizens(count = 10, origin?: { x: number; y: number }): void {
    const outfits = ['hoodie_1', 'hoodie_2', 'jean_1', 'jean_3', 'golf_1', 'apocalypse_2'];
    for (let i = 0; i < count; i++) {
      const a = this.person('citizen', outfits[i % outfits.length]!, i % 2 ? 'male' : 'female');
      a.x = origin ? origin.x + (Math.random() - 0.5) * 70 : 70 + Math.random() * 1140;
      a.y = origin ? origin.y + (Math.random() - 0.5) * 55 : 320 + Math.random() * 330;
      a.vx = origin ? (Math.random() < 0.5 ? -1 : 1) * (110 + Math.random() * 80) : (Math.random() - 0.5) * 90;
      a.vy = (Math.random() - 0.5) * (origin ? 100 : 55);
      a.panicFor = origin ? 1500 : 0; a.safeFor = origin ? 950 : 0;
    }
  }

  private spawnHunters(): void {
    const count = Math.min(12, 2 + this.day + Math.floor(this.bites / 5));
    for (let i = 0; i < count; i++) {
      const melee = i > 0 && i % 3 === 0, swat = i % 2 === 0;
      const a = this.person('hunter', swat ? 'swat_1' : 'soldier_2', 'male', melee
        ? 'meleeweapon_2_2' : swat ? 'rifle_3_1' : 'rifle_2_1');
      a.hunterType = melee ? 'melee' : 'ranged'; a.attackVariant = melee ? 1 : 3;
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
    if (this.hideout) { this.hideout.x -= mx; this.hideout.view.x = this.hideout.x; }
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
      a.panicFor = Math.max(0, a.panicFor - dt);
      a.safeFor = Math.max(0, a.safeFor - dt);
      a.dashFor = Math.max(0, a.dashFor - dt); a.dashCooldown -= dt;
      if (danger < 240 && a.dashCooldown <= 0) {
        a.dashFor = 420; a.dashCooldown = 6000 + Math.random() * 3000;
        const side = a.y < 370 ? 1 : a.y > H - 105 ? -1 : Math.abs(dy) > 24 ? Math.sign(dy) : a.y < 500 ? 1 : -1;
        const ex = dx / (danger || 1), ey = dy / (danger || 1) + side * 0.65, el = Math.hypot(ex, ey) || 1;
        a.vx = ex / el * 470; a.vy = ey / el * 470;
      }
      if (danger < 300) {
        const len = danger || 1;
        const dodgeY = a.y < 370 ? 1 : a.y > H - 105 ? -1 : Math.abs(dy) > 24 ? Math.sign(dy) : a.y < 500 ? 1 : -1;
        a.vx += dx / len * 430 * dt / 1000;
        a.vy += (dy / len * 280 + dodgeY * 210) * dt / 1000;
      } else if (Math.random() < 0.008) {
        a.vx += (Math.random() - 0.5) * 80; a.vy += (Math.random() - 0.5) * 50;
      }
      const speed = Math.hypot(a.vx, a.vy) || 1,
        cap = a.dashFor ? 470 : a.panicFor ? 390 : danger < 300 ? 210 : 80;
      if (speed > cap) { a.vx *= cap / speed; a.vy *= cap / speed; }
      a.x += a.vx * dt / 1000; a.y += a.vy * dt / 1000;
      if (a.y < 300 || a.y > H - 35) { a.y = Math.max(300, Math.min(H - 35, a.y)); a.vy *= -0.7; }
      a.facing = a.vx < 0 ? -1 : 1; a.moving = true;
      a.doll.view.alpha = a.safeFor ? (Math.floor(a.safeFor / 90) % 2 ? 0.22 : 1) : 1;
      a.doll.sync(a, dt);
      if (!a.safeFor && Math.hypot(640 - a.x, this.heroY - a.y) < 58) {
        a.dead = true; a.moving = false; this.attackFor = 380; this.bites++; this.score += 100;
        this.burst(a.x, a.y - 55, 0xff4f63); this.playSound('infect', 0.6);
      }
    }
    this.updateInfected(dt);
    this.updateHideout(dt);
    if (this.people.some((a) => a.role === 'hunter')) this.updateDay(dt);
    if (!this.people.some((a) => a.role === 'citizen') && !this.hideout) this.spawnHideout();
  }

  private spawnHideout(): void {
    const roll = Math.random(), kind: Hideout['kind'] = roll < 0.55 ? 'bronze' : roll < 0.85 ? 'silver' : 'gold';
    const stats = kind === 'bronze' ? [4, 3, 150] : kind === 'silver' ? [7, 4, 300] : [11, 6, 550];
    const view = new Container(), sprite = new Sprite(); sprite.anchor.set(0.5, 1); sprite.scale.set(0.9);
    const name = this.label(0, -190, 23); name.text = `${kind.toUpperCase()} HIDEOUT`;
    const hpText = this.label(0, -154, 20);
    const shadow = new Sprite(this.ctx.assets.get('shadow')); shadow.anchor.set(0.5); shadow.position.set(0, -5);
    shadow.width = 120; shadow.height = 22; shadow.alpha = 0.48;
    view.addChild(shadow, sprite, name, hpText);
    const x = Math.random() < 0.5 ? -180 : W + 180, y = 350 + Math.random() * 270;
    const h: Hideout = { view, sprite, hpText, x, y, hp: stats[0]!, maxHp: stats[0]!, kind,
      citizens: stats[1]!, reward: stats[2]!, hitFor: 0 };
    view.position.set(x, y); view.zIndex = Math.round(y); this.hideout = h; this.view.addChild(view); this.syncHideout();
  }

  private updateHideout(dt: number): void {
    const h = this.hideout; if (!h) return;
    h.hitFor = Math.max(0, h.hitFor - dt);
    h.sprite.tint = h.hitFor ? 0xff3535 : 0xffffff;
    h.view.position.set(h.x + (h.hitFor ? (Math.random() - 0.5) * 12 : 0), h.y);
  }

  private syncHideout(): void {
    const h = this.hideout; if (!h) return;
    const frame = Math.min(7, Math.floor((1 - h.hp / h.maxHp) * 8));
    const source = this.ctx.assets.get(`hideout${h.kind[0]!.toUpperCase()}${h.kind.slice(1)}`);
    h.sprite.texture = new Texture({ source: source.source, frame: new Rectangle(frame * 256, 0, 256, 190) });
    h.hpText.text = `HP ${Math.max(0, h.hp)} / ${h.maxHp}`;
  }

  private useAttack(): void {
    if (this.phase === 'day' || this.attackCooldown || this.ended || this.lobby) return;
    this.attackCooldown = 480; this.attackFor = 380;
    const h = this.hideout; if (!h || Math.hypot(640 - h.x, this.heroY - h.y) > 145) return;
    const damage = 1 + this.upgrades.attack;
    h.hp -= damage; h.hitFor = 160; this.shakeFor = Math.max(this.shakeFor, 90);
    this.floatDamage(h.x, h.y - 120, damage); this.burst(h.x, h.y - 70, 0xffc857, 10);
    this.syncHideout();
    if (h.hp > 0) return;
    const { x, y, citizens, reward, kind } = h;
    this.score += reward; h.view.destroy({ children: true }); this.hideout = null;
    this.burst(x, y - 80, 0xffef8a, 18);
    const ambush = this.day >= 3 && Math.random() < Math.min(0.6, 0.2 + this.day * 0.05);
    if (!ambush) this.spawnCitizens(citizens, { x, y });
    else {
      const count = kind === 'gold' ? 4 : kind === 'silver' ? 3 : 2;
      for (let i = 0; i < count; i++) {
        const a = this.person('hunter', i % 2 ? 'soldier_2' : 'swat_1', 'male', i % 3 ? 'rifle_3_1' : 'meleeweapon_2_2');
        a.hunterType = i % 3 ? 'ranged' : 'melee'; a.attackVariant = a.hunterType === 'melee' ? 1 : 3;
        a.x = x + (Math.random() - 0.5) * 90; a.y = y + (Math.random() - 0.5) * 60; a.shotFor = 650;
      }
      const warning = this.label(x, y - 190, 34); warning.text = 'POLICE AMBUSH!'; warning.style.fill = 0xff4655;
      warning.zIndex = 1_200_000; this.view.addChild(warning); this.damageTexts.push({ view: warning, life: 1100 });
    }
  }

  private floatDamage(x: number, y: number, damage: number): void {
    const view = this.label(x, y, 30); view.text = `-${damage}`; view.style.fill = 0xffe36e;
    view.zIndex = 1_200_000; this.view.addChild(view); this.damageTexts.push({ view, life: 650 });
  }

  private updateDamageTexts(dt: number): void {
    for (const hit of [...this.damageTexts]) {
      hit.life -= dt; hit.view.y -= dt * 0.06; hit.view.alpha = Math.max(0, hit.life / 650);
      if (hit.life <= 0) { this.damageTexts.splice(this.damageTexts.indexOf(hit), 1); hit.view.destroy(); }
    }
  }

  private updateDay(dt: number): void {
    for (const a of this.people) {
      if (a.role !== 'hunter') continue;
      const dx = 640 - a.x, dy = this.heroY - a.y, len = Math.hypot(dx, dy) || 1;
      const melee = a.hunterType === 'melee';
      const speed = (melee ? 265 : 105) + this.day * (melee ? 18 : 15);
      const range = melee ? 58 : 390;
      if (len > range * 0.8) {
        a.x += dx / len * speed * dt / 1000; a.y += dy / len * speed * dt / 1000;
      }
      a.shotFor -= dt;
      if (!melee && len < range && a.shotFor <= 0) {
        a.shotFor = 850 + Math.random() * 350;
        a.attackingFor = 380; this.shoot(a.x, a.y - 70, dx, dy + 15);
      } else if (melee && len < 68 && a.shotFor <= 0) {
        a.shotFor = 900; a.attackingFor = 420; this.burst(a.x, a.y - 55, 0xff4a4a, 5);
        this.damageHero(1 + Math.floor((this.day - 1) / 5));
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
        this.damageHero(1 + Math.floor((this.day - 1) / 5));
      } else if (b.x < -30 || b.x > W + 30 || b.y < 250 || b.y > H + 30) this.removeBullet(b);
    }
  }

  private removeBullet(b: Bullet): void {
    const i = this.bullets.indexOf(b); if (i >= 0) this.bullets.splice(i, 1); b.view.destroy();
  }

  private damageHero(amount: number): void {
    if (this.rollFor || this.cooldown || this.ended) return;
    this.hp = Math.max(0, this.hp - amount); this.cooldown = 900; this.hurtFor = 280; this.shakeFor = 230;
    this.playSound('hurt', 0.55);
    this.burst(640, this.heroY - 55, 0xff2435, 14);
    this.floatDamage(640, this.heroY - 120, amount);
    if (!this.hp) this.finish(false);
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

  private readyFx(x: number, y: number, color: number): void {
    this.burst(x, y, color, 14);
    const fx = this.effects[this.effects.length - 1];
    if (fx) fx.view.zIndex = 1_100_000;
  }

  private useRoll(): void {
    if (this.rollCooldown || this.ended) return;
    this.rollFor = 440 + this.upgrades.slide * 60;
    this.rollCooldown = Math.max(1800, 3400 - this.upgrades.slide * 350);
    this.burst(640, this.heroY, 0x7ee8ff, 7); this.playSound('slide', 0.55);
  }

  private useDash(): void {
    if (this.dashCooldown || this.ended) return;
    this.dashFor = 260 + this.upgrades.dash * 45;
    this.dashCooldown = Math.max(1200, 2400 - this.upgrades.dash * 250);
    this.burst(640 - this.facing * 45, this.heroY, 0xffffff, 6); this.playSound('dash', 0.6);
  }

  private removePerson(a: Person): void {
    this.people.splice(this.people.indexOf(a), 1); a.doll.destroy();
  }

  private clearPeople(): void {
    for (const a of [...this.people]) this.removePerson(a);
    for (const a of this.infected) a.view.view.destroy({ children: true });
    this.infected.length = 0;
    for (const b of [...this.bullets]) this.removeBullet(b);
    if (this.hideout) { this.hideout.view.destroy({ children: true }); this.hideout = null; }
    for (const hit of this.damageTexts) hit.view.destroy();
    this.damageTexts.length = 0;
  }

  private swapPhase(): void {
    this.elapsed = 0; this.clearPeople();
    if (this.phase === 'night') {
      this.phase = 'day'; this.spawnHunters(); this.showTransition(`DAY ${this.day}`, false); return;
    }
    this.score += 500;
    this.day++; this.phase = 'night';
    this.spawnCitizens(10, { x: Math.random() < 0.5 ? -180 : W + 180, y: 470 });
    this.spawnHideout();
    this.showTransition(`NIGHT ${this.day}`, true);
  }

  private showTransition(label: string, night: boolean): void {
    const fx = new Container(); fx.zIndex = 4_500_000;
    const bg = new Graphics().rect(0, 0, W, H).fill(night ? 0x071426 : 0x83c9ff);
    const orb = new Graphics().circle(640, 270, 74).fill(night ? 0xe8efff : 0xffd54a);
    if (night) orb.circle(670, 245, 72).fill(0x071426);
    const text = this.label(640, 430, 58); text.text = label;
    const sub = this.label(640, 495, 24); sub.text = night ? 'THE HUNT BEGINS' : 'THE HUNTERS ARE COMING';
    fx.addChild(bg, orb, text, sub); fx.alpha = 0; this.lobby = fx; this.view.addChild(fx);
    let elapsed = 0;
    this.transitionTimer = window.setInterval(() => {
      elapsed += 30; fx.alpha = Math.sin(Math.min(1, elapsed / 900) * Math.PI);
      if (elapsed < 900) return;
      window.clearInterval(this.transitionTimer); this.transitionTimer = 0;
      fx.destroy({ children: true }); this.lobby = null;
      this.showLobby(`${label} · ${night ? 'HUNT' : 'SURVIVE'}`);
    }, 30);
  }

  private showTitle(): void {
    const title = new Container(); title.zIndex = 4_000_000;
    const art = new Sprite(this.ctx.assets.get('titleScreen'));
    art.width = W; art.height = H; title.addChild(art);
    const hit = new Graphics().rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.001 });
    this.titlePrompt = this.label(640, 670, 34); this.titlePrompt.text = 'TOUCH TO START';
    this.titlePrompt.style.fill = 0xffffff; this.titlePrompt.eventMode = 'none';
    const begin = () => {
      this.playSound('ui', 0.45); this.startBgm();
      this.titlePrompt = null; title.destroy({ children: true }); this.lobby = null;
      if (sessionStorage.getItem('limitless-intro-seen')) this.showLobby('NIGHT 1 · THE HUNT BEGINS');
      else this.showIntro();
    };
    hit.eventMode = 'static'; hit.cursor = 'pointer'; hit.on('pointerdown', begin);
    title.addChild(hit, this.titlePrompt); this.lobby = title; this.view.addChild(title);
  }

  private showIntro(): void {
    sessionStorage.setItem('limitless-intro-seen', '1');
    const intro = new Container(); intro.zIndex = 4_000_000;
    const bg = new Graphics().rect(0, 0, W, H).fill(0x000000);
    const textures = Object.fromEntries(['idle', 'walk', 'attack', 'damaged', 'death'].map((state) =>
      [state, this.ctx.assets.get(`z_${state}`)])) as Record<ZombieState, Texture>;
    const zombie = new ZombieView(textures, this.ctx.assets.get('shadow'));
    const line = this.label(640, 580, 29); line.style.wordWrap = true; line.style.wordWrapWidth = 1050;
    const story = '어느 날 눈을 뜨니 좀비였다.\n너무 쾌적한 좀비 인생, 더 많은 사람들이 누리게 도와줘야겠다.';
    intro.addChild(bg, zombie.view, line); this.lobby = intro; this.view.addChild(intro);
    let elapsed = 0;
    this.introTimer = window.setInterval(() => {
      elapsed += 30;
      line.text = story.slice(0, Math.floor(elapsed / 55));
      const jumping = elapsed >= 3900, jump = jumping && elapsed < 4800
        ? Math.sin((elapsed - 3900) / 900 * Math.PI) * 150 : 0;
      zombie.sync(640, 475 - jump, 1, jumping ? 'walk' : 'idle', 30, jumping ? 0 : 1);
      zombie.view.zIndex = 1;
      if (elapsed < 4800) return;
      window.clearInterval(this.introTimer); this.introTimer = 0;
      intro.destroy({ children: true }); this.lobby = null;
      this.showLobby('NIGHT 1 · THE HUNT BEGINS');
    }, 30);
  }

  private showLobby(title: string, selected?: UpgradeKey[]): void {
    this.lobby?.destroy({ children: true });
    const lobby = new Container(); lobby.zIndex = 3_000_000;
    const cover = new Graphics().rect(0, 0, W, H).fill({ color: 0x07101d, alpha: 0.94 });
    const resume = () => { this.playSound('ui', 0.45); this.startBgm(); lobby.destroy({ children: true }); this.lobby = null; };
    cover.eventMode = 'static'; cover.on('pointerdown', resume); lobby.addChild(cover);
    const heading = this.label(640, 105, 44); heading.text = title;
    const wallet = this.label(640, 160, 24); wallet.text = `UPGRADE POINTS · ${this.score}`;
    const close = new Graphics().circle(1200, 68, 34).fill(0x712331)
      .circle(1200, 68, 30).stroke({ color: 0xffffff, width: 3 });
    close.eventMode = 'static'; close.cursor = 'pointer'; close.on('pointerdown', resume);
    const closeText = this.label(1200, 66, 34); closeText.text = '×'; closeText.eventMode = 'none';
    lobby.addChild(heading, wallet, close, closeText);
    const allChoices: readonly [UpgradeKey, string, string, number][] = [
      ['run', 'RUN', 'MOVE SPEED +10%', 0x3c9f63],
      ['slide', 'SLIDE', 'LONGER · COOLDOWN ↓', 0x197b9b],
      ['dash', 'DASH', 'RANGE ↑ · COOLDOWN ↓', 0x9b4b19],
      ['attack', 'ATTACK', 'HIDEOUT DAMAGE +1', 0x9b2435],
      ['heal', 'RECOVER', 'RESTORE 1 HP', 0x6f3c9f],
    ];
    const keys = selected ?? [...allChoices].sort(() => Math.random() - 0.5).slice(0, 3).map(([key]) => key);
    const choices = keys.map((key) => allChoices.find(([candidate]) => candidate === key)!);
    choices.forEach(([key, name, detail, color], i) => {
      const heal = key === 'heal', level = heal ? 0 : this.upgrades[key], cost = heal ? 200 : 200 * (level + 1);
      const maxed = heal ? this.hp >= this.maxHp : level >= 5, x = 260 + i * 380;
      const card = new Graphics().roundRect(x - 155, 220, 310, 250, 22)
        .fill({ color, alpha: 0.65 }).stroke({ color: 0xffffff, width: 3, alpha: 0.55 });
      card.eventMode = 'static'; card.cursor = 'pointer';
      card.on('pointerdown', () => { this.playSound('ui', 0.45); this.buyUpgrade(key, title, keys); });
      const nameText = this.label(x, 275, 31); nameText.text = name;
      const levelText = this.label(x, 338, 25); levelText.text = heal ? `HP ${this.hp}/${this.maxHp}` : `LEVEL ${level}/5`;
      const detailText = this.label(x, 390, 17); detailText.text = detail;
      const costText = this.label(x, 438, 22);
      costText.text = maxed ? 'FULL' : `${cost} PTS`;
      costText.style.fill = maxed || this.score >= cost ? 0xffffff : 0xff7777;
      for (const text of [nameText, levelText, detailText, costText]) text.eventMode = 'none';
      lobby.addChild(card, nameText, levelText, detailText, costText);
    });
    const start = new Graphics().roundRect(490, 535, 300, 82, 18)
      .fill(0xd73547).stroke({ color: 0xffffff, width: 4 });
    start.eventMode = 'static'; start.cursor = 'pointer'; start.on('pointerdown', resume);
    const startText = this.label(640, 576, 30);
    startText.text = title === 'NIGHT 1 · THE HUNT BEGINS' ? 'START' : 'CONTINUE';
    startText.eventMode = 'none';
    lobby.addChild(start, startText); this.lobby = lobby; this.view.addChild(lobby);
  }

  private buyUpgrade(key: UpgradeKey, title: string, selected: UpgradeKey[]): void {
    if (key === 'heal') {
      if (this.hp >= this.maxHp || this.score < 200) return;
      this.score -= 200; this.hp++; this.showLobby(title, selected); this.upgradeFx(); this.drawHud(); return;
    }
    const level = this.upgrades[key], cost = 200 * (level + 1);
    if (level >= 5 || this.score < cost) return;
    this.score -= cost; this.upgrades[key]++; this.showLobby(title, selected); this.upgradeFx(); this.drawHud();
  }

  private upgradeFx(): void {
    if (!this.lobby) return;
    window.clearInterval(this.upgradeTimer);
    const fx = new Container();
    const rays = new Graphics();
    for (let i = 0; i < 16; i++) {
      const a = Math.PI * 2 * i / 16;
      rays.circle(Math.cos(a) * 72, Math.sin(a) * 72, 7).fill(0xffef78);
    }
    rays.circle(0, 0, 48).stroke({ color: 0xffffff, width: 7 });
    const text = this.label(0, 0, 27); text.text = 'UPGRADED!';
    fx.position.set(640, 190); fx.addChild(rays, text); this.lobby.addChild(fx);
    let elapsed = 0;
    this.upgradeTimer = window.setInterval(() => {
      elapsed += 30;
      if (fx.destroyed) { window.clearInterval(this.upgradeTimer); this.upgradeTimer = 0; return; }
      fx.scale.set(0.75 + elapsed / 900); fx.alpha = Math.max(0, 1 - elapsed / 600);
      if (elapsed < 600) return;
      window.clearInterval(this.upgradeTimer); this.upgradeTimer = 0; fx.destroy({ children: true });
    }, 30);
  }

  private finish(win: boolean): void {
    this.ended = true; this.dead = !win;
    const cover = new Graphics().rect(0, 0, W, H).fill(0x000000); cover.alpha = 0; cover.zIndex = 2_000_000;
    const card = new Container(); card.zIndex = 2_000_001; card.pivot.set(640, 360); card.position.set(640, 360);
    card.scale.set(0.72); card.alpha = 0;
    const panel = new Graphics().roundRect(260, 125, 760, 485, 28).fill({ color: 0x101b2c, alpha: 0.96 })
      .stroke({ color: 0xdce7f5, width: 4, alpha: 0.75 });
    const title = this.label(640, 205, 54); title.text = win ? 'YOU SURVIVED' : 'RUN OVER';
    const finalDay = this.label(640, 305, 32); finalDay.text = `FINAL DAY  ${this.day}`;
    const infected = this.label(640, 360, 32); infected.text = `INFECTED  ${this.bites}`;
    const result = this.label(640, 415, 28); result.text = `SCORE  ${this.score}`;
    for (const text of [finalDay, infected, result]) text.alpha = 0;
    const retry = new Graphics().roundRect(350, 485, 270, 78, 16).fill(0xd73547).stroke({ color: 0xffffff, width: 3 });
    const home = new Graphics().roundRect(660, 485, 270, 78, 16).fill(0x263b59).stroke({ color: 0xffffff, width: 3 });
    retry.eventMode = home.eventMode = 'none';
    retry.cursor = home.cursor = 'pointer';
    retry.on('pointerdown', () => {
      this.playSound('ui', 0.45);
      sessionStorage.setItem('limitless-retry', '1'); location.reload();
    });
    home.on('pointerdown', () => {
      this.playSound('ui', 0.45);
      sessionStorage.removeItem('limitless-retry'); location.reload();
    });
    const retryText = this.label(485, 524, 26); retryText.text = 'RETRY';
    const homeText = this.label(795, 524, 26); homeText.text = 'TITLE';
    retryText.eventMode = homeText.eventMode = 'none';
    card.addChild(panel, title, finalDay, infected, result, retry, home, retryText, homeText);
    this.view.addChild(cover, card);
    let elapsed = 0;
    this.resultTimer = window.setInterval(() => {
      elapsed += 30; cover.alpha = Math.min(0.72, elapsed / 700);
      card.alpha = Math.min(1, Math.max(0, (elapsed - 180) / 420));
      card.scale.set(0.72 + 0.28 * Math.min(1, Math.max(0, (elapsed - 180) / 420)));
      finalDay.alpha = Math.min(1, Math.max(0, (elapsed - 600) / 180));
      infected.alpha = Math.min(1, Math.max(0, (elapsed - 760) / 180));
      result.alpha = Math.min(1, Math.max(0, (elapsed - 920) / 180));
      if (elapsed < 1150) return;
      window.clearInterval(this.resultTimer); this.resultTimer = 0;
      retry.eventMode = home.eventMode = 'static';
    }, 30);
  }

  onExit(): void {
    if (this.transitionTimer) window.clearInterval(this.transitionTimer);
    if (this.upgradeTimer) window.clearInterval(this.upgradeTimer);
    if (this.resultTimer) window.clearInterval(this.resultTimer);
    if (this.introTimer) window.clearInterval(this.introTimer);
    this.audio.bgm?.pause();
    window.removeEventListener('keydown', this.onKeyDown);
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
    roll.eventMode = 'static'; roll.cursor = 'pointer'; roll.on('pointerdown', () => this.useRoll());
    this.rollButton = roll;
    this.rollText = this.label(1050, 590, 18); this.rollText.text = 'SLIDE';
    const dash = new Graphics().circle(1170, 590, 54).fill({ color: 0x9b4b19, alpha: 0.9 })
      .circle(1170, 590, 48).stroke({ color: 0xffd49d, width: 4 });
    dash.eventMode = 'static'; dash.cursor = 'pointer'; dash.on('pointerdown', () => this.useDash());
    this.dashButton = dash;
    this.dashText = this.label(1170, 590, 18); this.dashText.text = 'DASH';
    const attack = new Graphics().circle(1110, 455, 58).fill({ color: 0xa52331, alpha: 0.95 })
      .circle(1110, 455, 52).stroke({ color: 0xffe8b0, width: 4 });
    attack.eventMode = 'static'; attack.cursor = 'pointer'; attack.on('pointerdown', () => this.useAttack());
    this.attackButton = attack;
    this.attackText = this.label(1110, 455, 18); this.attackText.text = 'ATTACK'; this.attackText.eventMode = 'none';
    const slideKey = this.label(1050, 518, 22); slideKey.text = '[ X ]';
    const dashKey = this.label(1170, 518, 22); dashKey.text = '[ C ]';
    const attackKey = this.label(1110, 382, 22); attackKey.text = '[ Z ]';
    this.minimap = new Graphics();
    const hud = [panel, this.moon, this.sun, this.phaseText, this.timer, track, this.fill,
      this.scoreText, this.status, help, attack, this.attackText, attackKey, roll, this.rollText, slideKey,
      dash, this.dashText, dashKey,
      this.minimap, this.joyBase, this.joyKnob];
    for (const child of hud) child.zIndex = 1_000_000;
    this.view.addChild(...hud);
  }

  private label(x: number, y: number, size: number, family = 'sans-serif'): Text {
    const text = new Text({ text: '', style: { fill: 0xffffff, fontFamily: family, fontSize: size,
      fontWeight: 'bold', stroke: { color: 0x111111, width: 5 } } });
    text.anchor.set(0.5); text.position.set(x, y); return text;
  }

  private playSound(name: string, volume = 0.5): void {
    const source = this.audio[name]; if (!source) return;
    const sound = source.cloneNode() as HTMLAudioElement; sound.volume = volume;
    void sound.play().catch(() => undefined);
  }

  private startBgm(): void {
    void this.audio.bgm?.play().catch(() => undefined);
  }

  private drawHud(): void {
    const duration = this.phase === 'night' ? NIGHT : DAY;
    const left = Math.max(0, Math.ceil((duration - this.elapsed) / 1000));
    this.shade.alpha = this.phase === 'night' ? 0.5 : 0.08;
    this.moon.visible = this.phase === 'night'; this.sun.visible = this.phase === 'day';
    this.phaseText.text = this.phase === 'night' ? 'HUNT' : 'SURVIVE';
    this.phaseText.style.fill = left <= 5 ? 0xff655f : 0xffffff;
    this.timer.text = `00:${String(left).padStart(2, '0')}`; this.fill.width = 120 * (1 - this.elapsed / duration);
    this.scoreText.text = `DAY ${this.day}   SCORE ${this.score}   HP ${'♥'.repeat(this.hp)}`;
    const hunters = this.people.filter((a) => a.role === 'hunter').length;
    const shelter = this.hideout ? `HIDEOUT ${this.hideout.x < 640 ? '◀' : '▶'}  ·  ` : '';
    this.status.text = this.phase === 'night' ? `${shelter}${this.bites} INFECTED`
      : `${hunters} HUNTERS  ·  SURVIVE UNTIL SUNSET`;
    this.rollText.text = this.rollCooldown ? `SLIDE\n${(this.rollCooldown / 1000).toFixed(1)}` : 'SLIDE';
    this.dashText.text = this.dashCooldown ? `DASH\n${(this.dashCooldown / 1000).toFixed(1)}` : 'DASH';
    this.rollButton.alpha = this.rollCooldown ? 0.3 : 1;
    this.dashButton.alpha = this.dashCooldown ? 0.3 : 1;
    this.rollText.alpha = this.rollCooldown ? 0.38 : 1;
    this.dashText.alpha = this.dashCooldown ? 0.38 : 1;
    const attackLocked = this.phase === 'day';
    this.attackText.text = attackLocked ? 'DAY\nLOCKED' : this.attackCooldown ? `ATTACK\n${(this.attackCooldown / 1000).toFixed(1)}` : 'ATTACK';
    this.attackButton.alpha = attackLocked ? 0.16 : this.attackCooldown ? 0.3 : 1;
    this.attackText.alpha = attackLocked ? 0.28 : this.attackCooldown ? 0.38 : 1;
    this.drawMinimap();
  }

  private drawMinimap(): void {
    const map = this.minimap, x = 20, y = 72, w = 200, h = 125;
    map.clear().roundRect(x, y, w, h, 10).fill({ color: 0x02060c, alpha: 0.72 })
      .roundRect(x, y, w, h, 10).stroke({ color: 0x8ca0b8, width: 2, alpha: 0.7 });
    const dot = (px: number, py: number, color: number, radius = 3): void => {
      const dx = x + 6 + Math.max(0, Math.min(1, px / W)) * (w - 12);
      const dy = y + 6 + Math.max(0, Math.min(1, (py - 300) / (H - 335))) * (h - 12);
      map.circle(dx, dy, radius).fill(color);
    };
    for (const a of this.people) if (!a.dead) dot(a.x, a.y, a.role === 'hunter' ? 0xff414d : 0xffffff);
    for (const a of this.infected) dot(a.x, a.y, 0x5fd35f);
    if (this.hideout) dot(this.hideout.x, this.hideout.y,
      this.hideout.kind === 'gold' ? 0xffd43b : this.hideout.kind === 'silver' ? 0x62d9ff : 0xff8b3d,
      this.hideout.kind === 'gold' ? 9 : this.hideout.kind === 'silver' ? 8 : 7);
    dot(640, this.heroY, 0x39ff87, 5);
  }
}

async function main(): Promise<void> {
  const parent = document.querySelector<HTMLElement>('#app');
  if (!parent) throw new Error('#app not found');
  const engine = await createEngine({ parent, design: { width: W, height: H }, background: 0x111827 });
  const retry = sessionStorage.getItem('limitless-retry') === '1';
  sessionStorage.removeItem('limitless-retry');
  await engine.start(new GameScene(retry));
}
void main();
