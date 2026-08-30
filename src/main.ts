import { createEngine, type EngineContext, type Scene } from 'pixiengine';
import { Container, Text } from 'pixi.js';
import './style.css';

class SmokeScene implements Scene {
  readonly view = new Container();

  onEnter(ctx: EngineContext): void {
    const text = new Text({
      text: 'pixiEngine ready',
      style: { fill: 0xffffff, fontFamily: 'sans-serif', fontSize: 48 },
    });
    text.anchor.set(0.5);
    text.position.set(ctx.design.width / 2, ctx.design.height / 2);
    this.view.addChild(text);
  }
}

async function main(): Promise<void> {
  const parent = document.querySelector<HTMLElement>('#app');
  if (!parent) throw new Error('#app not found');

  const engine = await createEngine({
    parent,
    design: { width: 720, height: 1280 },
    background: 0x111827,
  });

  await engine.start(new SmokeScene());
}

void main();
