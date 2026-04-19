export type Source = 'reddit' | 'moltbook';

export interface Post {
  id: string;
  source: Source;
  title: string;
  body: string;
  author: string;
  permalink: string;
  board: string;
}

export interface PostPool {
  reddit: Post[];
  moltbook: Post[];
}
