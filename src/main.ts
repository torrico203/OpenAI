import { assetUrl, createEngine, type EngineContext, type Scene } from 'pixiengine';
import { AnimatedSprite, Container, Graphics, Sprite, Text, TilingSprite } from 'pixi.js';
import './style.css';

const W = 1280, H = 720, NIGHT = 40_000, DAY = 50_000, LAST = 3;
type Actor = AnimatedSprite & { vx: number; vy: number };

class GameScene implements Scene {
  readonly view = new Container();
  private ctx!: EngineContext;
  private hero!: AnimatedSprite;
  private shade!: Graphics;
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
  private citizens: Actor[] = [];
  private hunters: Actor[] = [];
  private phase: 'night' | 'day' = 'night';
  private elapsed = 0;
  private day = 1;
  private bites = 0;
  private score = 0;
  private hp = 3;
  private cooldown = 0;
  private ended = false;

  async onEnter(ctx: EngineContext): Promise<void> {
    this.ctx = ctx;
    await ctx.assets.load({
      far: assetUrl('assets/field/far.png'),
      mid: assetUrl('assets/field/mid.png'),
      near: assetUrl('assets/field/near.png'),
      people: assetUrl('assets/player.json'),
      zombie: assetUrl('assets/zombie.json'),
      panel: assetUrl('assets/ui/panel.png'),
      track: assetUrl('assets/ui/gauge_track.png'),
      fill: assetUrl('assets/ui/gauge_fill.png'),
      moon: assetUrl('assets/ui/menu_night.png'),
      joyBase: assetUrl('assets/ui/joy_base.png'),
      joyKnob: assetUrl('assets/ui/joy_knob.png'),
    });
    this.view.sortableChildren = true;
    for (const [alias, z] of [['far', -300], ['mid', -200], ['near', -100]] as const) {
      const texture = ctx.assets.get(alias);
      const layer = new TilingSprite({ texture, width: W, height: H });
      layer.tileScale.set(H / texture.height);
      layer.zIndex = z;
      this.view.addChild(layer);
    }
    this.shade = new Graphics().rect(0, 0, W, H).fill(0x071426);
    this.shade.zIndex = -50;
    this.hero = this.actor('zombie', 640, 500, 0.72);
    this.view.addChild(this.shade, this.hero);
    this.makeHud();
    this.spawnCitizens();
    this.drawHud();
  }

  update(dt: number): void {
    if (this.ended) return;
    this.elapsed += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.moveHero(dt);
    if (this.phase === 'night') this.updateNight(dt); else this.updateDay(dt);
    if (this.elapsed >= (this.phase === 'night' ? NIGHT : DAY)) this.swapPhase();
    this.drawHud();
  }

  private makeHud(): void {
    const panel = this.ctx.assets.makeSprite('panel', { anchor: 0, x: 1090, y: 24 });
    panel.width = 160; panel.height = 210;
    const track = this.ctx.assets.makeSprite('track', { anchor: 0, x: 1110, y: 191 });
    track.width = 120; track.height = 13;
    this.fill = this.ctx.assets.makeSprite('fill', { anchor: 0, x: 1110, y: 191 });
    this.fill.height = 13;
    this.moon = this.ctx.assets.makeSprite('moon', { x: 1170, y: 72, scale: 0.75 });
    this.sun = new Graphics().circle(1170, 72, 25).fill(0xffd54a);
    this.phaseText = this.label(1170, 116, 24);
    this.timer = this.label(1170, 154, 31, 'monospace');
    this.scoreText = this.label(24, 28, 25); this.scoreText.anchor.set(0);
    this.status = this.label(640, 650, 25);
    const help = this.label(640, 690, 18); help.text = 'WASD / ARROWS / LEFT-SIDE TOUCH';
    this.joyBase = this.ctx.assets.makeSprite('joyBase', { scale: 0.75 });
    this.joyKnob = this.ctx.assets.makeSprite('joyKnob', { scale: 0.75 });
    this.joyBase.visible = false;
    this.joyKnob.visible = false;
    this.view.addChild(panel, this.moon, this.sun, this.phaseText, this.timer, track,
      this.fill, this.scoreText, this.status, help, this.joyBase, this.joyKnob);
    for (const child of [panel, this.moon, this.sun, this.phaseText, this.timer, track,
      this.fill, this.scoreText, this.status, help, this.joyBase, this.joyKnob]) child.zIndex = 1_000_000;
  }

