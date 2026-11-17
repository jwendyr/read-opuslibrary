// OPDS 1.2 (Atom/XML) Acquisition Catalog Feed — https://read.opuslibrary.com/opds.xml

function escXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function getAllPublicBooks(context) {
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
  return { origin, books: [...dbBooks, ...staticBooks] };
}

export async function onRequestGet(context) {
  const { origin, books: rawBooks } = await getAllPublicBooks(context);
  const q = (new URL(context.request.url).searchParams.get('q') || '').trim().toLowerCase();
  const books = q
    ? rawBooks.filter((b) => (b.title || '').toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q))
    : rawBooks;
  const now = new Date().toISOString();

  const entries = books
    .map((b) => {
      const coverHref = b.cover ? (b.cover.startsWith('http') ? b.cover : `${origin}/${b.cover}`) : '';
      const epubHref = b.epubUrl ? (b.epubUrl.startsWith('http') ? b.epubUrl : `${origin}/${b.epubUrl}`) : '';
      const readHref = `${origin}/reader.html?book=${encodeURIComponent(b.slug)}`;
      return `  <entry>
    <id>urn:opuslibrary:book:${escXml(b.slug)}</id>
    <title>${escXml(b.title)}</title>
    <author><name>${escXml(b.author)}</name></author>
    <updated>${escXml(b.updated_at || now)}</updated>
    <summary>${escXml(b.subtitle || '2026 Modern Read-Along Edition')} (${b.chapters || 0} chapters, ${(b.words || 0).toLocaleString()} words)</summary>
    <link rel="alternate" type="text/html" href="${escXml(readHref)}"/>
    ${coverHref ? `<link rel="http://opds-spec.org/image" type="image/jpeg" href="${escXml(coverHref)}"/>
    <link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="${escXml(coverHref)}"/>` : ''}
    ${epubHref ? `<link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="${escXml(epubHref)}"/>` : ''}
  </entry>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:opuslibrary:catalog</id>
  <title>Opus Library — Read-Along Books (OPDS 1.2)</title>
  <updated>${now}</updated>
  <author><name>Opus Library</name><uri>${origin}</uri></author>
  <link rel="self" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="${origin}/opds.xml"/>
  <link rel="start" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="${origin}/opds.xml"/>
  <link rel="search" type="application/opensearchdescription+xml" href="${origin}/opensearch.xml"/>
  <link rel="alternate" type="application/opds+json" href="${origin}/opds.json"/>
${entries}
</feed>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
