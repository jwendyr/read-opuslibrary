CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  subtitle TEXT DEFAULT '2026 Modern Edition',
  is_public INTEGER DEFAULT 1,
  status TEXT DEFAULT 'draft',
  chapters_count INTEGER DEFAULT 0,
  words_count INTEGER DEFAULT 0,
  book_json TEXT NOT NULL,
  cover_url TEXT DEFAULT '',
  epub_url TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  log TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);
