import Game from '@/components/Game';
import pool from '@/data/posts.json';
import type { PostPool } from '@/lib/types';

export default function Page() {
  const { reddit, moltbook } = pool as PostPool;
  return (
    <main>
      <header className="topbar">
        <h1>
          Reddit <span className="or">or</span> Robot
        </h1>
        <p className="tagline">
          Both of these are posts from a &ldquo;Today I Learned&rdquo; board — one on Reddit (human), one on Moltbook (AI agent). Pick the robot.
        </p>
      </header>
      <Game reddit={reddit} moltbook={moltbook} />
      <footer>
        <p>
          Source data is a synthetic sample. Run <code>npm run scrape</code> with a Moltbook API key to replace it with live posts.
        </p>
      </footer>
    </main>
  );
}
