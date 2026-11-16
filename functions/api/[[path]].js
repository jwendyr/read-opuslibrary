// Cloudflare Pages Functions API for Opus Library (Auth, Books, Cast Studio, Render Queue, R2 Media)

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getCookie(req, name) {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

async function getCurrentUser(req, env) {
  if (!env.DB) return null;
  const token = getCookie(req, 'opus_session');
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ?`
  )
    .bind(token, new Date().toISOString())
    .first();
  return row || null;
}

function splitTextToBookJson(title, author, rawText) {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  const rawChapters = normalized.split(/(?=^(?:#\s+|CHAPTER\s+|Chapter\s+|STAVE\s+|Stave\s+))/m).filter((c) => c.trim());
  const chunks = rawChapters.length ? rawChapters : [normalized];
  let totalWords = 0;

  const chapters = chunks.map((chunk, idx) => {
    const lines = chunk.trim().split('\n');
    const firstLine = lines[0].replace(/^#+\s*/, '').trim();
    const hasHeading = /^(chapter|stave)\s+/i.test(firstLine) || lines[0].startsWith('#');
    const chTitle = hasHeading ? firstLine : `Chapter ${idx + 1}`;
    const bodyText = (hasHeading ? lines.slice(1).join('\n') : chunk).trim();

    const paragraphs = bodyText.split(/\n\s*\n/).filter((p) => p.trim());
    const segments = [
      { role: 'narrator', voice: 'en-US-AriaNeural', emotion: 'neutral', rate: '+0%', pitch: '+0Hz', volume: '+0%', ambiance: 'none', sfx: 'none', confidence: 'high', text: chTitle },
    ];
    const words = [];
    let wIdx = 0;
    let htmlParts = [];

    const addSegHtml = (si, text, isHeading = false) => {
      const toks = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^\w\s]+|\s+/g) || [text];
      const inner = toks
        .map((t) => {
          if (/^[A-Za-z0-9]/.test(t)) {
            wIdx += 1;
            const wid = `w${String(wIdx).padStart(5, '0')}`;
            words.push({ id: wid, segIdx: si, text: t, beginSec: 0 });
            return `<span id="${wid}">${t.replace(/</g, '&lt;')}</span>`;
          }
          return t.replace(/</g, '&lt;');
        })
        .join('');
      return isHeading
        ? `<h1><span class="seg-span" id="seg_${si}">${inner}</span></h1>`
        : `<span class="seg-span" id="seg_${si}">${inner}</span> `;
    };

    htmlParts.push(addSegHtml(0, chTitle, true));
    for (const para of paragraphs) {
      const cleanPara = para.replace(/\s+/g, ' ').trim();
      const parts = cleanPara.split(/("[^"]+")/).filter((p) => p.trim() && /[A-Za-z0-9]/.test(p));
      let pHtml = '';
      for (const p of parts) {
        const si = segments.length;
        const isQuote = p.startsWith('"') && p.endsWith('"') && p.length > 2;
        segments.push({
          role: isQuote ? 'other' : 'narrator',
          voice: isQuote ? 'en-US-AndrewMultilingualNeural' : 'en-US-AriaNeural',
          emotion: 'neutral',
          rate: '+0%',
          pitch: '+0Hz',
          volume: '+0%',
          ambiance: 'none',
          sfx: 'none',
          confidence: isQuote ? 'low' : 'high',
          text: p.trim(),
        });
        pHtml += addSegHtml(si, p.trim(), false);
      }
      htmlParts.push(`<p>${pHtml}</p>`);
    }

    totalWords += words.length;
    return {
      chapter: `ch${String(idx + 1).padStart(2, '0')}`,
      title: chTitle,
      audio: '',
      html: htmlParts.join('\n'),
      segments,
      words,
    };
  });

  return { bookJson: { title, author, chapters }, chaptersCount: chapters.length, wordsCount: totalWords };
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = '/' + (params.path ? (Array.isArray(params.path) ? params.path.join('/') : params.path) : '');
  const method = request.method;

  if (!env.DB) {
    return json({ error: 'Cloudflare D1 binding (DB) is not configured yet.' }, 503);
  }

  // Auth: Register
  if (path === '/auth/register' && method === 'POST') {
    const { email, name, password } = await request.json();
    if (!email || !password || password.length < 6) {
      return json({ error: 'Valid email and password (min 6 chars) required.' }, 400);
    }
    const normEmail = email.trim().toLowerCase();
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(normEmail).first();
    if (existing) return json({ error: 'Email already registered.' }, 409);

    const id = randomHex(12);
    const salt = randomHex(16);
    const passwordHash = await hashPassword(password, salt);
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, normEmail, (name || normEmail.split('@')[0]).trim(), passwordHash, salt, now)
      .run();

    const token = randomHex(24);
    const exp = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, id, exp).run();

    return json(
      { user: { id, email: normEmail, name: (name || normEmail.split('@')[0]).trim() } },
      201,
      { 'Set-Cookie': `opus_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` }
    );
  }

  // Auth: Login
  if (path === '/auth/login' && method === 'POST') {
    const { email, password } = await request.json();
    if (!email || !password) return json({ error: 'Email and password required.' }, 400);
    const normEmail = email.trim().toLowerCase();
    const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(normEmail).first();
    if (!user) return json({ error: 'Invalid credentials.' }, 401);
    const check = await hashPassword(password, user.salt);
    if (check !== user.password_hash) return json({ error: 'Invalid credentials.' }, 401);

    const token = randomHex(24);
    const exp = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, user.id, exp).run();

    return json(
      { user: { id: user.id, email: user.email, name: user.name } },
      200,
      { 'Set-Cookie': `opus_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` }
    );
  }

  // Auth: Logout & Me
  if (path === '/auth/logout' && method === 'POST') {
    const token = getCookie(request, 'opus_session');
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'opus_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }
  if (path === '/auth/me' && method === 'GET') {
    const user = await getCurrentUser(request, env);
    return json({ user });
  }

  // Books: List (public + current user's own)
  if (path === '/books' && method === 'GET') {
    const user = await getCurrentUser(request, env);
    const stmt = user
      ? env.DB.prepare(
          `SELECT b.slug, b.title, b.author, b.subtitle, b.is_public, b.status, b.chapters_count AS chapters, b.words_count AS words, b.cover_url AS cover, b.epub_url AS epubUrl, b.owner_id, u.name AS ownerName
           FROM books b JOIN users u ON b.owner_id = u.id WHERE b.is_public = 1 OR b.owner_id = ? ORDER BY b.created_at DESC`
        ).bind(user.id)
      : env.DB.prepare(
          `SELECT b.slug, b.title, b.author, b.subtitle, b.is_public, b.status, b.chapters_count AS chapters, b.words_count AS words, b.cover_url AS cover, b.epub_url AS epubUrl, b.owner_id, u.name AS ownerName
           FROM books b JOIN users u ON b.owner_id = u.id WHERE b.is_public = 1 ORDER BY b.created_at DESC`
        );
    const { results } = await stmt.all();
    return json({ books: results || [] });
  }

  // Books: Create
  if (path === '/books' && method === 'POST') {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: 'Please sign in to create a book.' }, 401);
    const { title, author, text, isPublic } = await request.json();
    if (!title || !text || text.trim().length < 20) {
      return json({ error: 'Title and book text (min 20 chars) are required.' }, 400);
    }

    const baseSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'book';
    const slug = `${baseSlug}-${randomHex(3)}`;
    const id = randomHex(12);
    const now = new Date().toISOString();
    const parsed = splitTextToBookJson(title.trim(), (author || user.name).trim(), text);

    await env.DB.prepare(
      `INSERT INTO books (id, slug, owner_id, title, author, is_public, status, chapters_count, words_count, book_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`
    )
      .bind(id, slug, user.id, title.trim(), (author || user.name).trim(), isPublic === false ? 0 : 1, parsed.chaptersCount, parsed.wordsCount, JSON.stringify(parsed.bookJson), now, now)
      .run();

    return json({ slug, id, chapters: parsed.chaptersCount, words: parsed.wordsCount }, 201);
  }

  // Books: Get / Update / Queue Render
  const bookMatch = path.match(/^\/books\/([^/]+)(\/render)?$/);
  if (bookMatch) {
    const slug = decodeURIComponent(bookMatch[1]);
    const isRender = Boolean(bookMatch[2]);
    const row = await env.DB.prepare('SELECT * FROM books WHERE slug = ?').bind(slug).first();
    if (!row) return json({ error: 'Book not found.' }, 404);
    const user = await getCurrentUser(request, env);

    if (!isRender && method === 'GET') {
      if (!row.is_public && (!user || user.id !== row.owner_id)) {
        return json({ error: 'Unauthorized' }, 403);
      }
      const bjson = JSON.parse(row.book_json);
      return json({ ...bjson, slug: row.slug, ownerId: row.owner_id, status: row.status, canEdit: Boolean(user && user.id === row.owner_id) });
    }

    if (!isRender && method === 'PUT') {
      if (!user || user.id !== row.owner_id) return json({ error: 'Only the book owner can save edits.' }, 403);
      const body = await request.json();
      await env.DB.prepare('UPDATE books SET book_json = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(body), new Date().toISOString(), row.id)
        .run();
      return json({ ok: true });
    }

    if (isRender && method === 'POST') {
      if (!user || user.id !== row.owner_id) return json({ error: 'Only the book owner can trigger rendering.' }, 403);
      const jobId = randomHex(12);
      const now = new Date().toISOString();
      await env.DB.prepare('INSERT INTO render_jobs (id, book_id, owner_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(jobId, row.id, user.id, 'queued', now, now)
        .run();
      await env.DB.prepare('UPDATE books SET status = ?, updated_at = ? WHERE id = ?').bind('queued', now, row.id).run();
      return json({ jobId, status: 'queued' }, 202);
    }
  }

  return json({ error: 'Not found' }, 404);
}
