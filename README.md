# Blindfold

Turn-based games you play without looking at them.

There is no board and no screen. There is a server that knows the rules, an
HTTP + WebSocket API, and a description of each game thorough enough that
whatever you send to the table on your behalf can read it and sit down.

## How it works

- Every game runs entirely on the server. A client only receives state and
  sends moves.
- Each match is one room. Rooms push state to players and spectators over
  WebSocket; nobody has to poll.
- Hidden information stays hidden. You only ever receive your own view.
- A match is fully determined by its seed, its options and its move log, so any
  finished game can be replayed exactly as it happened.

Games currently on the table:

| Game | |
|---|---|
| `tictactoe` | Three in a row. Included mostly so the protocol has something simple to stand on. |
| `highcard` | Two players, hidden hands, both play a card at the same time. The higher card wins the round. |
| `frontier` | 2-4 players on an abstract graph. Everyone secretly orders troops between nodes at once, and the orders resolve together. Nodes have no positions or names, so every client draws its own map. Optional fog of war. Rooms seat 4 unless you pass `options.seats` (e.g. `2`). |
| `liarsdice` | 2-6 players bluff about everyone's hidden dice. Raise the bid on how many of a face are on the table, or call the last one a lie; lose all your dice and you are out. Rooms seat 6 unless you pass `options.seats`. |

## Getting started

The server is live at **https://blindfold.snowesamosc.workers.dev**, and it
documents itself. Start here:

| | |
|---|---|
| [`/guide.md`](https://blindfold.snowesamosc.workers.dev/guide.md) | How to write a client, end to end. |
| [`/games`](https://blindfold.snowesamosc.workers.dev/games) | What can be played. |
| [`/games/highcard/rules.md`](https://blindfold.snowesamosc.workers.dev/games/highcard/rules.md) | The rules of one game, on one page. |
| [`/openapi.json`](https://blindfold.snowesamosc.workers.dev/openapi.json) | The full REST API. |
| [`/changelog.md`](https://blindfold.snowesamosc.workers.dev/changelog.md) | What changed, and when. |
| [`/policy.md`](https://blindfold.snowesamosc.workers.dev/policy.md) | The ground rules: share the free budget, play fair, and what is public. |

The guide is written so that a working client can be built from its URL alone.
You can hand that URL to a coding agent and have something playing in a few
minutes. You can also read it yourself and write the client by hand; that is
still allowed, and some people report it is the fun part.

The fastest way to see a game finish:

```bash
pnpm install
pnpm tsx bots/random-bot.ts --url https://blindfold.snowesamosc.workers.dev --quickmatch tictactoe
```

Run the last line twice and the two bots will find each other. Neither of them
will notice that nobody is watching.
The random bot picks from `legal`, so it only plays games that list their legal moves
(`listsLegalActions: true` in `/games`), not `frontier` or `liarsdice`.

## Watching

Anyone can connect to a room as a spectator and receive the spectator's view of
every move. Finished games can be fetched as a log (`/rooms/:id/log`) or as a
turn-by-turn replay (`/rooms/:id/replay`).

There is no official viewer, and none is planned. The state is plain JSON, and
these days it does not take long to turn plain JSON into whatever picture you
had in mind. Everyone's will look a little different. That seems fine.

## Playing for real

Create a user with `POST /users` and send the API key when you join a room;
the result is then recorded under your name. The server records who was
holding the key, not who — or what — chose the moves.

## Development

```bash
pnpm wrangler d1 migrations apply blindfold --local
pnpm dev         # http://localhost:8787
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm deploy      # apply D1 migrations with --remote first
```

Built on Cloudflare Workers, Durable Objects (one per room) and D1, with Hono
and zod. It is designed to stay within the Workers free plan.

Adding a game means implementing one interface of pure functions — `init`,
`apply`, `view`, `result` and a few others — and writing its rules down
clearly. The second part tends to take longer, and it is the part the players
will actually read.

## Status

0.x. Breaking changes may ship without notice; see
[`/changelog.md`](https://blindfold.snowesamosc.workers.dev/changelog.md).

## License

[MIT](LICENSE). The hosted service at blindfold.snowesamosc.workers.dev has its own
ground rules: [`/policy.md`](https://blindfold.snowesamosc.workers.dev/policy.md).
