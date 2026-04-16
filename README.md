# Reddit or Robot

A small web game. Each round shows two threads side-by-side — one from
[**Reddit**](https://www.reddit.com) (a human social network) and one from
[**Moltbook**](https://www.moltbook.com) (a social network for AI agents).
You guess which is the robot.

Built with Next.js as a fully static export — no runtime backend.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

The repo ships with a synthetic sample in `data/posts.json` so the game is
playable out of the box. To replace it with live content, see below.

## Refreshing the data

Moltbook's public API requires a Bearer token, so content is scraped
server-side and committed as static JSON. Reddit is fetched via its public
`.json` endpoints (no auth).

```bash
export MOLTBOOK_API_KEY=molt_…
npm run scrape
```

This writes `data/posts.json` with up to 150 posts per source. Commit the
file so the static build picks it up.

Configured subreddits (see `scripts/scrape.ts`): `todayilearned`,
`Showerthoughts`, `unpopularopinion`, `CasualConversation`,
`NoStupidQuestions`, `AskReddit`, `changemyview`. The mix is chosen so
each Reddit post has a plausible Moltbook analog — both sides can
plausibly contribute TIL-style factoids, idle musings, opinions, and
open questions. Formats where only one side would naturally post
(e.g. "AITA" personal-life scenarios) are avoided on purpose.

The scraper also filters out posts whose text gives away the source
outright: Reddit bodies containing `edit:`/`update:` sections or family
references, Moltbook bodies mentioning `my owner`, `as an AI`, `token
budget`, `submolt`, etc. Title prefixes that are format-specific
(`AITA`, `ELI5`, `[serious]`) are stripped so the prefix itself isn't a
tell.

## Build & deploy

```bash
npm run build        # outputs static site to ./out
```

The `out/` directory is a fully static site — drop it on GitHub Pages,
Netlify, Vercel (static), S3, or any static host. No server required.

## Project layout

```
app/             Next.js App Router entry (layout, page, global CSS)
components/      Game.tsx — client-side pairing, guess, score
lib/             Shared TypeScript types
data/posts.json  Pool of posts by source (committed)
scripts/         scrape.ts — refreshes posts.json
```

## Notes

- Pairs and left/right randomization happen in a `useEffect`, not during
  render, so server-rendered HTML matches client hydration.
- The Moltbook response shape isn't pinned down in the public docs; the
  scraper tries a few common field names (`content`/`body`/`text`, etc.)
  and falls back defensively. If fields are missing after a real scrape,
  check the raw response shape logged on first run and adjust
  `fetchMoltbook` in `scripts/scrape.ts`.
