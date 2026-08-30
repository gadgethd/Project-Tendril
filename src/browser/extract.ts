import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { Page } from 'playwright';
import type { StructuredData } from '../types.js';
import { redactUrl, SENSITIVE_URL_KEY_PATTERN_SOURCE } from '../util.js';
import { detectInjectionWarnings, REDACTED_VALUE, SENSITIVE_CONTROL_PATTERN_SOURCE } from './content-safety.js';

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
  untrustedContent: true;
  warnings: string[];
}

const DEFAULT_EXTRACT_MAX_CHARS = 2_000_000;
const MAX_EXTRACT_DOM_NODES = 20_000;
const MAX_EXTRACT_DOM_DEPTH = 100;
const MAX_EXTRACT_ATTRIBUTES = 50;
const MAX_EXTRACT_LINKS = 256;
const MAX_EXTRACT_METADATA = 128;
const EXTRACT_TRUNCATION_WARNING = 'Extracted page content exceeded its work or output budget and was truncated.';
const SENSITIVE_CONTROL_PATTERN = new RegExp(SENSITIVE_CONTROL_PATTERN_SOURCE, 'i');

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function redactSensitiveText(value: string): string {
  const redacted = value
    .replace(/(?:https?:\/\/|\/|#|\?)[^\s"'<>]*/gi, (candidate) => candidate.includes('=') ? redactUrl(candidate) : candidate)
    .replace(/(\b(?:api[_-]?key|key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|secret|token|credential|signature|sig|code|awsaccesskeyid|googleaccessid)\s*[=:]\s*)([^\s&;,]+)/gi, '$1[redacted]');
  return redacted.includes('=') && !/\s/.test(redacted) ? redactUrl(redacted) : redacted;
}

function boundJsonArray<T>(items: T[], maxChars: number): T[] {
  const result: T[] = [];
  let used = 2;
  for (const item of items) {
    const size = JSON.stringify(item).length + (result.length ? 1 : 0);
    if (used + size > maxChars) break;
    result.push(item);
    used += size;
  }
  return result;
}

function boundJsonRecord(entries: Record<string, string>, maxChars: number): Record<string, string> {
  const result: Record<string, string> = {};
  let used = 2;
  for (const [rawKey, rawValue] of Object.entries(entries)) {
    const key = truncate(redactSensitiveText(rawKey), 256);
    const value = SENSITIVE_CONTROL_PATTERN.test(key) ? REDACTED_VALUE : redactSensitiveText(rawValue);
    const size = JSON.stringify(key).length + JSON.stringify(value).length + 1 + (used > 2 ? 1 : 0);
    if (used + size > maxChars) break;
    result[key] = value;
    used += size;
  }
  return result;
}

function capExtractedPage(result: ExtractedPage, maxChars: number): ExtractedPage {
  if (JSON.stringify(result).length <= maxChars) return result;
  if (!result.warnings.includes(EXTRACT_TRUNCATION_WARNING)) result.warnings.push(EXTRACT_TRUNCATION_WARNING);
  const optionalCollections: Array<() => boolean> = [
    () => {
      const keys = Object.keys(result.metadata);
      if (!keys.length) return false;
      delete result.metadata[keys[keys.length - 1]!];
      return true;
    },
    () => result.links.pop() !== undefined,
    () => {
      if (!Object.keys(result.structuredData).length) return false;
      result.structuredData = {};
      return true;
    },
    () => {
      if (result.excerpt === undefined) return false;
      delete result.excerpt;
      return true;
    },
    () => {
      if (result.byline === undefined) return false;
      delete result.byline;
      return true;
    },
    () => {
      if (result.siteName === undefined) return false;
      delete result.siteName;
      return true;
    },
    () => {
      if (result.language === undefined) return false;
      delete result.language;
      return true;
    },
  ];
  while (JSON.stringify(result).length > maxChars && optionalCollections.some((remove) => remove())) {
    // Collections are secondary to the three directly requested document representations.
  }
  const stringFields: Array<'html' | 'text' | 'markdown'> = ['html', 'text', 'markdown'];
  while (JSON.stringify(result).length > maxChars) {
    const active = stringFields.filter((field) => result[field].length > 0);
    if (!active.length) break;
    const overflow = JSON.stringify(result).length - maxChars;
    const share = Math.max(1, Math.ceil(overflow / active.length));
    for (const field of active) result[field] = result[field].slice(0, Math.max(0, result[field].length - share));
  }
  return result;
}

function boundStructuredValue(value: unknown, maxChars: number): unknown {
  interface BoundedValue { value: unknown; size: number }
  const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  let visited = 0;
  const boundedString = (raw: string, available: number): BoundedValue | undefined => {
    if (available < 2) return undefined;
    const value = redactSensitiveText(raw).slice(0, 4_096);
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(value.slice(0, middle)).length <= available) low = middle;
      else high = middle - 1;
    }
    const bounded = value.slice(0, low);
    return { value: bounded, size: JSON.stringify(bounded).length };
  };
  const visit = (entry: unknown, depth: number, available: number): BoundedValue | undefined => {
    visited += 1;
    if (visited > 50_000 || available <= 0 || depth > 12 || entry === undefined) return undefined;
    if (typeof entry === 'string') return boundedString(entry, available);
    if (entry === null) return available >= 4 ? { value: null, size: 4 } : undefined;
    if (typeof entry === 'boolean') {
      const size = entry ? 4 : 5;
      return size <= available ? { value: entry, size } : undefined;
    }
    if (typeof entry === 'number') {
      const value = Number.isFinite(entry) ? entry : null;
      const size = JSON.stringify(value).length;
      return size <= available ? { value, size } : undefined;
    }
    if (typeof entry !== 'object' || available < 2) return undefined;
    if (Array.isArray(entry)) {
      const result: unknown[] = [];
      let size = 2;
      for (let index = 0; index < Math.min(entry.length, 256); index += 1) {
        const separator = result.length ? 1 : 0;
        const item = visit(entry[index], depth + 1, available - size - separator);
        if (!item) continue;
        result.push(item.value);
        size += separator + item.size;
        if (size >= available) break;
      }
      return { value: result, size };
    }
    const result: Record<string, unknown> = {};
    let size = 2;
    let entries = 0;
    for (const rawKey of Object.keys(entry).slice(0, 256)) {
      if (['__proto__', 'prototype', 'constructor'].includes(rawKey)) continue;
      const keyValue = boundedString(rawKey.slice(0, 256), available - size);
      if (!keyValue || typeof keyValue.value !== 'string' || !keyValue.value) continue;
      const separator = entries ? 1 : 0;
      const overhead = separator + keyValue.size + 1;
      if (size + overhead > available) break;
      let item: unknown;
      try { item = (entry as Record<string, unknown>)[rawKey]; } catch { continue; }
      const bounded = SENSITIVE_CONTROL_PATTERN.test(keyValue.value)
        ? boundedString(REDACTED_VALUE, available - size - overhead)
        : visit(item, depth + 1, available - size - overhead);
      if (!bounded) continue;
      result[keyValue.value] = bounded.value;
      entries += 1;
      size += overhead + bounded.size;
      if (size >= available) break;
    }
    return { value: result, size };
  };
  const bounded = visit(value, 0, budget);
  if (!bounded || bounded.size > budget) return undefined;
  return bounded.value;
}

