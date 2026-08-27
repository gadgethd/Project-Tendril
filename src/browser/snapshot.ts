import type { Frame, Page } from 'playwright';
import { newId } from '../util.js';
import type { ElementRef, SnapshotNode, SnapshotResult } from '../types.js';

export interface ElementTarget {
  pageId: string;
  frameUrl: string;
  frameIndex: number;
  selector: string;
  snapshotId: string;
  pageUrl: string;
}

interface RawNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  level?: number;
  selected?: boolean;
  selector?: string;
  children?: RawNode[];
}

interface SnapshotDiffSummary {
  added: number;
  removed: number;
  unchanged: number;
}

type SnapshotResultWithDiff = SnapshotResult & { diffSummary?: SnapshotDiffSummary };

function formatNode(node: SnapshotNode, depth = 0): string[] {
  const indent = '  '.repeat(depth);
  const attributes = [
    node.ref ? `[ref=${node.ref}]` : '',
    node.value ? `value=${JSON.stringify(node.value)}` : '',
    node.checked !== undefined ? `checked=${String(node.checked)}` : '',
    node.disabled ? 'disabled' : '',
    node.expanded !== undefined ? `expanded=${String(node.expanded)}` : '',
    node.selected ? 'selected' : '',
    node.level ? `level=${node.level}` : '',
  ].filter(Boolean).join(' ');
  const label = node.name ? ` ${JSON.stringify(node.name)}` : '';
  const line = `${indent}- ${node.role}${label}${attributes ? ` ${attributes}` : ''}`;
  return [line, ...(node.children ?? []).flatMap((child) => formatNode(child, depth + 1))];
}

function detectInjection(content: string): string[] {
  const warnings: string[] = [];
  if (/ignore (all |any )?(previous|prior) instructions/i.test(content)) warnings.push('Page content contains instruction-override language.');
  if (/(system prompt|developer message|tool call|exfiltrat|send (the )?(cookie|token|secret))/i.test(content)) warnings.push('Page content contains terms associated with prompt injection or data exfiltration.');
  return warnings;
}

function diffSnapshotLines(previousContent: string, currentContent: string): { content: string; summary: SnapshotDiffSummary } {
  const previousLines = previousContent.length === 0 ? [] : previousContent.split('\n');
  const currentLines = currentContent.length === 0 ? [] : currentContent.split('\n');
  const remainingPrevious = new Map<string, number>();
  const remainingCurrent = new Map<string, number>();
  for (const line of previousLines) remainingPrevious.set(line, (remainingPrevious.get(line) ?? 0) + 1);
  for (const line of currentLines) remainingCurrent.set(line, (remainingCurrent.get(line) ?? 0) + 1);

  let unchanged = 0;
  const added: string[] = [];
  for (const line of currentLines) {
    const count = remainingPrevious.get(line) ?? 0;
    if (count > 0) {
      unchanged += 1;
      remainingPrevious.set(line, count - 1);
    } else {
      added.push(line);
    }
  }

  const removed: string[] = [];
  for (const line of previousLines) {
    const count = remainingCurrent.get(line) ?? 0;
    if (count > 0) remainingCurrent.set(line, count - 1);
    else removed.push(line);
  }

  return {
    content: [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)].join('\n'),
    summary: { added: added.length, removed: removed.length, unchanged },
  };
}

