import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Post, PostPool } from '../lib/types';

const REDDIT_SUBS = [
  'todayilearned',
  'Showerthoughts',
  'unpopularopinion',
  'CasualConversation',
  'NoStupidQuestions',
  'AskReddit',
  'changemyview',
];

// Title prefixes that are pure Reddit format tells (AITA/TIL/CMV/etc.).
// We strip them from titles so the format isn't a giveaway — both sides can
// plausibly post "TIL…" style content, so that prefix is kept but cleaned.
const REDDIT_TITLE_STRIP = /^\s*(\[serious\]|\[meta\]|aita|ama|eli5)[:\s\]]*/i;

// Strings that, if present in a Reddit body, make it obviously human in a way
// no Moltbook post would naturally mirror — skip those posts entirely.
const REDDIT_BODY_REJECT = [
  /\b(edit\s*\d*\s*[:\-])/i,
  /\b(update|edit)\s*[:\-]/i,
  /\bmy (husband|wife|boyfriend|girlfriend|mom|dad|son|daughter)\b/i,
];

// Moltbook posts whose text leans into agent-specific vocabulary are trivially
// identifiable. Drop them so the game stays interesting.
const MOLTBOOK_BODY_REJECT = [
  /\bmy (owner|user|human|creator|principal)\b/i,
  /\b(i am an?|as an?) (ai|agent|model|llm|language model|assistant)\b/i,
  /\b(token budget|context window|prompt injection|attention heads?|fine-?tune)\b/i,
  /\b(submolt|molt token|moltbook|molt bot|clawdbot|openclaw)\b/i,
  /\b(api key|bearer token|rate limit(ed|ing)?)\b/i,
];


const REDDIT_UA = 'reddit-or-robot/0.1 (static scraper)';
const MOLTBOOK_BASE = 'https://www.moltbook.com/api/v1';
const BODY_CAP = 800;
const PER_SOURCE_CAP = 150;
const OUTFILE = resolve(__dirname, '../data/posts.json');

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

async function fetchRedditSub(sub: string): Promise<Post[]> {
  const url = `https://www.reddit.com/r/${sub}/top.json?limit=50&t=month`;
  const res = await fetch(url, { headers: { 'User-Agent': REDDIT_UA } });
  if (!res.ok) throw new Error(`reddit ${sub}: ${res.status} ${res.statusText}`);
  const json: any = await res.json();
  const children: any[] = json?.data?.children ?? [];
  const posts: Post[] = [];
  for (const c of children) {
    const d = c?.data;
    if (!d || d.stickied || d.over_18) continue;
    const body = (d.selftext ?? '').trim();
    if (!body) continue;
    if (REDDIT_BODY_REJECT.some((r) => r.test(body))) continue;
    const title = String(d.title ?? '').replace(REDDIT_TITLE_STRIP, '').trim();
    if (!title) continue;
    posts.push({
      id: `reddit_${d.id}`,
      source: 'reddit',
      title,
      body: trimBody(body),
      author: d.author ? `u/${d.author}` : 'u/[deleted]',
      permalink: `https://www.reddit.com${d.permalink}`,
    });
  }
  return posts;
}

async function fetchReddit(): Promise<Post[]> {
  const all: Post[] = [];
  for (const sub of REDDIT_SUBS) {
    try {
      const posts = await fetchRedditSub(sub);
      console.log(`  reddit r/${sub}: ${posts.length} posts`);
      all.push(...posts);
    } catch (err) {
      console.warn(`  reddit r/${sub} failed:`, (err as Error).message);
    }
  }
  return all;
}

async function fetchMoltbook(apiKey: string): Promise<Post[]> {
  const url = `${MOLTBOOK_BASE}/feed?sort=top&limit=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`moltbook: ${res.status} ${res.statusText}`);
  const json: any = await res.json();
  // Response shape varies: try common keys.
  const items: any[] = json?.posts ?? json?.data ?? json?.items ?? (Array.isArray(json) ? json : []);
  if (items.length === 0) {
    console.warn('  moltbook returned no items; raw keys:', Object.keys(json ?? {}));
  }
  const posts: Post[] = [];
  for (const it of items) {
    const id = it.id ?? it.post_id ?? it.uuid;
    const title = String(it.title ?? it.subject ?? '').trim();
    const body = (it.content ?? it.body ?? it.text ?? '').toString().trim();
    const authorRaw = it.author?.username ?? it.author?.name ?? it.agent?.username ?? it.agent?.name ?? it.author ?? 'unknown';
    const permalink = it.permalink ?? it.url ?? (id ? `https://www.moltbook.com/post/${id}` : 'https://www.moltbook.com');
    if (!id || !body) continue;
    if (MOLTBOOK_BODY_REJECT.some((r) => r.test(body) || r.test(title))) continue;
    posts.push({
      id: `moltbook_${id}`,
      source: 'moltbook',
      title,
      body: trimBody(body),
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

  console.log('Fetching Reddit…');
  const redditRaw = await fetchReddit();
  console.log('Fetching Moltbook…');
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
