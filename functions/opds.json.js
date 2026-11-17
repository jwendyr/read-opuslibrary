// OPDS 2.0 (JSON) Catalog Feed — https://read.opuslibrary.com/opds.json

export async function onRequestGet(context) {
  const { request, env } = context;
  const origin = new URL(request.url).origin;

  let staticBooks = [];
  try {
    const res = await env.ASSETS.fetch(new Request(`${origin}/catalog.json`));
    if (res.ok) staticBooks = (await res.json()).books || [];
  } catch {}

  let dbBooks = [];
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        `SELECT slug, title, author, subtitle, chapters_count AS chapters, words_count AS words, cover_url AS cover, epub_url AS epubUrl, updated_at
         FROM books WHERE is_public = 1 ORDER BY created_at DESC`
      ).all();
      dbBooks = results || [];
    } catch {}
  }

  const q = (new URL(request.url).searchParams.get('q') || '').trim().toLowerCase();
  const combined = [...dbBooks, ...staticBooks];
  const all = q
    ? combined.filter((b) => (b.title || '').toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q))
    : combined;
  const publications = all.map((b) => {
    const coverHref = b.cover ? (b.cover.startsWith('http') ? b.cover : `${origin}/${b.cover}`) : null;
    const epubHref = b.epubUrl ? (b.epubUrl.startsWith('http') ? b.epubUrl : `${origin}/${b.epubUrl}`) : null;
    const links = [
      { rel: 'alternate', href: `${origin}/reader.html?book=${encodeURIComponent(b.slug)}`, type: 'text/html' },
      { rel: 'self', href: `${origin}/api/w3c/${encodeURIComponent(b.slug)}/manifest.json`, type: 'application/webpub+json' },
    ];
    if (epubHref) {
      links.push({ rel: 'http://opds-spec.org/acquisition', href: epubHref, type: 'application/epub+zip' });
    }
    return {
      metadata: {
        '@type': 'http://schema.org/Book',
        identifier: `urn:opuslibrary:book:${b.slug}`,
        title: b.title,
        subtitle: b.subtitle || '2026 Modern Read-Along Edition',
        author: { name: b.author },
        language: 'en',
        modified: b.updated_at || new Date().toISOString(),
      },
      links,
      images: coverHref ? [{ href: coverHref, type: 'image/jpeg' }] : [],
    };
  });

  const feed = {
    metadata: {
      title: 'Opus Library — Read-Along Books (OPDS 2.0)',
      numberOfItems: publications.length,
    },
    links: [
      { rel: 'self', href: `${origin}/opds.json`, type: 'application/opds+json' },
      { rel: 'alternate', href: `${origin}/opds.xml`, type: 'application/atom+xml;profile=opds-catalog;kind=acquisition' },
    ],
    publications,
  };

  return new Response(JSON.stringify(feed, null, 2), {
    headers: {
      'Content-Type': 'application/opds+json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