  private label(x: number, y: number, size: number, family = 'sans-serif'): Text {
    const t = new Text({ text: '', style: { fill: 0xffffff, fontFamily: family,
      fontSize: size, fontWeight: 'bold', stroke: { color: 0x111111, width: 5 } } });
    t.anchor.set(0.5); t.position.set(x, y); return t;
  }

  private actor(sheet: string, x: number, y: number, scale: number): Actor {
    const a = new AnimatedSprite(this.ctx.assets.getSheet(sheet).animations.move!) as Actor;
    a.anchor.set(0.5); a.position.set(x, y); a.scale.set(scale);
    a.animationSpeed = 0.14; a.vx = 0; a.vy = 0; a.zIndex = Math.round(y); a.play(); return a;
  }

  private spawnCitizens(): void {
    const colors = [0xffffff, 0xffd1b3, 0xb8e0ff, 0xffc5dd, 0xd8ffc4, 0xffe59b];
    for (let i = 0; i < 10; i++) {
      const a = this.actor('people', 70 + Math.random() * 1140, 320 + Math.random() * 330, 0.55);
      a.tint = colors[i % colors.length]!;
      a.vx = (Math.random() - 0.5) * 80; a.vy = (Math.random() - 0.5) * 80;
      this.citizens.push(a); this.view.addChild(a);
    }
  }

  private spawnHunters(): void {
    const count = Math.min(6, 1 + Math.floor(this.bites / 3));
    for (let i = 0; i < count; i++) {
      const a = this.actor('people', i % 2 ? 1210 : 70, 330 + Math.random() * 290, 0.66);
      a.tint = i === count - 1 && count >= 4 ? 0xffd36b : 0xffffff;
      this.hunters.push(a); this.view.addChild(a);
    }
  }

  private moveHero(dt: number): void {
    const pointer = this.ctx.input.pointer;
    if (pointer.down) {
      const p = this.ctx.toDesign(this.ctx.input.pointer.x, this.ctx.input.pointer.y);
      if (!this.joystickActive && p.x < W * 0.6) {
        this.joystickActive = true;
        this.joyX = p.x; this.joyY = p.y;
        this.joyBase.position.set(p.x, p.y);
        this.joyKnob.position.set(p.x, p.y);
        this.joyBase.visible = true; this.joyKnob.visible = true;
      }
      if (this.joystickActive) {
        const dx = p.x - this.joyX, dy = p.y - this.joyY;
        const len = Math.hypot(dx, dy) || 1, reach = Math.min(len, 52);
        this.joyKnob.position.set(this.joyX + dx / len * reach, this.joyY + dy / len * reach);
        this.ctx.input.setJoystick(dx / len * reach / 52, dy / len * reach / 52);
      }
    } else if (this.joystickActive) {
      this.joystickActive = false;
      this.joyBase.visible = false; this.joyKnob.visible = false;
      this.ctx.input.setJoystick(0, 0);
    }
    const { x, y } = this.ctx.input.axis();
    const len = Math.hypot(x, y);
    if (len) {
      const speed = this.phase === 'night' ? 230 : 250;
      this.hero.x += x / len * speed * dt / 1000;
      this.hero.y += y / len * speed * dt / 1000;
      this.hero.scale.x = Math.abs(this.hero.scale.x) * (x < 0 ? -1 : 1);
    }
    this.hero.x = Math.max(35, Math.min(W - 35, this.hero.x));
    this.hero.y = Math.max(300, Math.min(H - 35, this.hero.y));
    this.hero.zIndex = Math.round(this.hero.y);
  }

