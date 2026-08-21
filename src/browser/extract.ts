import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { Page } from 'playwright';

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
}

export async function extractPage(page: Page): Promise<ExtractedPage> {
  const [html, links, metadata] = await Promise.all([
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
  ]);
  const { document } = parseHTML(html);
  let article: ReturnType<Readability['parse']> = null;
  try {
    article = new Readability(document as unknown as Document, { charThreshold: 20 }).parse();
  } catch {
    // Fall back to the body below.
  }
  const articleHtml = article?.content || document.body?.innerHTML || html;
  const text = (article?.textContent || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
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
  };
  if (article?.byline) result.byline = article.byline;
  if (article?.excerpt) result.excerpt = article.excerpt;
  if (article?.siteName) result.siteName = article.siteName;
  if (article?.lang) result.language = article.lang;
  return result;
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
