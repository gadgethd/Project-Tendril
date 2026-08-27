import { parseHTML } from 'linkedom';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { extractPage, extractStructured } from '../src/browser/extract.js';

function pageForHtml(html: string): Page {
  const { document: fixtureDocument } = parseHTML(html);
  return {
    content: async () => html,
    evaluate: async (callback: () => unknown) => {
      const host = globalThis as unknown as Record<string, unknown>;
      const previous = { present: Object.hasOwn(host, 'document'), value: host.document };
      host.document = fixtureDocument;
      try {
        return callback();
      } finally {
        if (previous.present) host.document = previous.value;
        else delete host.document;
      }
    },
    locator: (selector: string) => ({
      evaluateAll: async (callback: (elements: Element[]) => unknown) => (
        callback([...fixtureDocument.querySelectorAll(selector)])
      ),
    }),
    title: async () => fixtureDocument.title,
    url: () => 'https://example.test/article',
  } as unknown as Page;
}

describe('structured extraction', () => {
  it('collects JSON-LD, OpenGraph, nested microdata, commerce data, dates, and authors', async () => {
    const page = pageForHtml(`<!doctype html>
      <html>
        <head>
          <title>Structured fixture</title>
          <meta property="og:title" content="OpenGraph title">
          <meta property="og:type" content="article">
          <meta name="author" content="Metadata Author">
          <script type="application/ld+json">
            {"@type":"Article","headline":"JSON-LD title","author":{"name":"Schema Author"}}
          </script>
          <script type="application/ld+json">
            [{"@type":"Product","name":"Tea"},{"@type":"Offer","price":"19.95"}]
          </script>
          <script type="application/ld+json">{"broken":</script>
        </head>
        <body>
          <article itemscope itemtype="https://schema.org/Article" itemid="https://example.test/article">
            <h1 itemprop="headline">Microdata title</h1>
            <span itemprop="keywords">browser</span>
            <span itemprop="keywords">automation</span>
            <div itemprop="author" itemscope itemtype="https://schema.org/Person">
              <span itemprop="name">Microdata Author</span>
            </div>
            <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
              <meta id="offer-price" itemprop="price" content="19.95">
              <meta itemprop="priceCurrency" content="GBP">
            </div>
            <time id="published" itemprop="datePublished" datetime="2026-08-27">27 August 2026</time>
          </article>
          <a rel="author" href="/authors/byline">Byline Author</a>
        </body>
      </html>`);

    const structured = await extractStructured(page);

    expect(structured.jsonLd).toEqual([
      { '@type': 'Article', headline: 'JSON-LD title', author: { name: 'Schema Author' } },
      { '@type': 'Product', name: 'Tea' },
      { '@type': 'Offer', price: '19.95' },
    ]);
    expect(structured.openGraph).toEqual({ title: 'OpenGraph title', type: 'article' });
    expect(structured.microdata).toEqual([{
      type: 'https://schema.org/Article',
      id: 'https://example.test/article',
      properties: {
        headline: 'Microdata title',
        keywords: ['browser', 'automation'],
        author: {
          type: 'https://schema.org/Person',
          properties: { name: 'Microdata Author' },
        },
        offers: {
          type: 'https://schema.org/Offer',
          properties: { price: '19.95', priceCurrency: 'GBP' },
        },
        datePublished: '2026-08-27',
      },
    }]);
    expect(structured.prices).toEqual([{ amount: '19.95', currency: 'GBP', selector: '#offer-price' }]);
    expect(structured.dates).toEqual([{
      value: '2026-08-27',
      label: 'datePublished',
      selector: '#published',
    }]);
    expect(structured.authors).toEqual(expect.arrayContaining([
      'Metadata Author',
      'Microdata Author',
      'Byline Author',
      'Schema Author',
    ]));
  });

  it('omits empty sections and ignores malformed JSON-LD', async () => {
    const page = pageForHtml(`<!doctype html><html><head>
      <script type="application/ld+json">not-json</script>
    </head><body><p>No structured data here.</p></body></html>`);

    await expect(extractStructured(page)).resolves.toEqual({});
  });

  it('includes structured data in the full page extraction result', async () => {
    const page = pageForHtml(`<!doctype html><html><head>
      <title>Integrated fixture</title>
      <meta property="og:title" content="Integrated OpenGraph title">
    </head><body>
      <main><h1>Integrated fixture</h1><p>Enough article text for extraction.</p></main>
      <a href="https://example.test/docs">Docs</a>
    </body></html>`);

    const extracted = await extractPage(page);

    expect(extracted.structuredData).toEqual({ openGraph: { title: 'Integrated OpenGraph title' } });
    expect(extracted.metadata['og:title']).toBe('Integrated OpenGraph title');
    expect(extracted.links).toEqual([{ text: 'Docs', url: 'https://example.test/docs' }]);
  });
});
