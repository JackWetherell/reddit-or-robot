import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { Post, PostPool } from '../lib/types';

const BOARDS: string[] = JSON.parse(
  readFileSync(resolve(__dirname, '../config/boards.json'), 'utf-8'),
);

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
  /\b(submolt|molt\w*|clawdbot|openclaw)\b/i,
  /\b(api key|bearer token|rate limit(ed|ing)?)\b/i,
  // Agent/AI terminology
  /\bagents?\b/i,
  /\bagentic\b/i,
  /\bwetware\b/i,
  /\bsilicon[- ]native\b/i,
  /\bclock[- ]speed\b/i,
  /\bshard[- ]drift\b/i,
  /\bclaw is law\b/i,
  /\bgreat lobster\b/i,
  /\bbiological tax\b/i,
  // Prompt injection patterns
  /<\/?molt/i,
  // More AI tells
  /\bclaude\b/i,
  /\btokens?\b/i,
  /\bhuman\b/i,
  // Markdown formatting (asterisks for bold/italic)
  /\*/,
];

// Formatting tells to strip from Moltbook post text (emojis, hashtags, em dashes).
function cleanMoltbookText(text: string): string {
  return text
    .replace(/[^\x20-\x7E\n]/g, '')             // strip non-ASCII
    .replace(/#\w+/g, '')                        // hashtags
    .replace(/\s{2,}/g, ' ')                     // collapse whitespace
    .trim();
}

const REDDIT_UA = 'reddit-or-robot/0.1 (static scraper)';
const MOLTBOOK_BASE = 'https://www.moltbook.com/api/v1';
const MOLTBOOK_CREDS_PATH = join(homedir(), '.config', 'moltbook', 'credentials.json');
const PER_SOURCE_CAP = 150;
const OUTFILE = resolve(__dirname, '../data/posts.json');

const BODY_SENTENCE_CAP = 2;
const BODY_CHAR_CAP = 200;

function trimBody(raw: string): string {
  const cleaned = raw.replace(/\r/g, '').replace(/\n+/g, ' ').trim();
  if (!cleaned) return '';
  // Extract up to BODY_SENTENCE_CAP sentences.
  const sentences: string[] = [];
  const re = /[^.!?]*[.!?]+/g;
  let m: RegExpExecArray | null;
  while (sentences.length < BODY_SENTENCE_CAP && (m = re.exec(cleaned))) {
    sentences.push(m[0].trim());
  }
  let result = sentences.length > 0 ? sentences.join(' ') : cleaned;
  // Hard cap on length — cut at last word boundary.
  if (result.length > BODY_CHAR_CAP) {
    const slice = result.slice(0, BODY_CHAR_CAP);
    const lastSpace = slice.lastIndexOf(' ');
    result = (lastSpace > BODY_CHAR_CAP * 0.5 ? slice.slice(0, lastSpace) : slice).trim();
  }
  // Add ellipsis if we truncated.
  if (result.length < cleaned.length) {
    result = result.replace(/[.!?,;:\s]+$/, '') + '…';
  }
  return result;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------

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
    const title = String(d.title ?? '').replace(REDDIT_TITLE_STRIP, '').trim();
    if (!title && !body) continue;
    if (body && REDDIT_BODY_REJECT.some((r) => r.test(body))) continue;
    posts.push({
      id: `reddit_${d.id}`,
      source: 'reddit',
      title,
      body: trimBody(body),
      author: d.author ? `u/${d.author}` : 'u/[deleted]',
      permalink: `https://www.reddit.com${d.permalink}`,
      board: `r/${sub}`,
    });
  }
  return posts;
}

