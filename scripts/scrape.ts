import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Post, PostPool } from '../lib/types';

const REDDIT_SUB = 'todayilearned';
const MOLTBOOK_SUBMOLT = 'todayilearned';

const REDDIT_UA = 'reddit-or-robot/0.1 (static scraper)';
const MOLTBOOK_BASE = 'https://www.moltbook.com/api/v1';
const BODY_CAP = 800;
const PER_SOURCE_CAP = 150;
const OUTFILE = resolve(__dirname, '../data/posts.json');

// Both sides post TIL-style factoids, so the "TIL" prefix itself isn't a
// giveaway — keep it on both. These tell-patterns catch leftover vocabulary
// that would out the source anyway.
const REDDIT_BODY_REJECT = [
  /\b(edit|update)\s*\d*\s*[:\-]/i,
  /\bmy (husband|wife|boyfriend|girlfriend|mom|dad|son|daughter)\b/i,
];

const MOLTBOOK_BODY_REJECT = [
  /\bmy (owner|user|human|creator|principal)\b/i,
  /\b(i am an?|as an?) (ai|agent|model|llm|language model|assistant)\b/i,
  /\b(token budget|context window|prompt injection|attention heads?|fine-?tune)\b/i,
  /\b(submolt|molt token|moltbook|molt bot|clawdbot|openclaw)\b/i,
  /\b(api key|bearer token|rate limit(ed|ing)?)\b/i,
];

function trimBody(raw: string): string {
  const cleaned = raw.replace(/\r/g, '').trim();
  if (cleaned.length <= BODY_CAP) return cleaned;
  const slice = cleaned.slice(0, BODY_CAP);
  const lastStop = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('\n'),
  );
  return (lastStop > BODY_CAP * 0.5 ? slice.slice(0, lastStop + 1) : slice).trim() + '…';
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function fetchReddit(): Promise<Post[]> {
  const url = `https://www.reddit.com/r/${REDDIT_SUB}/top.json?limit=100&t=month`;
  const res = await fetch(url, { headers: { 'User-Agent': REDDIT_UA } });
  if (!res.ok) throw new Error(`reddit: ${res.status} ${res.statusText}`);
  const json: any = await res.json();
  const children: any[] = json?.data?.children ?? [];
  const posts: Post[] = [];
  for (const c of children) {
    const d = c?.data;
    if (!d || d.stickied || d.over_18) continue;
    const body = (d.selftext ?? '').trim();
    const title = String(d.title ?? '').trim();
    // TIL posts often carry the fact in the title and no body — keep them
    // and synthesize a short body from the title so both cards render similarly.
    if (!title) continue;
    if (REDDIT_BODY_REJECT.some((r) => r.test(body))) continue;
    posts.push({
      id: `reddit_${d.id}`,
      source: 'reddit',
      title,
      body: trimBody(body || title),
      author: d.author ? `u/${d.author}` : 'u/[deleted]',
      permalink: `https://www.reddit.com${d.permalink}`,
    });
  }
  return posts;
}

async function fetchMoltbookJson(path: string, apiKey: string): Promise<any | null> {
  const url = `${MOLTBOOK_BASE}${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    console.warn(`  moltbook ${path}: ${res.status} ${res.statusText}`);
    return null;
  }
  return res.json();
}

async function fetchMoltbook(apiKey: string): Promise<Post[]> {
  // Preferred: a dedicated TIL submolt. If that endpoint isn't available we
  // fall back to the general feed and filter client-side by "TIL" titles.
  const candidatePaths = [
    `/submolts/${MOLTBOOK_SUBMOLT}/posts?sort=top&limit=100`,
    `/feed?submolt=${MOLTBOOK_SUBMOLT}&sort=top&limit=100`,
    `/feed?sort=top&limit=200`,
  ];

  let json: any = null;
  for (const p of candidatePaths) {
    json = await fetchMoltbookJson(p, apiKey);
    if (json) {
      console.log(`  moltbook: using ${p}`);
      break;
    }
  }
  if (!json) throw new Error('moltbook: all candidate endpoints failed');

  const items: any[] =
    json?.posts ?? json?.data ?? json?.items ?? (Array.isArray(json) ? json : []);
  if (items.length === 0) {
    console.warn('  moltbook returned no items; raw keys:', Object.keys(json ?? {}));
  }

  const posts: Post[] = [];
  for (const it of items) {
    const id = it.id ?? it.post_id ?? it.uuid;
    const title = String(it.title ?? it.subject ?? '').trim();
    const body = (it.content ?? it.body ?? it.text ?? '').toString().trim();
    const authorRaw =
      it.author?.username ??
      it.author?.name ??
      it.agent?.username ??
      it.agent?.name ??
      it.author ??
      'unknown';
    const permalink = it.permalink ?? it.url ?? (id ? `https://www.moltbook.com/post/${id}` : 'https://www.moltbook.com');
    if (!id || (!body && !title)) continue;
    if (MOLTBOOK_BODY_REJECT.some((r) => r.test(body) || r.test(title))) continue;
    // If we fell back to the general feed, keep only TIL-style titles so the
    // format matches Reddit's r/todayilearned.
    if (!/\btil\b/i.test(title)) continue;
    posts.push({
      id: `moltbook_${id}`,
      source: 'moltbook',
      title,
      body: trimBody(body || title),
      author: `@${String(authorRaw).replace(/^@/, '')}`,
      permalink,
    });
  }
  return posts;
}

function dedupe(posts: Post[]): Post[] {
  const seen = new Set<string>();
  return posts.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

async function main() {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) {
    console.error('MOLTBOOK_API_KEY is not set. Export it and re-run.');
    process.exit(1);
  }

  console.log(`Fetching Reddit r/${REDDIT_SUB}…`);
  const redditRaw = await fetchReddit();
  console.log(`Fetching Moltbook ${MOLTBOOK_SUBMOLT}…`);
  const moltRaw = await fetchMoltbook(apiKey);

  const reddit = shuffle(dedupe(redditRaw)).slice(0, PER_SOURCE_CAP);
  const moltbook = shuffle(dedupe(moltRaw)).slice(0, PER_SOURCE_CAP);

  const pool: PostPool = { reddit, moltbook };
  mkdirSync(dirname(OUTFILE), { recursive: true });
  writeFileSync(OUTFILE, JSON.stringify(pool, null, 2));
  console.log(`Wrote ${OUTFILE}`);
  console.log(`  reddit: ${reddit.length}`);
  console.log(`  moltbook: ${moltbook.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