export async function extractPage(page: Page, options: { maxChars?: number } = {}): Promise<ExtractedPage> {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(1_000, Math.floor(options.maxChars!)) : DEFAULT_EXTRACT_MAX_CHARS;
  const documentBudget = Math.max(100, Math.floor(maxChars * 0.18));
  const collectionBudget = Math.max(100, Math.floor(maxChars * 0.12));
  const provenanceBudget = Math.max(100, Math.floor(maxChars * 0.1));
  const [captured, links, rawMetadata, rawStructuredData] = await Promise.all([
    page.evaluate((limits) => {
      let nodes = 0;
      let serializationRemaining = Math.max(0, limits.maxChars - 15);
      let truncated = false;
      const sensitiveControl = new RegExp(limits.sensitiveControlPattern, 'i');
      const sensitiveUrlKey = new RegExp(limits.sensitiveUrlKeyPattern, 'i');
      const isSensitiveControl = (element: Element): boolean => {
        if (!['input', 'select', 'textarea'].includes(element.tagName.toLowerCase())) return false;
        const descriptor = [
          element.getAttribute('type'), element.getAttribute('name'), element.getAttribute('id'),
          element.getAttribute('autocomplete'), element.getAttribute('aria-label'),
        ].map((value) => value?.slice(0, 500)).filter(Boolean).join(' ');
        return (element.tagName.toLowerCase() === 'input' && (element.getAttribute('type') ?? '').toLowerCase() === 'hidden')
          || sensitiveControl.test(descriptor);
      };
      const redactBrowserUrl = (value: string): string => {
        try {
          const url = new URL(value, /^https?:/i.test(document.baseURI) ? document.baseURI : 'https://redaction.invalid/');
          for (const key of [...url.searchParams.keys()]) {
            if (sensitiveUrlKey.test(key.slice(0, 500))) url.searchParams.set(key, '[redacted]');
          }
          const rawHash = url.hash.slice(1);
          const queryIndex = rawHash.indexOf('?');
          const prefix = queryIndex >= 0 ? rawHash.slice(0, queryIndex + 1) : '';
          const parameterText = queryIndex >= 0 ? rawHash.slice(queryIndex + 1) : rawHash;
          if (parameterText.includes('=')) {
            const hash = new URLSearchParams(parameterText);
            for (const key of [...hash.keys()]) {
              if (sensitiveUrlKey.test(key.slice(0, 500))) hash.set(key, '[redacted]');
            }
            url.hash = `${prefix}${hash.toString()}`;
          }
          return url.toString();
        } catch {
          return value;
        }
      };
      const redactBrowserText = (value: string): string => value
        .replace(/(?:https?:\/\/|\/|#|\?)[^\s"'<>]*/gi, (candidate) => candidate.includes('=') ? redactBrowserUrl(candidate) : candidate)
        .replace(/(\b(?:api[_-]?key|key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|secret|token|credential|signature|sig|code|awsaccesskeyid|googleaccessid)\s*[=:]\s*)([^\s&;,]+)/gi, '$1[redacted]');
      const encodedLength = (character: string, attribute: boolean): number => {
        if (character === '&') return 5;
        if (character === '<' || character === '>') return 4;
        if (attribute && character === '"') return 6;
        return character.length;
      };
      const fitEncoded = (value: string, available: number, attribute: boolean): { value: string; cost: number; complete: boolean } => {
        let cost = 0;
        let end = 0;
        for (const character of value) {
          const next = encodedLength(character, attribute);
          if (cost + next > available) break;
          cost += next;
          end += character.length;
        }
        return { value: value.slice(0, end), cost, complete: end === value.length };
      };
      const copyElement = (source: Element): Element | undefined => {
        const tag = source.tagName.toLowerCase().slice(0, 100);
        const elementCost = 5 + tag.length * 2;
        if (serializationRemaining < elementCost) { truncated = true; return undefined; }
        serializationRemaining -= elementCost;
        const clone = document.createElementNS(source.namespaceURI, tag);
        const setBoundedAttribute = (rawName: string, rawValue: string): boolean => {
          const name = rawName.slice(0, 200);
          const markupCost = name.length + 4;
          if (serializationRemaining <= markupCost) { truncated = true; return false; }
          const fitted = fitEncoded(rawValue, serializationRemaining - markupCost, true);
          clone.setAttribute(name, fitted.value);
          serializationRemaining -= markupCost + fitted.cost;
          if (!fitted.complete || rawName.length > name.length) truncated = true;
          return fitted.complete;
        };
        const attributeCount = Math.min(source.attributes.length, limits.maxAttributes);
        for (let index = 0; index < attributeCount; index += 1) {
          const attribute = source.attributes.item(index);
          if (!attribute) continue;
          const name = attribute.name.toLowerCase();
          const secretValue = sensitiveControl.test(name)
            || (isSensitiveControl(source) && name === 'value');
          const urlValue = ['href', 'src', 'action', 'formaction', 'poster'].includes(name);
          const boundedSource = attribute.value.slice(0, 2_048);
          const value = secretValue ? limits.redactedValue : urlValue ? redactBrowserUrl(boundedSource) : boundedSource;
          if (!setBoundedAttribute(attribute.name, value)) break;
          if (attribute.value.length > boundedSource.length) truncated = true;
        }
        if (source.attributes.length > limits.maxAttributes) truncated = true;
        if (isSensitiveControl(source) && !clone.hasAttribute('value')) {
          setBoundedAttribute('value', limits.redactedValue);
        }
        return clone;
      };
      const copyChildren = (source: Node, destination: Node, depth: number): void => {
        if (depth > limits.maxDepth) { truncated = true; return; }
        if (source.nodeType === 1 && isSensitiveControl(source as Element)) {
          const fitted = fitEncoded(limits.redactedValue, serializationRemaining, false);
          destination.appendChild(document.createTextNode(fitted.value));
          serializationRemaining -= fitted.cost;
          if (!fitted.complete) truncated = true;
          return;
        }
        for (const child of source.childNodes) {
          if (nodes >= limits.maxNodes || serializationRemaining <= 0) { truncated = true; break; }
          nodes += 1;
          if (child.nodeType === 3) {
            const sourceText = child.textContent ?? '';
            const boundedSource = sourceText.slice(0, Math.min(sourceText.length, serializationRemaining));
            const redacted = redactBrowserText(boundedSource);
            const fitted = fitEncoded(redacted, serializationRemaining, false);
            destination.appendChild(document.createTextNode(fitted.value));
            serializationRemaining -= fitted.cost;
            if (!fitted.complete || boundedSource.length < sourceText.length) truncated = true;
          } else if (child.nodeType === 1) {
            const childElement = child as Element;
            if (['script', 'style', 'noscript', 'template'].includes(childElement.tagName.toLowerCase())) continue;
            const clone = copyElement(childElement);
            if (!clone) break;
            destination.appendChild(clone);
            copyChildren(childElement, clone, depth + 1);
          }
        }
      };
      const root = copyElement(document.documentElement);
      if (root) copyChildren(document.documentElement, root, 0);
      const serialized = `${document.doctype ? '<!DOCTYPE html>' : ''}${root ? (root as HTMLElement).outerHTML : ''}`;
      if (serialized.length > limits.maxChars) truncated = true;
      return { html: serialized.slice(0, limits.maxChars), truncated };
    }, {
      redactedValue: REDACTED_VALUE,
      maxChars: documentBudget,
      maxNodes: MAX_EXTRACT_DOM_NODES,
      maxDepth: MAX_EXTRACT_DOM_DEPTH,
      maxAttributes: MAX_EXTRACT_ATTRIBUTES,
      sensitiveControlPattern: SENSITIVE_CONTROL_PATTERN_SOURCE,
      sensitiveUrlKeyPattern: SENSITIVE_URL_KEY_PATTERN_SOURCE,
    }),
    page.locator('a[href]').evaluateAll((anchors, limits) => {
      const result: Array<{ text: string; url: string }> = [];
      for (const anchor of anchors.slice(0, limits.maxLinks)) {
        const url = (anchor as HTMLAnchorElement).href;
        if (!url) continue;
        result.push({
          text: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
          url: url.slice(0, 2_048),
        });
      }
      return result;
    }, { maxLinks: MAX_EXTRACT_LINKS }),
    page.evaluate((limits) => {
      const result: Record<string, string> = {};
      const sensitiveControl = new RegExp(limits.sensitiveControlPattern, 'i');
      for (const meta of [...document.querySelectorAll('meta[name], meta[property]')].slice(0, limits.maxMetadata)) {
        const key = meta.getAttribute('name') ?? meta.getAttribute('property');
        const value = meta.getAttribute('content');
        if (key && value) result[key.slice(0, 200)] = sensitiveControl.test(key.slice(0, 500))
          ? '[redacted]'
          : value.slice(0, 2_000);
      }
      return result;
    }, { maxMetadata: MAX_EXTRACT_METADATA, sensitiveControlPattern: SENSITIVE_CONTROL_PATTERN_SOURCE }),
    extractStructured(page),
  ]);
  const html = captured.html;
  const structuredData = (boundStructuredValue(rawStructuredData, collectionBudget) ?? {}) as StructuredData;
  const boundedLinks = boundJsonArray(
    links.map((link) => ({ text: link.text, url: truncate(redactUrl(link.url), 2_048) })),
    collectionBudget,
  );
  const metadata = boundJsonRecord(rawMetadata, collectionBudget);
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
    url: truncate(redactUrl(page.url()), Math.min(2_048, provenanceBudget)),
    title: truncate(redactSensitiveText(article?.title || await page.title()), Math.min(512, provenanceBudget)),
    html: truncate(articleHtml, documentBudget),
    text: truncate(text, documentBudget),
    markdown: truncate(turndown.turndown(articleHtml).replace(/\n{3,}/g, '\n\n').trim(), documentBudget),
    links: boundedLinks,
    metadata,
    structuredData,
    untrustedContent: true,
    warnings: [],
  };
  if (article?.byline) result.byline = truncate(redactSensitiveText(article.byline), 1_000);
  if (article?.excerpt) result.excerpt = truncate(redactSensitiveText(article.excerpt), 2_000);
  if (article?.siteName) result.siteName = truncate(redactSensitiveText(article.siteName), 500);
  if (article?.lang) result.language = truncate(article.lang, 100);
  result.warnings = detectInjectionWarnings({
    html: result.html,
    text: result.text,
    markdown: result.markdown,
    metadata: result.metadata,
    structuredData: result.structuredData,
  });
  if (captured.truncated || articleHtml.length > documentBudget || text.length > documentBudget) {
    result.warnings.push(EXTRACT_TRUNCATION_WARNING);
  }
  return capExtractedPage(result, maxChars);
}

export async function extractStructured(page: Page, options: { maxChars?: number } = {}): Promise<StructuredData> {
  const raw = await page.evaluate((limits) => {
    const result: StructuredData = {};
    let remainingWork = limits.maxWork;
    let remainingChars = limits.maxRawChars;
    const isRecord = (value: unknown): value is Record<string, unknown> => (
      typeof value === 'object' && value !== null && !Array.isArray(value)
    );
    const spend = (amount = 1): boolean => {
      if (remainingWork < amount) return false;
      remainingWork -= amount;
      return true;
    };
    const sensitiveControl = new RegExp(limits.sensitiveControlPattern, 'i');
    const sensitiveUrlKey = new RegExp(limits.sensitiveUrlKeyPattern, 'i');
    const isSensitiveControl = (element: Element): boolean => {
      const tag = element.tagName.toLowerCase();
      if (!['input', 'select', 'textarea'].includes(tag)) return false;
      const descriptor = [
        element.getAttribute('type'), element.getAttribute('name'), element.getAttribute('id'),
        element.getAttribute('autocomplete'), element.getAttribute('aria-label'),
      ].map((value) => value?.slice(0, 500)).filter(Boolean).join(' ');
      return (tag === 'input' && (element.getAttribute('type') ?? '').toLowerCase() === 'hidden')
        || sensitiveControl.test(descriptor);
    };
    const redactBrowserUrl = (value: string): string => {
      const redactParameters = (parameters: URLSearchParams): void => {
        for (const key of [...parameters.keys()]) {
          if (sensitiveUrlKey.test(key.slice(0, 500))) parameters.set(key, '[redacted]');
        }
      };
      try {
        const absolute = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) || value.startsWith('//');
        const url = new URL(value, /^https?:/i.test(document.baseURI) ? document.baseURI : 'https://redaction.invalid/');
        redactParameters(url.searchParams);
        const hash = url.hash.slice(1);
        const queryIndex = hash.indexOf('?');
        const prefix = queryIndex >= 0 ? hash.slice(0, queryIndex + 1) : '';
        const parameterText = queryIndex >= 0 ? hash.slice(queryIndex + 1) : hash;
        if (parameterText.includes('=')) {
          const parameters = new URLSearchParams(parameterText);
          redactParameters(parameters);
          url.hash = `${prefix}${parameters.toString()}`;
        }
        if (absolute) return url.toString();
        if (value.startsWith('#')) return url.hash;
        if (value.startsWith('?')) return `${url.search}${url.hash}`;
        const relative = `${url.pathname}${url.search}${url.hash}`;
        return value.startsWith('/') ? relative : relative.replace(/^\//, '');
      } catch { return value; }
    };
    const normalize = (value: string | null | undefined): string => {
      if (remainingChars <= 0) return '';
      const source = (value ?? '').slice(0, limits.maxValueChars * 4);
      const redacted = source.replace(/(?:https?:\/\/|\/|#|\?)[^\s"'<>]*/gi, (candidate) => (
        candidate.includes('=') ? redactBrowserUrl(candidate) : candidate
      ));
      const normalized = redacted.replace(/\s+/g, ' ').trim()
        .slice(0, Math.min(limits.maxValueChars, remainingChars));
      remainingChars -= normalized.length;
      return normalized;
    };
    const boundedText = (element: Element): string => {
      if (isSensitiveControl(element)) return normalize(limits.redactedValue);
      const parts: string[] = [];
      const pending: Node[] = [];
      let current: Node | null = element.firstChild;
      let chars = 0;
      while (current && chars < limits.maxValueChars && spend()) {
        const node = current;
        const sibling = node.nextSibling;
        if (node.nodeType === 3) {
          const text = (node.textContent ?? '').slice(0, limits.maxValueChars - chars);
          parts.push(text);
          chars += text.length;
          current = sibling ?? pending.pop() ?? null;
        } else if (node.nodeType === 1 && (node as Element).firstChild) {
          if (isSensitiveControl(node as Element)) {
            parts.push(limits.redactedValue);
            chars += limits.redactedValue.length;
            current = sibling ?? pending.pop() ?? null;
          } else {
            if (sibling) pending.push(sibling);
            current = (node as Element).firstChild;
          }
        } else current = sibling ?? pending.pop() ?? null;
      }
      return normalize(parts.join(' '));
    };
    const elementValue = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      if (isSensitiveControl(element)) return normalize(limits.redactedValue);
      if (tag === 'meta') return normalize(element.getAttribute('content'));
      if (tag === 'time') return normalize(element.getAttribute('datetime')) || boundedText(element);
      if (tag === 'data' || tag === 'meter') return normalize(element.getAttribute('value')) || boundedText(element);
      if (tag === 'a' || tag === 'area' || tag === 'link') {
        return normalize(redactBrowserUrl((element as HTMLAnchorElement).href || element.getAttribute('href') || ''));
      }
      if (['audio', 'embed', 'iframe', 'img', 'source', 'track', 'video'].includes(tag)) {
        return normalize(redactBrowserUrl((element as HTMLImageElement).src || element.getAttribute('src') || ''));
      }
      if (tag === 'object') return normalize(redactBrowserUrl(element.getAttribute('data') || ''));
      return normalize(element.getAttribute('content') || element.getAttribute('value')) || boundedText(element);
    };
    const elements: Element[] = [];
    const pending: Element[] = document.documentElement ? [document.documentElement] : [];
    while (pending.length > 0 && elements.length < limits.maxDomNodes && spend()) {
      const element = pending.pop()!;
      elements.push(element);
      const available = limits.maxDomNodes - elements.length - pending.length;
      const count = Math.min(element.children.length, Math.max(0, available));
      for (let index = count - 1; index >= 0; index -= 1) {
        const child = element.children.item(index);
        if (child) pending.push(child);
      }
    }
    const select = (predicate: (element: Element) => boolean, maximum = limits.maxItems): Element[] => {
      const selected: Element[] = [];
      for (const element of elements) {
        if (!spend()) break;
        if (predicate(element)) selected.push(element);
        if (selected.length >= maximum) break;
      }
      return selected;
    };
    const attr = (element: Element, name: string): string => element.getAttribute(name) ?? '';
    const tokens = (value: string): string[] => value.toLowerCase().split(/\s+/).filter(Boolean);
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
          let position = 1;
          let sibling = current.previousElementSibling;
          while (sibling && spend()) {
            if (sibling.tagName === current.tagName) position += 1;
            sibling = sibling.previousElementSibling;
          }
          if (position > 1) part += `:nth-of-type(${position})`;
        }
        parts.unshift(part);
        if (!parent || part === 'body') break;
        current = parent;
      }
      return parts.join(' > ');
    };

    const jsonLd: Record<string, unknown>[] = [];
    let jsonChars = 0;
    for (const script of select((element) => element.tagName.toLowerCase() === 'script'
      && attr(element, 'type').toLowerCase() === 'application/ld+json', limits.maxSections)) {
      try {
        const source = script.textContent ?? '';
        if (source.length > limits.maxJsonChars || jsonChars + source.length > limits.maxJsonCharsTotal) continue;
        jsonChars += source.length;
        remainingChars = Math.max(0, remainingChars - source.length);
        const parsed: unknown = JSON.parse(source);
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries.slice(0, limits.maxItems)) {
          if (isRecord(entry)) jsonLd.push(entry);
        }
      } catch {
        // Ignore malformed blocks without discarding other structured data.
      }
    }
    if (jsonLd.length > 0) result.jsonLd = jsonLd;

    const openGraph: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const meta of select((element) => element.tagName.toLowerCase() === 'meta'
      && (attr(element, 'property').toLowerCase().startsWith('og:') || attr(element, 'name').toLowerCase().startsWith('og:')))) {
      const property = normalize(meta.getAttribute('property') || meta.getAttribute('name')).toLowerCase();
      const content = normalize(meta.getAttribute('content'));
      const key = property.slice(3);
      if (key && content && !['__proto__', 'prototype', 'constructor'].includes(key)) openGraph[key] = content;
    }
    if (Object.keys(openGraph).length > 0) result.openGraph = openGraph;

    const addProperty = (properties: Record<string, unknown>, name: string, value: unknown): void => {
      if (!name || ['__proto__', 'prototype', 'constructor'].includes(name)) return;
      if (!(name in properties)) {
        properties[name] = value;
        return;
      }
      const previous = properties[name];
      properties[name] = Array.isArray(previous) ? [...previous, value] : [previous, value];
    };
    const nearestItemScope = (element: Element): Element | null => {
      let current = element.parentElement;
      while (current && spend()) {
        if (current.hasAttribute('itemscope')) return current;
        current = current.parentElement;
      }
      return null;
    };
    const microdataScopes = new Set<Element>();
    const readMicrodata = (scope: Element, depth = 0): Record<string, unknown> => {
      if (depth > limits.maxDepth || microdataScopes.has(scope) || !spend()) return {};
      microdataScopes.add(scope);
      const item: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const type = normalize(scope.getAttribute('itemtype'));
      const id = normalize(scope.getAttribute('itemid'));
      if (type) item.type = type;
      if (id) item.id = id;
      const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let propertyCount = 0;
      for (const propertyElement of elements) {
        if (propertyCount >= limits.maxItems || !spend()) break;
        if (!propertyElement.hasAttribute('itemprop') || nearestItemScope(propertyElement) !== scope) continue;
        const value = propertyElement.hasAttribute('itemscope')
          ? readMicrodata(propertyElement, depth + 1)
          : elementValue(propertyElement);
        for (const name of normalize(propertyElement.getAttribute('itemprop')).split(' ').filter(Boolean)) {
          addProperty(properties, name, value);
        }
        propertyCount += 1;
      }
      if (Object.keys(properties).length > 0) item.properties = properties;
      return item;
    };
    const microdata = select((scope) => scope.hasAttribute('itemscope') && !scope.hasAttribute('itemprop')).map(readMicrodata);
    if (microdata.length > 0) result.microdata = microdata;

    const currencyElements = select((element) => tokens(attr(element, 'itemprop')).includes('pricecurrency')
      || (element.tagName.toLowerCase() === 'meta' && attr(element, 'property').toLowerCase() === 'product:price:currency'));
    const globalCurrency = currencyElements.map(elementValue).find(Boolean) ?? '';
    const inferCurrency = (raw: string, element: Element): string => {
      const explicit = normalize(
        element.getAttribute('data-currency')
        || element.getAttribute('currency')
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
    for (const element of select((candidate) => tokens(attr(candidate, 'itemprop')).includes('price')
      || (candidate.tagName.toLowerCase() === 'meta' && ['product:price:amount', 'price'].includes(
        (attr(candidate, 'property') || attr(candidate, 'name')).toLowerCase(),
      ))
      || candidate.hasAttribute('data-price')
      || attr(candidate, 'class').toLowerCase().includes('price')
      || attr(candidate, 'id').toLowerCase().includes('price'))) {
      const raw = normalize(element.getAttribute('data-price') || elementValue(element));
      const amount = raw.match(/[-+]?(?:\d{1,3}(?:[,\s]\d{3})+|\d+)(?:[.,]\d+)?/)?.[0]?.replace(/\s/g, '');
      if (!amount) continue;
      prices.push({ amount, currency: inferCurrency(raw, element), selector: selectorFor(element) });
    }
    if (prices.length > 0) result.prices = prices;

    const dates: NonNullable<StructuredData['dates']> = [];
    for (const element of select((candidate) => (candidate.tagName.toLowerCase() === 'time' && candidate.hasAttribute('datetime'))
      || attr(candidate, 'itemprop').toLowerCase().includes('date')
      || (candidate.tagName.toLowerCase() === 'meta' && (
        attr(candidate, 'property').toLowerCase().endsWith('_time')
        || attr(candidate, 'property').toLowerCase().includes('date')
        || attr(candidate, 'name').toLowerCase().includes('date')
      ))
      || candidate.hasAttribute('data-date'))) {
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
    const addAuthor = (value: unknown, depth = 0): void => {
      if (depth > limits.maxDepth || authors.size >= limits.maxItems || !spend()) return;
      if (typeof value === 'string') {
        const author = normalize(value);
        if (author) authors.add(author);
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value.slice(0, limits.maxItems)) addAuthor(entry, depth + 1);
        return;
      }
      if (isRecord(value)) addAuthor(value.name, depth + 1);
    };
    for (const element of select((candidate) => (candidate.tagName.toLowerCase() === 'meta' && (
      attr(candidate, 'name').toLowerCase() === 'author' || attr(candidate, 'property').toLowerCase() === 'article:author'
    )) || tokens(attr(candidate, 'rel')).includes('author') || tokens(attr(candidate, 'itemprop')).includes('author'))) {
      const tag = element.tagName.toLowerCase();
      addAuthor(tag === 'meta' ? elementValue(element) : boundedText(element) || elementValue(element));
    }
    const collectJsonLdAuthors = (value: unknown, depth = 0): void => {
      if (depth > limits.maxDepth || authors.size >= limits.maxItems || !spend()) return;
      if (Array.isArray(value)) {
        for (const entry of value.slice(0, limits.maxItems)) collectJsonLdAuthors(entry, depth + 1);
        return;
      }
      if (!isRecord(value)) return;
      for (const [key, entry] of Object.entries(value).slice(0, limits.maxItems)) {
        if (!spend()) break;
        if (key === 'author' || key === 'creator') addAuthor(entry, depth + 1);
        collectJsonLdAuthors(entry, depth + 1);
      }
    };
    collectJsonLdAuthors(jsonLd);
    if (authors.size > 0) result.authors = [...authors];

    return result;
  }, {
    maxValueChars: 2_048,
    maxJsonChars: 100_000,
    maxJsonCharsTotal: 125_000,
    maxRawChars: 250_000,
    maxSections: 50,
    maxItems: 128,
    maxDepth: 12,
    maxDomNodes: MAX_EXTRACT_DOM_NODES,
    maxWork: 200_000,
    redactedValue: REDACTED_VALUE,
    sensitiveControlPattern: SENSITIVE_CONTROL_PATTERN_SOURCE,
    sensitiveUrlKeyPattern: SENSITIVE_URL_KEY_PATTERN_SOURCE,
  });
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(2, Math.floor(options.maxChars!)) : 250_000;
  return (boundStructuredValue(raw, maxChars) ?? {}) as StructuredData;
}