  private updateNight(dt: number): void {
    for (const a of [...this.citizens]) {
      a.x += a.vx * dt / 1000; a.y += a.vy * dt / 1000;
      if (a.x < 35 || a.x > W - 35) a.vx *= -1;
      if (a.y < 300 || a.y > H - 35) a.vy *= -1;
      a.zIndex = Math.round(a.y);
      if (this.distance(this.hero, a) < 48) {
        this.citizens.splice(this.citizens.indexOf(a), 1); a.destroy();
        this.bites++; this.score += 100;
      }
    }
    if (!this.citizens.length) this.spawnCitizens();
  }

  private updateDay(dt: number): void {
    for (const a of this.hunters) {
      const dx = this.hero.x - a.x, dy = this.hero.y - a.y, len = Math.hypot(dx, dy) || 1;
      const speed = 105 + this.day * 15;
      a.x += dx / len * speed * dt / 1000; a.y += dy / len * speed * dt / 1000;
      a.scale.x = Math.abs(a.scale.x) * (dx < 0 ? -1 : 1);
      a.zIndex = Math.round(a.y);
      if (len < 52 && !this.cooldown) {
        this.hp--; this.cooldown = 1200; this.hero.alpha = 0.35;
        setTimeout(() => { if (!this.hero.destroyed) this.hero.alpha = 1; }, 180);
        if (!this.hp) this.finish(false);
      }
    }
  }

  private swapPhase(): void {
    this.elapsed = 0;
    if (this.phase === 'night') {
      this.phase = 'day'; this.clear(this.citizens); this.spawnHunters(); return;
    }
    this.score += 500; this.clear(this.hunters);
    if (this.day >= LAST) this.finish(true);
    else { this.day++; this.phase = 'night'; this.spawnCitizens(); }
  }

  private clear(list: Actor[]): void { for (const a of list) a.destroy(); list.length = 0; }

  private finish(win: boolean): void {
    this.ended = true;
    const cover = new Graphics().rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.78 });
    cover.zIndex = 2_000_000;
    const title = this.label(640, 300, 54); title.text = win ? 'YOU SURVIVED' : 'HUNTED DOWN';
    const result = this.label(640, 380, 28); result.text = `SCORE ${this.score}  ·  BITES ${this.bites}`;
    title.zIndex = 2_000_001; result.zIndex = 2_000_001;
    this.view.addChild(cover, title, result);
  }

  private drawHud(): void {
    const duration = this.phase === 'night' ? NIGHT : DAY;
    const left = Math.max(0, Math.ceil((duration - this.elapsed) / 1000));
    this.shade.alpha = this.phase === 'night' ? 0.5 : 0.08;
    this.moon.visible = this.phase === 'night'; this.sun.visible = this.phase === 'day';
    this.phaseText.text = this.phase === 'night' ? 'HUNT' : 'SURVIVE';
    this.phaseText.style.fill = left <= 5 ? 0xff655f : 0xffffff;
    this.timer.text = `00:${String(left).padStart(2, '0')}`;
    this.fill.width = 120 * (1 - this.elapsed / duration);
    this.scoreText.text = `DAY ${this.day}/${LAST}   SCORE ${this.score}   HP ${'♥'.repeat(this.hp)}`;
    this.status.text = this.phase === 'night'
      ? `BITE THE LIVING  ·  ${this.bites} INFECTED`
      : `${this.hunters.length} HUNTERS  ·  SURVIVE UNTIL SUNSET`;
  }

  private distance(a: Sprite, b: Sprite): number { return Math.hypot(a.x - b.x, a.y - b.y); }
}

async function main(): Promise<void> {
  const parent = document.querySelector<HTMLElement>('#app');
  if (!parent) throw new Error('#app not found');
  const engine = await createEngine({ parent, design: { width: W, height: H }, background: 0x111827 });
  await engine.start(new GameScene());
}
void main();