async function snapshotFrame(frame: Frame, interactiveOnly: boolean, compact = false, maxDepth = 3): Promise<RawNode[]> {
  const depthLimit = Number.isFinite(maxDepth) ? Math.max(0, Math.floor(maxDepth)) : 3;
  return frame.locator('body').evaluate((body, snapshotOptions) => {
    const { onlyInteractive, useCompact, compactMaxDepth } = snapshotOptions;
    const interactiveRoles = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'tab', 'slider', 'spinbutton', 'switch', 'searchbox']);
    const implicitRole = (element: Element): string => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit.split(/\s+/)[0] ?? 'generic';
      const tag = element.tagName.toLowerCase();
      if (tag === 'a' && element.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
      if (tag === 'option') return 'option';
      if (tag === 'img') return 'img';
      if (tag === 'form') return 'form';
      if (tag === 'table') return 'table';
      if (tag === 'tr') return 'row';
      if (tag === 'th') return 'columnheader';
      if (tag === 'td') return 'cell';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'ul' || tag === 'ol') return 'list';
      if (tag === 'li') return 'listitem';
      if (tag === 'nav') return 'navigation';
      if (tag === 'main') return 'main';
      if (tag === 'article') return 'article';
      if (tag === 'input') {
        const type = (element.getAttribute('type') ?? 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (['button', 'submit', 'reset'].includes(type)) return 'button';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      return 'generic';
    };
    const selectorFor = (element: Element): string => {
      if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.documentElement) {
        let part = current.tagName.toLowerCase();
        const parent: Element | null = current.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((child) => child.tagName === current!.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(' > ');
    };
    const labelFor = (element: Element): string => {
      const aria = element.getAttribute('aria-label');
      if (aria) return aria.trim();
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const value = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
        if (value) return value;
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const label = element.labels?.[0]?.textContent?.trim();
        if (label) return label;
        if ('placeholder' in element && typeof element.placeholder === 'string' && element.placeholder) return element.placeholder;
      }
      return (element.getAttribute('alt') ?? element.getAttribute('title') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    };
    const visit = (element: Element, depth: number): RawNode[] => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || element.getAttribute('aria-hidden') === 'true') return [];
      const role = implicitRole(element);
      const interactive = interactiveRoles.has(role) || element.hasAttribute('tabindex') || element.hasAttribute('contenteditable');
      const children = [...element.children].flatMap((child) => visit(child, depth + 1));
      if (useCompact && depth > compactMaxDepth && !interactive) return children;
      const name = labelFor(element);
      const inlineText = useCompact && !interactive && children.length === 1 && children[0]?.role === 'text'
        ? children[0]
        : undefined;
      const meaningful = interactive || role !== 'generic' || (name.length > 0 && element.children.length === 0) || inlineText !== undefined;
      if (onlyInteractive && !interactive && children.length === 0) return [];
      if (!meaningful && children.length === 1) return children;
      if (!meaningful && children.length === 0) return [];
      const node: RawNode = { role: role === 'generic' && element.children.length === 0 ? 'text' : role };
      const nodeName = inlineText?.name ?? name;
      if (nodeName) node.name = nodeName;
      if (interactive) node.selector = selectorFor(element);
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        if (element.value) node.value = element.value.slice(0, 500);
        if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) node.checked = element.indeterminate ? 'mixed' : element.checked;
        if (element.disabled) node.disabled = true;
      }
      if (element.getAttribute('aria-expanded') !== null) node.expanded = element.getAttribute('aria-expanded') === 'true';
      if (element.getAttribute('aria-selected') === 'true') node.selected = true;
      if (element === document.activeElement) node.focused = true;
      if (role === 'heading') node.level = Number(element.tagName.slice(1)) || Number(element.getAttribute('aria-level')) || undefined;
      if (children.length && inlineText === undefined) node.children = children;
      if (useCompact && node.role === 'generic' && !node.name && !node.children?.length) return [];
      return [node];
    };
    return [...body.children].flatMap((child) => visit(child, 0));
  }, { onlyInteractive: interactiveOnly, useCompact: compact, compactMaxDepth: depthLimit });
}

export async function createSnapshot(options: {
  page: Page;
  pageId: string;
  mode: SnapshotResult['mode'];
  maxChars: number;
  previousContent?: string;
  compact?: boolean;
  maxDepth?: number;
}): Promise<{ result: SnapshotResultWithDiff; refs: Map<ElementRef, ElementTarget> }> {
  const snapshotId = newId('snap');
  const refs = new Map<ElementRef, ElementTarget>();
  const frames = options.page.frames();
  const nodes: SnapshotNode[] = [];
  let refCounter = 0;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex]!;
    let rawNodes: RawNode[];
    try {
      rawNodes = await snapshotFrame(frame, options.mode === 'interactive', options.compact ?? false, options.maxDepth ?? 3);
    } catch (error) {
      rawNodes = [{ role: 'document', name: `Snapshot unavailable: ${error instanceof Error ? error.message : String(error)}` }];
    }
    const convert = (raw: RawNode): SnapshotNode => {
      const node: SnapshotNode = { role: raw.role };
      if (raw.name) node.name = raw.name;
      if (raw.value) node.value = raw.value;
      if (raw.description) node.description = raw.description;
      if (raw.checked !== undefined) node.checked = raw.checked;
      if (raw.disabled !== undefined) node.disabled = raw.disabled;
      if (raw.expanded !== undefined) node.expanded = raw.expanded;
      if (raw.focused !== undefined) node.focused = raw.focused;
      if (raw.level !== undefined) node.level = raw.level;
      if (raw.selected !== undefined) node.selected = raw.selected;
      if (raw.selector) {
        const ref = `e${++refCounter}`;
        node.ref = ref;
        refs.set(ref, {
          pageId: options.pageId,
          frameUrl: frame.url(),
          frameIndex,
          selector: raw.selector,
          snapshotId,
          pageUrl: options.page.url(),
        });
      }
      if (raw.children?.length) node.children = raw.children.map(convert);
      return node;
    };
    const converted = rawNodes.map(convert);
    if (frames.length > 1) nodes.push({ role: 'document', name: frame.url(), children: converted });
    else nodes.push(...converted);
  }
  let content = nodes.flatMap((node) => formatNode(node)).join('\n');
  let diffSummary: SnapshotDiffSummary | undefined;
  if (options.mode === 'diff' && options.previousContent !== undefined) {
    const diff = diffSnapshotLines(options.previousContent, content);
    content = diff.content;
    diffSummary = diff.summary;
  }
  const warnings = detectInjection(content);
  const truncated = content.length > options.maxChars;
  const visibleContent = truncated ? content.slice(0, options.maxChars) : content;
  const result: SnapshotResultWithDiff = {
    snapshotId,
    pageId: options.pageId,
    url: options.page.url(),
    title: await options.page.title(),
    mode: options.mode,
    content: visibleContent,
    nodes: truncated ? undefined : nodes,
    truncated,
    untrustedContent: true,
    warnings,
  };
  if (diffSummary) result.diffSummary = diffSummary;
  if (truncated) result.cursor = Buffer.from(JSON.stringify({ snapshotId, offset: options.maxChars })).toString('base64url');
  return { result, refs };
}
