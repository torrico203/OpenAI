# OpenAI 5-hour game challenge

- Default stack: TypeScript, Vite, PixiJS v8, and the local `pixiengine` package at `../pixiEngine`.
- Use Phaser instead only when physics is central to the game.
- Do not copy or recreate the shared engine inside this project.
- Optimize for a playable build within five hours; avoid speculative systems and dependencies.
- Keep game-specific code in this project and reusable engine fixes in `../pixiEngine`.
- Before delivery, run `npm run build` and manually verify the core loop in a browser.
