import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { Page } from 'playwright';
import type { StructuredData } from '../types.js';

export interface ExtractedPage {
  url: string;
  title: string;
  byline?: string;
  excerpt?: string;
  siteName?: string;
  language?: string;
  html: string;
  text: string;
  markdown: string;
  links: Array<{ text: string; url: string }>;
  metadata: Record<string, string>;
  structuredData: StructuredData;
}

export async function extractPage(page: Page): Promise<ExtractedPage> {
  const [html, links, metadata, structuredData] = await Promise.all([
    page.content(),
    page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => ({
      text: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
      url: (anchor as HTMLAnchorElement).href,
    })).filter((entry) => entry.url)),
    page.evaluate(() => {
      const result: Record<string, string> = {};
      for (const meta of document.querySelectorAll('meta[name], meta[property]')) {
        const key = meta.getAttribute('name') ?? meta.getAttribute('property');
        const value = meta.getAttribute('content');
        if (key && value) result[key] = value;
      }
      return result;
    }),
    extractStructured(page),
  ]);
  const { document: parsedDocument } = parseHTML(html);
  let article: ReturnType<Readability['parse']> = null;
  try {
    article = new Readability(parsedDocument as unknown as Document, { charThreshold: 20 }).parse();
  } catch {
    // Fall back to the body below.
  }
  const articleHtml = article?.content || parsedDocument.body?.innerHTML || html;
  const text = (article?.textContent || parsedDocument.body?.textContent || '').replace(/\s+/g, ' ').trim();
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  turndown.remove(['script', 'style', 'noscript', 'template']);
  const result: ExtractedPage = {
    url: page.url(),
    title: article?.title || await page.title(),
    html: articleHtml,
    text,
    markdown: turndown.turndown(articleHtml).replace(/\n{3,}/g, '\n\n').trim(),
    links,
    metadata,
    structuredData,
  };
  if (article?.byline) result.byline = article.byline;
  if (article?.excerpt) result.excerpt = article.excerpt;
  if (article?.siteName) result.siteName = article.siteName;
  if (article?.lang) result.language = article.lang;
  return result;
}