export async function extractForms(page: Page): Promise<unknown[]> {
  return page.locator('form').evaluateAll((forms, limits) => {
    const sensitiveControl = new RegExp(limits.sensitiveControlPattern, 'i');
    const sensitiveUrlKey = new RegExp(limits.sensitiveUrlKeyPattern, 'i');
    const redactBrowserUrl = (value: string): string => {
      try {
        const url = new URL(value, /^https?:/i.test(document.baseURI) ? document.baseURI : 'https://redaction.invalid/');
        for (const key of [...url.searchParams.keys()]) {
          if (sensitiveUrlKey.test(key.slice(0, 500))) url.searchParams.set(key, '[redacted]');
        }
        const rawHash = url.hash.slice(1);
        const queryIndex = rawHash.indexOf('?');
        const prefix = queryIndex >= 0 ? rawHash.slice(0, queryIndex + 1) : '';
        const parameterText = queryIndex >= 0 ? rawHash.slice(queryIndex + 1) : rawHash;
        if (parameterText.includes('=')) {
          const hash = new URLSearchParams(parameterText);
          for (const key of [...hash.keys()]) if (sensitiveUrlKey.test(key.slice(0, 500))) hash.set(key, '[redacted]');
          url.hash = `${prefix}${hash.toString()}`;
        }
        return url.toString();
      } catch { return value; }
    };
    return forms.slice(0, limits.maxForms).map((form) => ({
    action: redactBrowserUrl((form.getAttribute('action') ?? (form as HTMLFormElement).action ?? '').slice(0, 2_048)),
    method: ((form as HTMLFormElement).method ?? form.getAttribute('method') ?? '').slice(0, 20),
    name: form.getAttribute('name')?.slice(0, 500) ?? undefined,
    fields: [...form.querySelectorAll('input, select, textarea, button')].slice(0, limits.maxFields).map((field) => ({
      tag: field.tagName.toLowerCase().slice(0, 100),
      type: field.getAttribute('type')?.slice(0, 100) ?? undefined,
      name: field.getAttribute('name')?.slice(0, 500) ?? undefined,
      label: (field.getAttribute('aria-label') ?? field.getAttribute('placeholder'))?.slice(0, 1_000) ?? undefined,
      value: (field.tagName.toLowerCase() === 'input' && (field.getAttribute('type') ?? '').toLowerCase() === 'hidden')
        || sensitiveControl.test([
        field.getAttribute('type'), field.getAttribute('name'), field.getAttribute('id'),
        field.getAttribute('autocomplete'), field.getAttribute('aria-label'),
      ].map((value) => value?.slice(0, 500)).filter(Boolean).join(' '))
        ? '[redacted]'
        : (field as HTMLInputElement).value?.slice(0, 2_000) ?? undefined,
    })),
  }));
  }, {
    maxForms: 100, maxFields: 200,
    sensitiveControlPattern: SENSITIVE_CONTROL_PATTERN_SOURCE,
    sensitiveUrlKeyPattern: SENSITIVE_URL_KEY_PATTERN_SOURCE,
  });
}

export async function extractTables(page: Page): Promise<unknown[]> {
  return page.locator('table').evaluateAll((tables, limits) => {
    let remainingCells = limits.maxCells;
    const result: unknown[] = [];
    for (const table of tables.slice(0, limits.maxTables)) {
      const rows: string[][] = [];
      for (const row of [...table.querySelectorAll('tr')].slice(0, limits.maxRows)) {
        if (remainingCells <= 0) break;
        const cells = [...row.querySelectorAll('th,td')].slice(0, Math.min(limits.maxColumns, remainingCells))
          .map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim().slice(0, limits.maxCellChars) ?? '');
        remainingCells -= cells.length;
        rows.push(cells);
      }
      result.push({ caption: table.querySelector('caption')?.textContent?.trim().slice(0, 1_000), rows });
      if (remainingCells <= 0) break;
    }
    return result;
  }, { maxTables: 50, maxRows: 500, maxColumns: 100, maxCells: 5_000, maxCellChars: 1_000 });
}