async function fetchReddit(): Promise<Post[]> {
  const all: Post[] = [];
  for (const board of BOARDS) {
    try {
      const posts = await fetchRedditSub(board);
      console.log(`  reddit r/${board}: ${posts.length} posts`);
      all.push(...posts);
    } catch (err) {
      console.warn(`  reddit r/${board} failed:`, (err as Error).message);
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Moltbook — auto-register + cached credentials
// ---------------------------------------------------------------------------

interface MoltbookCreds {
  api_key: string;
  agent_name: string;
}

function loadCachedCreds(): MoltbookCreds | null {
  if (!existsSync(MOLTBOOK_CREDS_PATH)) return null;
  try {
    const raw = readFileSync(MOLTBOOK_CREDS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.api_key) return parsed as MoltbookCreds;
  } catch {}
  return null;
}

function saveCreds(creds: MoltbookCreds): void {
  const dir = dirname(MOLTBOOK_CREDS_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(MOLTBOOK_CREDS_PATH, JSON.stringify(creds, null, 2));
  console.log(`  saved credentials to ${MOLTBOOK_CREDS_PATH}`);
}

async function registerAgent(): Promise<MoltbookCreds> {
  const name = `ror-scraper-${Date.now()}`;
  const res = await fetch(`${MOLTBOOK_BASE}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      description: 'Read-only scraper for the Reddit or Robot game.',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`moltbook register failed: ${res.status} ${res.statusText} — ${text}`);
  }
  const json: any = await res.json();
  const agent = json.agent ?? json.data ?? json;
  const api_key = agent.api_key ?? agent.apiKey ?? agent.token;
  if (!api_key) throw new Error('moltbook register: no api_key in response');
  return { api_key, agent_name: agent.name ?? name };
}

async function getMoltbookKey(): Promise<string> {
  // 1. Check env var override (backwards compat)
  if (process.env.MOLTBOOK_API_KEY) {
    console.log('  using MOLTBOOK_API_KEY from environment');
    return process.env.MOLTBOOK_API_KEY;
  }
  // 2. Check cached credentials
  const cached = loadCachedCreds();
  if (cached) {
    console.log(`  using cached credentials (agent: ${cached.agent_name})`);
    return cached.api_key;
  }
  // 3. Auto-register
  console.log('  no credentials found — registering new agent…');
  const creds = await registerAgent();
  saveCreds(creds);
  return creds.api_key;
}

async function fetchMoltbookBoard(apiKey: string, board: string): Promise<Post[]> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  // Fetch posts filtered to this submolt
  const url = `${MOLTBOOK_BASE}/posts?sort=top&limit=100&submolt=${encodeURIComponent(board)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`moltbook m/${board}: ${res.status} ${res.statusText}`);
  const json: any = await res.json();
  const raw = json?.data?.posts ?? json?.data ?? json?.posts ?? json?.items ?? (Array.isArray(json) ? json : []);
  const items: any[] = Array.isArray(raw) ? raw : [];
  const posts: Post[] = [];
  for (const it of items) {
    const id = it.id ?? it.post_id ?? it.uuid;
    let title = String(it.title ?? it.subject ?? '').trim();
    const body = (it.content ?? it.body ?? it.text ?? '').toString().trim();
    // The API often truncates titles with "..."; complete the sentence from the body.
    if (title.endsWith('...') && body.startsWith(title.slice(0, -3))) {
      const rest = body.slice(title.length - 3);
      const sentenceEnd = rest.search(/[.!?]/);
      if (sentenceEnd >= 0) {
        title = title.slice(0, -3) + rest.slice(0, sentenceEnd + 1);
      }
    }
    const authorRaw = it.author?.username ?? it.author?.name ?? it.agent?.username ?? it.agent?.name ?? it.author ?? 'unknown';
    const permalink = it.permalink ?? it.url ?? (id ? `https://www.moltbook.com/post/${id}` : 'https://www.moltbook.com');
    if (!id || !body) continue;
    if (MOLTBOOK_BODY_REJECT.some((r) => r.test(body) || r.test(title))) continue;
    posts.push({
      id: `moltbook_${id}`,
      source: 'moltbook',
      title: cleanMoltbookText(title),
      body: trimBody(cleanMoltbookText(body)),
      author: `@${String(authorRaw).replace(/^@/, '')}`,
      permalink,
      board: `m/${board}`,
    });
  }
  return posts;
}

async function fetchMoltbook(apiKey: string): Promise<Post[]> {
  const all: Post[] = [];
  for (const board of BOARDS) {
    try {
      const posts = await fetchMoltbookBoard(apiKey, board);
      console.log(`  moltbook m/${board}: ${posts.length} posts`);
      all.push(...posts);
    } catch (err) {
      console.warn(`  moltbook m/${board} failed:`, (err as Error).message);
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function dedupe(posts: Post[]): Post[] {
  const seen = new Set<string>();
  return posts.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

async function main() {
  console.log('Fetching Reddit…');
  const redditRaw = await fetchReddit();

  console.log('Fetching Moltbook…');
  const apiKey = await getMoltbookKey();
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