export async function extractStructured(page: Page): Promise<StructuredData> {
  return page.evaluate(() => {
    const result: StructuredData = {};
    const isRecord = (value: unknown): value is Record<string, unknown> => (
      typeof value === 'object' && value !== null && !Array.isArray(value)
    );
    const normalize = (value: string | null | undefined): string => (
      (value ?? '').replace(/\s+/g, ' ').trim()
    );
    const elementValue = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      if (tag === 'meta') return normalize(element.getAttribute('content'));
      if (tag === 'time') return normalize(element.getAttribute('datetime') || element.textContent);
      if (tag === 'data' || tag === 'meter') return normalize(element.getAttribute('value') || element.textContent);
      if (tag === 'a' || tag === 'area' || tag === 'link') {
        return normalize((element as HTMLAnchorElement).href || element.getAttribute('href'));
      }
      if (['audio', 'embed', 'iframe', 'img', 'source', 'track', 'video'].includes(tag)) {
        return normalize((element as HTMLImageElement).src || element.getAttribute('src'));
      }
      if (tag === 'object') return normalize(element.getAttribute('data'));
      return normalize(element.getAttribute('content') || element.getAttribute('value') || element.textContent);
    };
    const selectorFor = (element: Element): string => {
      const escapeIdentifier = (value: string): string => {
        if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
        return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
      };
      if (element.id) return `#${escapeIdentifier(element.id)}`;
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && parts.length < 5) {
        let part = current.tagName.toLowerCase();
        const parent: Element | null = current.parentElement;
        if (parent) {
          const sameTag = [...parent.children].filter((child) => child.tagName === current?.tagName);
          if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        if (!parent || part === 'body') break;
        current = parent;
      }
      return parts.join(' > ');
    };

    const jsonLd: Record<string, unknown>[] = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json" i]')) {
      try {
        const parsed: unknown = JSON.parse(script.textContent ?? '');
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries) {
          if (isRecord(entry)) jsonLd.push(entry);
        }
      } catch {
        // Ignore malformed blocks without discarding other structured data.
      }
    }
    if (jsonLd.length > 0) result.jsonLd = jsonLd;

    const openGraph: Record<string, string> = {};
    for (const meta of document.querySelectorAll('meta[property^="og:" i], meta[name^="og:" i]')) {
      const property = normalize(meta.getAttribute('property') || meta.getAttribute('name')).toLowerCase();
      const content = normalize(meta.getAttribute('content'));
      if (property && content) openGraph[property.slice(3)] = content;
    }
    if (Object.keys(openGraph).length > 0) result.openGraph = openGraph;

    const addProperty = (properties: Record<string, unknown>, name: string, value: unknown): void => {
      if (!(name in properties)) {
        properties[name] = value;
        return;
      }
      const previous = properties[name];
      properties[name] = Array.isArray(previous) ? [...previous, value] : [previous, value];
    };
    const readMicrodata = (scope: Element): Record<string, unknown> => {
      const item: Record<string, unknown> = {};
      const type = normalize(scope.getAttribute('itemtype'));
      const id = normalize(scope.getAttribute('itemid'));
      if (type) item.type = type;
      if (id) item.id = id;
      const properties: Record<string, unknown> = {};
      for (const propertyElement of scope.querySelectorAll('[itemprop]')) {
        if (propertyElement.parentElement?.closest('[itemscope]') !== scope) continue;
        const value = propertyElement.hasAttribute('itemscope')
          ? readMicrodata(propertyElement)
          : elementValue(propertyElement);
        for (const name of normalize(propertyElement.getAttribute('itemprop')).split(' ').filter(Boolean)) {
          addProperty(properties, name, value);
        }
      }
      if (Object.keys(properties).length > 0) item.properties = properties;
      return item;
    };
    const microdata = [...document.querySelectorAll('[itemscope]')]
      .filter((scope) => !scope.hasAttribute('itemprop'))
      .map(readMicrodata);
    if (microdata.length > 0) result.microdata = microdata;

    const currencyElements = [
      ...document.querySelectorAll('[itemprop~="priceCurrency" i], meta[property="product:price:currency" i]'),
    ];
    const globalCurrency = currencyElements.map(elementValue).find(Boolean) ?? '';
    const inferCurrency = (raw: string, element: Element): string => {
      const localScope = element.closest('[itemscope]');
      const localCurrency = localScope?.querySelector('[itemprop~="priceCurrency" i]');
      const explicit = normalize(
        element.getAttribute('data-currency')
        || element.getAttribute('currency')
        || (localCurrency ? elementValue(localCurrency) : '')
        || globalCurrency,
      );
      if (explicit) return explicit.toUpperCase();
      const code = raw.match(/\b[A-Z]{3}\b/i)?.[0];
      if (code) return code.toUpperCase();
      if (raw.includes('€')) return 'EUR';
      if (raw.includes('£')) return 'GBP';
      if (raw.includes('¥')) return 'JPY';
      if (raw.includes('₹')) return 'INR';
      if (raw.includes('₩')) return 'KRW';
      if (raw.includes('$')) return 'USD';
      return '';
    };
    const prices: NonNullable<StructuredData['prices']> = [];
    for (const element of document.querySelectorAll([
      '[itemprop~="price" i]',
      'meta[property="product:price:amount" i]',
      'meta[name="price" i]',
      '[data-price]',
      '[class*="price" i]',
      '[id*="price" i]',
    ].join(','))) {
      const raw = normalize(element.getAttribute('data-price') || elementValue(element));
      const amount = raw.match(/[-+]?(?:\d{1,3}(?:[,\s]\d{3})+|\d+)(?:[.,]\d+)?/)?.[0]?.replace(/\s/g, '');
      if (!amount) continue;
      prices.push({ amount, currency: inferCurrency(raw, element), selector: selectorFor(element) });
    }
    if (prices.length > 0) result.prices = prices;

    const dates: NonNullable<StructuredData['dates']> = [];
    for (const element of document.querySelectorAll([
      'time[datetime]',
      '[itemprop*="date" i]',
      'meta[property$="_time" i]',
      'meta[property*="date" i]',
      'meta[name*="date" i]',
      '[data-date]',
    ].join(','))) {
      const value = normalize(element.getAttribute('data-date') || elementValue(element));
      if (!value) continue;
      const label = normalize(
        element.getAttribute('itemprop')
        || element.getAttribute('property')
        || element.getAttribute('name')
        || element.getAttribute('aria-label')
        || element.getAttribute('title')
        || element.tagName.toLowerCase(),
      );
      dates.push({ value, label, selector: selectorFor(element) });
    }
    if (dates.length > 0) result.dates = dates;

    const authors = new Set<string>();
    const addAuthor = (value: unknown): void => {
      if (typeof value === 'string') {
        const author = normalize(value);
        if (author) authors.add(author);
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) addAuthor(entry);
        return;
      }
      if (isRecord(value)) addAuthor(value.name);
    };
    for (const element of document.querySelectorAll([
      'meta[name="author" i]',
      'meta[property="article:author" i]',
      '[rel~="author" i]',
      '[itemprop~="author" i]',
    ].join(','))) {
      const nameElement = element.hasAttribute('itemscope')
        ? element.querySelector('[itemprop~="name" i]')
        : null;
      const tag = element.tagName.toLowerCase();
      addAuthor(nameElement
        ? elementValue(nameElement)
        : tag === 'meta'
          ? elementValue(element)
          : normalize(element.textContent) || elementValue(element));
    }
    const collectJsonLdAuthors = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) collectJsonLdAuthors(entry);
        return;
      }
      if (!isRecord(value)) return;
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'author' || key === 'creator') addAuthor(entry);
        collectJsonLdAuthors(entry);
      }
    };
    collectJsonLdAuthors(jsonLd);
    if (authors.size > 0) result.authors = [...authors];

    return result;
  });
}

export async function extractForms(page: Page): Promise<unknown[]> {
  return page.locator('form').evaluateAll((forms) => forms.map((form) => ({
    action: (form as HTMLFormElement).action,
    method: (form as HTMLFormElement).method,
    name: form.getAttribute('name') ?? undefined,
    fields: [...form.querySelectorAll('input, select, textarea, button')].map((field) => ({
      tag: field.tagName.toLowerCase(),
      type: field.getAttribute('type') ?? undefined,
      name: field.getAttribute('name') ?? undefined,
      label: field.getAttribute('aria-label') ?? field.getAttribute('placeholder') ?? undefined,
      value: (field as HTMLInputElement).value ?? undefined,
    })),
  })));
}

export async function extractTables(page: Page): Promise<unknown[]> {
  return page.locator('table').evaluateAll((tables) => tables.map((table) => ({
    caption: table.querySelector('caption')?.textContent?.trim(),
    rows: [...table.querySelectorAll('tr')].map((row) => [...row.querySelectorAll('th,td')].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim() ?? '')),
  })));
}
