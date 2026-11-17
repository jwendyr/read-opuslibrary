// Cloudflare Pages Functions API for Opus Library (Auth, Books, Cast Studio, Render Queue, R2 Media)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
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

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!env.DB) {
    return json({ error: 'Cloudflare D1 binding (DB) is not configured yet.' }, 503);
  }

  // Auth: Register
  if (path === '/auth/register' && method === 'POST') {
    const body = await parseJson(request);
    if (!body) return json({ error: 'Invalid JSON body.' }, 400);
    const { email, name, password } = body;
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
    const body = await parseJson(request);
    if (!body) return json({ error: 'Invalid JSON body.' }, 400);
    const { email, password } = body;
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

  // Books: List (public + current user's own + catalog.json)
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
    let staticBooks = [];
    try {
      const catRes = await env.ASSETS.fetch(new Request(`${url.origin}/catalog.json`));
      if (catRes.ok) staticBooks = (await catRes.json()).books || [];
    } catch {}
    return json({ books: [...(results || []), ...staticBooks] });
  }

  // Books: Create
  if (path === '/books' && method === 'POST') {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: 'Please sign in to create a book.' }, 401);
    const body = await parseJson(request);
    if (!body) return json({ error: 'Invalid JSON body.' }, 400);
    const { title, author, text, isPublic } = body;
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

  // R2 Media Serve: GET /api/media/<key>
  if (path.startsWith('/media/') && method === 'GET') {
    if (!env.BUCKET) return json({ error: 'R2 bucket not bound.' }, 503);
    const key = decodeURIComponent(path.slice('/media/'.length));
    const obj = await env.BUCKET.get(key);
    if (!obj) return json({ error: 'Media not found.' }, 404);
    const headers = new Headers(CORS_HEADERS);
    obj.writeHttpMetadata(headers);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', key.endsWith('.epub') ? 'application/epub+zip' : key.endsWith('.m4a') ? 'audio/mp4' : 'image/jpeg');
    }
    headers.set('Cache-Control', 'public, max-age=3600');
    return new Response(obj.body, { headers });
  }

  // Live Neural TTS Proxy: POST /api/tts (proxies to env.TTS_BACKEND_URL if configured)
  if (path === '/tts' && method === 'POST') {
    if (!env.TTS_BACKEND_URL) {
      return json({ error: 'No live neural TTS backend configured (set TTS_BACKEND_URL).' }, 503);
    }
    const body = await parseJson(request);
    if (!body || !body.text) return json({ error: 'Invalid TTS payload.' }, 400);
    const upstream = await fetch(env.TTS_BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'audio/mpeg', ...CORS_HEADERS },
    });
  }

  // Render Worker API (Bearer WORKER_SECRET)
  if (path.startsWith('/worker/')) {
    const auth = request.headers.get('Authorization') || '';
    if (!env.WORKER_SECRET || auth !== `Bearer ${env.WORKER_SECRET}`) {
      return json({ error: 'Unauthorized worker.' }, 401);
    }
    if (path === '/worker/next' && method === 'GET') {
      const job = await env.DB.prepare(
        `SELECT r.id AS jobId, r.book_id AS bookId, b.slug, b.title, b.author, b.book_json AS bookJson
         FROM render_jobs r JOIN books b ON r.book_id = b.id
         WHERE r.status = 'queued' ORDER BY r.created_at ASC LIMIT 1`
      ).first();
      if (!job) return json({ job: null });
      await env.DB.prepare('UPDATE render_jobs SET status = ?, updated_at = ? WHERE id = ?')
        .bind('processing', new Date().toISOString(), job.jobId).run();
      return json({ job: { ...job, bookJson: JSON.parse(job.bookJson) } });
    }
    if (path === '/worker/upload' && method === 'POST') {
      if (!env.BUCKET) return json({ error: 'R2 bucket not bound.' }, 503);
      const key = url.searchParams.get('key');
      if (!key) return json({ error: 'Missing key query param.' }, 400);
      await env.BUCKET.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
      });
      return json({ ok: true, url: `${url.origin}/api/media/${key}` });
    }
    if (path === '/worker/complete' && method === 'POST') {
      const body = await parseJson(request);
      if (!body || !body.jobId || !body.bookId) return json({ error: 'Invalid completion payload.' }, 400);
      const now = new Date().toISOString();
      await env.DB.prepare('UPDATE render_jobs SET status = ?, log = ?, updated_at = ? WHERE id = ?')
        .bind(body.status || 'done', body.log || '', now, body.jobId).run();
      if (body.bookJson) {
        await env.DB.prepare('UPDATE books SET status = ?, epub_url = ?, book_json = ?, updated_at = ? WHERE id = ?')
          .bind('ready', body.epubUrl || '', JSON.stringify(body.bookJson), now, body.bookId).run();
      } else {
        await env.DB.prepare('UPDATE books SET status = ?, updated_at = ? WHERE id = ?')
          .bind(body.status === 'error' ? 'error' : 'ready', now, body.bookId).run();
      }
      return json({ ok: true });
    }
  }

  // Books: Get / Update / Delete / Cover / Queue Render
  const bookMatch = path.match(/^\/books\/([^/]+)(\/render|\/cover)?$/);
  if (bookMatch) {
    const slug = decodeURIComponent(bookMatch[1]);
    const subAction = bookMatch[2] || '';
    const isRender = subAction === '/render';
    const isCover = subAction === '/cover';
    const row = await env.DB.prepare('SELECT * FROM books WHERE slug = ?').bind(slug).first();
    const user = await getCurrentUser(request, env);

    if (!row && !subAction && method === 'GET') {
      try {
        const bRes = await env.ASSETS.fetch(new Request(`${url.origin}/books/${encodeURIComponent(slug)}/book.json`));
        if (bRes.ok) {
          const bjson = await bRes.json();
          return json({ ...bjson, slug, status: 'ready', canEdit: false });
        }
      } catch {}
      return json({ error: 'Book not found.' }, 404);
    }
    if (!row) return json({ error: 'Book not found.' }, 404);

    if (!subAction && method === 'GET') {
      if (!row.is_public && (!user || user.id !== row.owner_id)) {
        return json({ error: 'Unauthorized' }, 403);
      }
      const bjson = JSON.parse(row.book_json);
      return json({ ...bjson, slug: row.slug, ownerId: row.owner_id, status: row.status, epubUrl: row.epub_url, coverUrl: row.cover_url, canEdit: Boolean(user && user.id === row.owner_id) });
    }

    if (!subAction && method === 'PUT') {
      if (!user || user.id !== row.owner_id) return json({ error: 'Only the book owner can save edits.' }, 403);
      const body = await parseJson(request);
      if (!body) return json({ error: 'Invalid JSON body.' }, 400);
      await env.DB.prepare('UPDATE books SET book_json = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(body), new Date().toISOString(), row.id)
        .run();
      return json({ ok: true });
    }

    if (!subAction && method === 'DELETE') {
      if (!user || user.id !== row.owner_id) return json({ error: 'Only the book owner can delete this book.' }, 403);
      await env.DB.prepare('DELETE FROM render_jobs WHERE book_id = ?').bind(row.id).run();
      await env.DB.prepare('DELETE FROM books WHERE id = ?').bind(row.id).run();
      return json({ ok: true, deleted: slug });
    }

    if (isCover && method === 'POST') {
      if (!user || user.id !== row.owner_id) return json({ error: 'Only the book owner can upload a cover.' }, 403);
      if (!env.BUCKET) return json({ error: 'R2 bucket not bound.' }, 503);
      const ct = request.headers.get('Content-Type') || 'image/jpeg';
      const ext = ct.includes('png') ? 'png' : 'jpg';
      const key = `covers/${slug}.${ext}`;
      await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: ct } });
      const coverUrl = `/api/media/${key}`;
      await env.DB.prepare('UPDATE books SET cover_url = ?, updated_at = ? WHERE id = ?')
        .bind(coverUrl, new Date().toISOString(), row.id).run();
      return json({ ok: true, coverUrl });
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

  // Dynamic OPDS 1.2 & OPDS 2.0 under /api/opds.xml and /api/opds.json (includes D1 public books + catalog.json)
  if (path === '/opds.xml' && method === 'GET') {
    const mod = await import('../opds.xml.js');
    return mod.onRequestGet(context);
  }
  if (path === '/opds.json' && method === 'GET') {
    const mod = await import('../opds.json.js');
    return mod.onRequestGet(context);
  }

  // W3C / Readium Web Publication Manifest: /api/w3c/:slug/manifest.json
  const w3cMatch = path.match(/^\/w3c\/([^/]+)\/manifest\.json$/);
  if (w3cMatch && method === 'GET') {
    const slug = decodeURIComponent(w3cMatch[1]);
    const origin = url.origin;
    let bookData = null;
    let metaEntry = null;

    const row = await env.DB.prepare('SELECT * FROM books WHERE slug = ? AND is_public = 1').bind(slug).first();
    if (row) {
      bookData = JSON.parse(row.book_json);
      metaEntry = { title: row.title, author: row.author, cover: row.cover_url, epubUrl: row.epub_url };
    } else {
      try {
        const catRes = await env.ASSETS.fetch(new Request(`${origin}/catalog.json`));
        const cat = catRes.ok ? await catRes.json() : { books: [] };
        metaEntry = (cat.books || []).find((b) => b.slug === slug);
        const bRes = await env.ASSETS.fetch(new Request(`${origin}/books/${slug}/book.json`));
        if (bRes.ok) bookData = await bRes.json();
      } catch {}
    }

    if (!bookData) return json({ error: 'Book not found.' }, 404);

    const manifest = {
      '@context': ['https://readium.org/webpub-manifest/context.jsonld', 'https://www.w3.org/ns/pub-context'],
      metadata: {
        '@type': 'http://schema.org/Book',
        identifier: `urn:opuslibrary:book:${slug}`,
        title: bookData.title || metaEntry?.title || slug,
        author: metaEntry?.author || bookData.author || 'Unknown',
        language: 'en',
        conformsTo: ['https://www.w3.org/TR/epub-33/', 'https://readium.org/webpub-manifest/'],
      },
      links: [
        { rel: 'self', href: `${origin}/api/w3c/${encodeURIComponent(slug)}/manifest.json`, type: 'application/webpub+json' },
        { rel: 'alternate', href: `${origin}/reader.html?book=${encodeURIComponent(slug)}`, type: 'text/html' },
        ...(metaEntry?.epubUrl ? [{ rel: 'http://opds-spec.org/acquisition', href: metaEntry.epubUrl, type: 'application/epub+zip' }] : []),
      ],
      readingOrder: (bookData.chapters || []).map((c, idx) => ({
        href: `${origin}/reader.html?book=${encodeURIComponent(slug)}#ch=${idx + 1}`,
        title: c.title,
        type: 'text/html',
      })),
      resources: (bookData.chapters || [])
        .filter((c) => c.audio)
        .map((c) => ({
          href: c.audio.startsWith('http') ? c.audio : `${origin}/books/${slug}/${c.audio}`,
          type: 'audio/mp4',
        })),
    };

    return new Response(JSON.stringify(manifest, null, 2), {
      headers: {
        'Content-Type': 'application/webpub+json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  return json({ error: 'Not found' }, 404);
}
