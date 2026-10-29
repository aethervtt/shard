# @aethervtt/shard-cli

The `shard` command for [Shard](https://github.com/aethervtt/shard), a WebGPU-first 2D/3D game
engine in TypeScript built for AI-driven authoring.

```sh
npx @aethervtt/shard-cli init my-game   # a project pinned to this engine version
cd my-game && npm install
npx shard dev                           # play it in a browser; saves hot reload in place
npx shard test                          # gameplay tests in tests/
npx shard validate                      # manifest, assets and scenes: every error with a path
npx shard run --frames 600              # headless run with a deterministic world hash
npx shard docs                          # agent docs: AGENTS.md, .agents/, JSON schemas
npx shard mcp                           # MCP server for this project
```

Multiplayer projects (`project.net(...)`):

```sh
npx shard server --port 7000                       # a dedicated server (WebSocket)
npx shard dev --connect ws://127.0.0.1:7000        # play as a client of it
npx shard lobby --port 7500                        # room codes for peer-to-peer games
npx shard dev --lobby ws://127.0.0.1:7500          # then ?host, or ?join=<code>
npx shard run --net clients=2,latency=0.08         # a server and clients headless; hashes
```

Every command takes `--json`. `npx shard --help` lists them all. Browser-driven commands
(`capture`, `audio preview`) need Playwright: `npm install -D playwright && npx playwright install
chromium`.

The unscoped `shard` package on npm is unrelated: run `npx @aethervtt/shard-cli` until the CLI is
installed in your project, then `npx shard`.
