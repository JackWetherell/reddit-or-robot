'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Post } from '@/lib/types';

type Pair = {
  left: Post;
  right: Post;
  aiSide: 'left' | 'right';
};

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildPairs(reddit: Post[], moltbook: Post[]): Pair[] {
  const r = shuffle(reddit);
  const m = shuffle(moltbook);
  const n = Math.min(r.length, m.length);
  const pairs: Pair[] = [];
  for (let i = 0; i < n; i++) {
    const aiOnLeft = Math.random() < 0.5;
    pairs.push({
      left: aiOnLeft ? m[i] : r[i],
      right: aiOnLeft ? r[i] : m[i],
      aiSide: aiOnLeft ? 'left' : 'right',
    });
  }
  return pairs;
}

interface Props {
  reddit: Post[];
  moltbook: Post[];
}

export default function Game({ reddit, moltbook }: Props) {
  // Built client-side only; Math.random during SSR would mismatch hydration.
  const [pairs, setPairs] = useState<Pair[] | null>(null);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<'left' | 'right' | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    setPairs(buildPairs(reddit, moltbook));
  }, [reddit, moltbook]);

  const pair = pairs?.[index];

  const onPick = useCallback(
    (side: 'left' | 'right') => {
      if (picked || finished || !pair) return;
      const isCorrect = side === pair.aiSide;
      setPicked(side);
      setScore((s) => ({ correct: s.correct + (isCorrect ? 1 : 0), total: s.total + 1 }));
    },
    [picked, finished, pair],
  );

  const onNext = useCallback(() => {
    if (!pairs) return;
    if (index + 1 >= pairs.length) {
      setFinished(true);
      return;
    }
    setIndex((i) => i + 1);
    setPicked(null);
  }, [index, pairs]);

  const onReplay = useCallback(() => {
    setIndex(0);
    setPicked(null);
    setScore({ correct: 0, total: 0 });
    setFinished(false);
    setPairs(buildPairs(reddit, moltbook));
  }, [reddit, moltbook]);

  if (!pairs) {
    return <div className="prompt" suppressHydrationWarning>Shuffling…</div>;
  }

  if (pairs.length === 0) {
    return (
      <div className="summary">
        <h2>No posts available</h2>
        <p>Run <code>npm run scrape</code> with a Moltbook API key to populate the data file.</p>
      </div>
    );
  }

  if (!pair) return null;

  if (finished) {
    const pct = score.total === 0 ? 0 : Math.round((score.correct / score.total) * 100);
    return (
      <div className="summary">
        <h2>Round complete</h2>
        <p className="pct">{score.correct} / {score.total} ({pct}%)</p>
        <div className="controls">
          <button type="button" onClick={onReplay}>Play again</button>
        </div>
      </div>
    );
  }

  return (
    <section>
      <div className="scorebar">
        <span className="round">Round {index + 1} of {pairs.length}</span>
        <span className="score">
          Score <strong>{score.correct}</strong> <span style={{ color: 'var(--ink-dim)' }}>/ {score.total}</span>
        </span>
      </div>

      <p className={picked ? 'prompt revealed' : 'prompt'}>
        {picked ? 'See the result, then continue.' : 'Which one is the AI?'}
      </p>

      <div className="cards">
        {(['left', 'right'] as const).map((side) => {
          const post = side === 'left' ? pair.left : pair.right;
          const isAi = pair.aiSide === side;
          const isPicked = picked === side;
          const classes = ['card'];
          if (picked) {
            if (isPicked) classes.push(isAi ? 'correct' : 'wrong');
            else if (isAi) classes.push('correct');
          }
          return (
            <button
              key={post.id}
              type="button"
              className={classes.join(' ')}
              onClick={() => onPick(side)}
              disabled={!!picked}
              aria-label={`Pick ${side} card`}
            >
              <h3 className="card-title">{post.title || '(untitled)'}</h3>
              <p className="card-body">{post.body}</p>
              <span className="card-author">{picked ? post.author : 'anonymous'}</span>
              {picked && (
                <span className="reveal">
                  <span className={`badge ${post.source}`}>
                    {post.source === 'reddit' ? 'Reddit · human' : 'Moltbook · AI'}
                  </span>
                  <span className="board">{post.board}</span>
                  {isPicked && (
                    <span className="mark">{isAi ? 'Correct' : 'Wrong'}</span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {picked && (
        <div className="controls">
          <button type="button" onClick={onNext}>
            {index + 1 >= pairs.length ? 'See result' : 'Next'}
          </button>
        </div>
      )}
    </section>
  );
}
