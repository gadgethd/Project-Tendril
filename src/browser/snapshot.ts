import type { ElementHandle, Frame, JSHandle, Page } from 'playwright';
import { TendrilError } from '../errors.js';
import type { ElementRef, SnapshotDiffSummary, SnapshotNode, SnapshotResult } from '../types.js';
import { newId, redactUrl } from '../util.js';
import { detectInjectionWarnings, REDACTED_VALUE, SENSITIVE_CONTROL_PATTERN_SOURCE } from './content-safety.js';

export interface ElementTarget {
  readonly pageId: string;
  readonly pageUrl: string;
  readonly page: Page;
  readonly frameUrl: string;
  readonly frameIndex: number;
  readonly frame: Frame;
  readonly ownerDocument: JSHandle<Document>;
  readonly element: ElementHandle<SVGElement | HTMLElement>;
  readonly selector?: string;
  readonly identityToken?: string;
  readonly fingerprint: string;
  readonly snapshotId: string;
}

export const ELEMENT_FINGERPRINT_OPTIONS = Object.freeze({
  maxTextChars: 500,
  maxComponentChars: 120,
  maxFingerprintChars: 64,
  attributes: Object.freeze([
    'type',
    'id',
    'name',
    'href',
    'src',
    'role',
    'title',
    'alt',
    'placeholder',
    'tabindex',
    'aria-label',
    'aria-labelledby',
    'aria-description',
    'aria-describedby',
    'aria-disabled',
    'aria-hidden',
    'aria-checked',
    'aria-pressed',
    'aria-expanded',
    'aria-selected',
    'aria-readonly',
    'aria-required',
    'contenteditable',
    'formaction',
    'formmethod',
    'target',
  ]),
  referenceAttributes: Object.freeze(['aria-labelledby', 'aria-describedby']),
});

export const SNAPSHOT_BOUNDS = Object.freeze({
  maxDomNodesTotal: 20_000,
  maxDomDepth: 100,
  maxRefsTotal: 5_000,
  maxSemanticCharsTotal: 1_000_000,
  maxFrames: 8,
  maxUrlChars: 2_048,
  maxTitleChars: 512,
  maxWarningChars: 512,
  maxWarnings: 8,
  maxFrameUrlCharsTotal: 4_096,
  maxWarningCharsTotal: 2_048,
  maxMetadataChars: 12_000,
});

interface RawNode {
  role: string;
  interactive?: boolean;
  domDepth?: number;
  transparent?: boolean;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  level?: number;
  selected?: boolean;
  pressed?: boolean | 'mixed';
  readonly?: boolean;
  required?: boolean;
  targetIndex?: number;
  fingerprint?: string;
  children?: RawNode[];
}

export interface SnapshotCreation {
  result: SnapshotResult;
  refs: Map<ElementRef, ElementTarget>;
  /** Browser handles which bind refs to their unforgeable originating documents. */
  documents: JSHandle<Document>[];
  /** Canonical comparison text. Ref generations are deliberately normalized. */
  canonicalContent: string;
  /** Canonical current snapshot with actionable generation-scoped refs. */
  displayContent: string;
  /** Full result content before caller-visible pagination. */
  fullContent: string;
}

const MAX_FORMATTED_LINE_CHARS = 900;
const MAX_STRUCTURED_SNAPSHOT_NODES = 500;

function boundedJsonString(value: string, maxChars: number): string {
  if (maxChars < 2) return '';
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(value.slice(0, middle)).length <= maxChars) low = middle;
    else high = middle - 1;
  }
  return JSON.stringify(value.slice(0, low));
}

function formatNodeLine(node: SnapshotNode, depth: number, scopedRefs: boolean): string {
  const indent = '  '.repeat(depth);
  const role = node.role.replace(/[\r\n]/g, ' ').slice(0, 100) || 'generic';
  const essentialAttributes = [
    node.ref ? (scopedRefs ? `[ref=${node.ref}]` : '[ref]') : '',
    node.checked !== undefined ? `checked=${String(node.checked)}` : '',
    node.disabled ? 'disabled' : '',
    node.expanded !== undefined ? `expanded=${String(node.expanded)}` : '',
    node.selected ? 'selected' : '',
    node.pressed !== undefined ? `pressed=${String(node.pressed)}` : '',
    node.readonly ? 'readonly' : '',
    node.required ? 'required' : '',
    node.level ? `level=${node.level}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const essentialSuffix = essentialAttributes ? ` ${essentialAttributes}` : '';
  let line = `${indent}- ${role}`;
  const appendJson = (prefix: string, value: string | undefined, preferredChars: number): void => {
    if (!value) return;
    const available = MAX_FORMATTED_LINE_CHARS - line.length - essentialSuffix.length - prefix.length;
    const encoded = boundedJsonString(value, Math.min(preferredChars, available));
    if (encoded) line += `${prefix}${encoded}`;
  };
  appendJson(' ', node.name, 300);
  appendJson(' description=', node.description, 200);
  line += essentialSuffix;
  if (node.value) {
    const available = MAX_FORMATTED_LINE_CHARS - line.length - ' value='.length;
    const encoded = boundedJsonString(node.value, available);
    if (encoded) line += ` value=${encoded}`;
  }
  return line;
}

function formatNodesBounded(
  nodes: SnapshotNode[],
  scopedRefs: boolean,
  maxChars: number,
  maxLines = Number.POSITIVE_INFINITY,
): { content: string; lineCount: number; truncated: boolean } {
  const lines: string[] = [];
  const pending = nodes.map((node) => ({ node, depth: 0 })).reverse();
  let used = 0;
  while (pending.length > 0 && lines.length < maxLines) {
    const current = pending.pop()!;
    const line = formatNodeLine(current.node, current.depth, scopedRefs);
    const cost = line.length + (lines.length ? 1 : 0);
    if (used + cost > maxChars) return { content: lines.join('\n'), lineCount: lines.length, truncated: true };
    lines.push(line);
    used += cost;
    const children = current.node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ node: children[index]!, depth: current.depth + 1 });
    }
  }
  return { content: lines.join('\n'), lineCount: lines.length, truncated: pending.length > 0 };
}

function countSnapshotNodes(nodes: SnapshotNode[], limit: number): number {
  let count = 0;
  const pending = [...nodes];
  while (pending.length > 0 && count <= limit) {
    const node = pending.pop()!;
    count += 1;
    for (const child of node.children ?? []) pending.push(child);
  }
  return count;
}

const DIFF_LOOKAHEAD = 128;

function diffSnapshotLines(previousContent: string, currentContent: string, currentDisplay: string): { content: string; summary: SnapshotDiffSummary } {
  // Both inputs are formatter-produced canonical snapshots whose capability token is exactly `[ref]`.
  // Avoid a broad regex here: page-authored text may legitimately contain strings such as `[ref=example]`.
  const previousLines = previousContent.split('\n').filter((line, index, lines) => !(lines.length === 1 && index === 0 && line === ''));
  const currentLines = currentContent.split('\n').filter((line, index, lines) => !(lines.length === 1 && index === 0 && line === ''));
  const displayLines = currentDisplay.split('\n').filter((line, index, lines) => !(lines.length === 1 && index === 0 && line === ''));
  const output: string[] = [];
  let previousIndex = 0;
  let currentIndex = 0;
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  const findWithin = (lines: string[], value: string, from: number): number => {
    const end = Math.min(lines.length, from + DIFF_LOOKAHEAD);
    for (let index = from; index < end; index += 1) if (lines[index] === value) return index;
    return -1;
  };

  while (previousIndex < previousLines.length && currentIndex < currentLines.length) {
    if (previousLines[previousIndex] === currentLines[currentIndex]) {
      previousIndex += 1;
      currentIndex += 1;
      unchanged += 1;
      continue;
    }

    const previousMatch = findWithin(previousLines, currentLines[currentIndex]!, previousIndex + 1);
    const currentMatch = findWithin(currentLines, previousLines[previousIndex]!, currentIndex + 1);
    const removeDistance = previousMatch < 0 ? Number.POSITIVE_INFINITY : previousMatch - previousIndex;
    const addDistance = currentMatch < 0 ? Number.POSITIVE_INFINITY : currentMatch - currentIndex;

    if (removeDistance !== Number.POSITIVE_INFINITY && removeDistance <= addDistance) {
      while (previousIndex < previousMatch) {
        output.push(`- ${previousLines[previousIndex++]!}`);
        removed += 1;
      }
    } else if (addDistance !== Number.POSITIVE_INFINITY) {
      while (currentIndex < currentMatch) {
        output.push(`+ ${displayLines[currentIndex] ?? currentLines[currentIndex]!}`);
        currentIndex += 1;
        added += 1;
      }
    } else {
      output.push(`- ${previousLines[previousIndex++]!}`);
      output.push(`+ ${displayLines[currentIndex] ?? currentLines[currentIndex]!}`);
      currentIndex += 1;
      removed += 1;
      added += 1;
    }
  }
  while (previousIndex < previousLines.length) {
    output.push(`- ${previousLines[previousIndex++]!}`);
    removed += 1;
  }
  while (currentIndex < currentLines.length) {
    output.push(`+ ${displayLines[currentIndex] ?? currentLines[currentIndex]!}`);
    currentIndex += 1;
    added += 1;
  }
  return { content: output.join('\n'), summary: { added, removed, unchanged } };
}

interface FrameSnapshot {
  nodes: RawNode[];
  elements: Array<ElementHandle<SVGElement | HTMLElement> | undefined>;
  document: JSHandle<Document>;
  visitedNodes: number;
  semanticChars: number;
  truncated: boolean;
}

async function snapshotFrame(frame: Frame, maxDomNodes: number, maxRefs: number, maxSemanticChars: number, selectorPrefix?: string): Promise<FrameSnapshot> {
  const payload = await frame.locator('body').evaluateHandle(
    (body, snapshotOptions) => {
      const { redactedValue, fingerprintOptions, maxDomNodes, maxDomDepth, maxRefs, selectorPrefix } = snapshotOptions;
      const targets: Element[] = [];
      let visitedNodes = 0;
      let auxiliaryScanRemaining = maxDomNodes * 8;
      let semanticCharsRemaining = snapshotOptions.maxSemanticChars;
      let truncated = false;
      const sensitiveControl = new RegExp(snapshotOptions.sensitiveControlPattern, 'i');
      const interactiveRoles = new Set([
        'button',
        'link',
        'textbox',
        'checkbox',
        'radio',
        'combobox',
        'listbox',
        'option',
        'menuitem',
        'tab',
        'slider',
        'spinbutton',
        'switch',
        'searchbox',
        'treeitem',
        'gridcell',
      ]);
      const normalize = (value: string | null | undefined): string =>
        (value ?? '')
          .slice(0, fingerprintOptions.maxTextChars * 4)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, fingerprintOptions.maxTextChars);
      const escapeIdentifier = (value: string): string =>
        typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
      const findReferenced = (element: Element, id: string): Element | null => {
        const root = element.getRootNode();
        if ('getElementById' in root && typeof root.getElementById === 'function') return root.getElementById(id);
        return element.ownerDocument.getElementById(id) ?? (root as Document | ShadowRoot).querySelector?.(`#${escapeIdentifier(id)}`) ?? null;
      };
      const implicitRole = (element: Element): string => {
        const explicit = element.getAttribute('role');
        if (explicit) return explicit.slice(0, 500).split(/\s+/)[0] ?? 'generic';
        const tag = element.tagName.toLowerCase();
        if (tag === 'a' && element.hasAttribute('href')) return 'link';
        if (tag === 'button' || tag === 'summary') return 'button';
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
        if (tag === 'aside') return 'complementary';
        if (tag === 'progress') return 'progressbar';
        if (tag === 'input') {
          const type = (element.getAttribute('type') ?? 'text').slice(0, 100).toLowerCase();
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
          if (type === 'range') return 'slider';
          if (type === 'number') return 'spinbutton';
          if (type === 'search') return 'searchbox';
          return 'textbox';
        }
        return 'generic';
      };
      const isInteractive = (element: Element): boolean => {
        const role = implicitRole(element);
        return (
          interactiveRoles.has(role) ||
          element.hasAttribute('tabindex') ||
          (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false')
        );
      };
      const isSensitiveControl = (element: Element): boolean => {
        if (!['input', 'select', 'textarea'].includes(element.tagName.toLowerCase())) return false;
        return (
          (element.tagName.toLowerCase() === 'input' && (element.getAttribute('type') ?? '').toLowerCase() === 'hidden') ||
          sensitiveControl.test(
            [
              element.getAttribute('type'),
              element.getAttribute('name'),
              element.getAttribute('id'),
              element.getAttribute('autocomplete'),
              element.getAttribute('aria-label'),
            ]
              .map((value) => value?.slice(0, 500))
              .filter(Boolean)
              .join(' '),
          )
        );
      };
      const boundedNodeText = (element: Element, skipActions: boolean, maxChars = fingerprintOptions.maxTextChars * 4): string => {
        const parts: string[] = [];
        const pending: Node[] = [];
        let current: Node | null = element.firstChild;
        let inspected = 0;
        let partChars = 0;
        while (current && inspected < maxDomNodes && auxiliaryScanRemaining > 0 && partChars < maxChars) {
          const node: Node = current;
          const sibling: Node | null = node.nextSibling;
          inspected += 1;
          auxiliaryScanRemaining -= 1;
          if (node.nodeType === 3) {
            const text = (node.textContent ?? '').slice(0, maxChars - partChars);
            parts.push(text);
            partChars += text.length;
            current = sibling ?? pending.pop() ?? null;
            continue;
          }
          const canDescend = node instanceof Element && (!skipActions || !isInteractive(node)) && node.firstChild;
          if (canDescend) {
            if (sibling) pending.push(sibling);
            current = node.firstChild;
          } else current = sibling ?? pending.pop() ?? null;
        }
        if (current || pending.length) truncated = true;
        return normalize(parts.join(' '));
      };
      const directText = (element: Element): string => boundedNodeText(element, false);
      const descendantTextWithoutActions = (element: Element): string => boundedNodeText(element, true);
      const referencedText = (element: Element, attribute: string): string => {
        const ids = (element.getAttribute(attribute) ?? '')
          .slice(0, fingerprintOptions.maxTextChars * 4)
          .split(/\s+/)
          .filter(Boolean);
        const parts: string[] = [];
        let remaining = fingerprintOptions.maxTextChars * 4;
        for (const id of ids) {
          const referenced = findReferenced(element, id.slice(0, 500));
          if (!referenced || remaining <= 0) continue;
          const text = boundedNodeText(referenced, false, remaining);
          if (text) {
            parts.push(text);
            remaining -= text.length;
          }
        }
        return normalize(parts.join(' '));
      };
      const labelFor = (element: Element, role: string): string => {
        const labelledBy = referencedText(element, 'aria-labelledby');
        if (labelledBy) return labelledBy;
        const aria = normalize(element.getAttribute('aria-label'));
        if (aria) return aria;
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          const label = element.labels?.[0] ? boundedNodeText(element.labels[0], false) : '';
          if (label) return label;
          const placeholder = 'placeholder' in element ? normalize(element.placeholder) : '';
          if (placeholder) return placeholder;
        }
        const alternate = normalize(element.getAttribute('alt') ?? element.getAttribute('title'));
        if (alternate) return alternate;
        if (isSensitiveControl(element)) return '';
        if (interactiveRoles.has(role) || ['heading', 'img', 'columnheader', 'cell'].includes(role)) return descendantTextWithoutActions(element);
        return element.children.length === 0 && !element.shadowRoot ? directText(element) : '';
      };
      const descriptionFor = (element: Element): string => normalize(element.getAttribute('aria-description')) || referencedText(element, 'aria-describedby');
      const fingerprintFor = (element: Element): string => {
        const tag = element.tagName.toLowerCase();
        const type = (element.getAttribute('type') ?? '').slice(0, 100).toLowerCase();
        const labels: string[] = [];
        const elementLabels = 'labels' in element ? (element.labels as NodeListOf<HTMLLabelElement> | null) : null;
        if (elementLabels) {
          for (let index = 0; index < Math.min(elementLabels.length, 50); index += 1) {
            const label = elementLabels[index];
            if (label) labels.push(boundedNodeText(label, false));
          }
        }
        const semanticValue =
          tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type)
            ? (element as HTMLInputElement).value
            : tag === 'option'
              ? (element as HTMLOptionElement).value
              : '';
        const parts: Array<string | boolean> = [
          'semantic-v2',
          tag,
          ...fingerprintOptions.attributes.map((attribute) => normalize(element.getAttribute(attribute))),
          ...fingerprintOptions.referenceAttributes.map((attribute) => referencedText(element, attribute)),
          boundedNodeText(element, false),
          normalize(labels.join(' ')),
          normalize(semanticValue),
          'disabled' in element && Boolean(element.disabled),
          'checked' in element && Boolean(element.checked),
          'selected' in element && Boolean(element.selected),
          'readOnly' in element && Boolean(element.readOnly),
          'required' in element && Boolean(element.required),
          'isContentEditable' in element && Boolean(element.isContentEditable),
          (element as HTMLElement).hidden,
        ];
        let primary = 0x811c9dc5;
        let secondary = 0x9e3779b9;
        let length = 0;
        for (const rawPart of parts) {
          const part = String(rawPart).slice(0, fingerprintOptions.maxComponentChars);
          length += part.length;
          for (let index = 0; index <= part.length; index += 1) {
            const code = index === part.length ? 0xffff : part.charCodeAt(index);
            primary = Math.imul(primary ^ code, 0x01000193) >>> 0;
            secondary = Math.imul(secondary ^ code, 0x85ebca6b) >>> 0;
          }
        }
        return `semantic-v3:${primary.toString(16).padStart(8, '0')}:${secondary.toString(16).padStart(8, '0')}:${length}`.slice(
          0,
          fingerprintOptions.maxFingerprintChars,
        );
      };
      const takeSemantic = (value: string, maxChars: number): string => {
        if (semanticCharsRemaining <= 0) {
          if (value) truncated = true;
          return '';
        }
        const bounded = value.slice(0, Math.min(maxChars, semanticCharsRemaining));
        semanticCharsRemaining -= bounded.length;
        if (bounded.length < value.length) truncated = true;
        return bounded;
      };
      const descendants = (element: Element): Element[] => {
        const result: Element[] = [];
        const remaining = Math.max(0, maxDomNodes - visitedNodes);
        const append = (children: HTMLCollection): void => {
          const before = result.length;
          for (let index = 0; index < children.length && result.length < remaining; index += 1) {
            const child = children.item(index);
            if (child) result.push(child);
          }
          if (children.length > result.length - before) truncated = true;
        };
        append(element.children);
        if (element.shadowRoot) {
          if (result.length < remaining) append(element.shadowRoot.children);
          else if (element.shadowRoot.children.length > 0) truncated = true;
        }
        return result;
      };
      const ariaBoolean = (element: Element, name: string): boolean | undefined => {
        const value = element.getAttribute(name);
        return value === 'true' ? true : value === 'false' ? false : undefined;
      };
      const ariaTriState = (element: Element, name: string): boolean | 'mixed' | undefined => {
        const value = element.getAttribute(name);
        return value === 'mixed' ? 'mixed' : value === 'true' ? true : value === 'false' ? false : undefined;
      };
      const visit = (element: Element, depth: number, actionsOnly = false): RawNode[] => {
        if (depth > maxDomDepth || visitedNodes >= maxDomNodes || semanticCharsRemaining < 8) {
          truncated = true;
          return [];
        }
        visitedNodes += 1;
        const style = getComputedStyle(element);
        const inputType = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          (element as HTMLElement).hidden ||
          inputType === 'hidden' ||
          element.getAttribute('aria-hidden') === 'true'
        )
          return [];
        const role = implicitRole(element);
        const interactive = isInteractive(element);
        const sensitive = isSensitiveControl(element);
        const rawName = labelFor(element, role);
        const consumesDescendantName = interactive || ['heading', 'img', 'columnheader', 'cell'].includes(role);
        const childElements = sensitive ? [] : descendants(element);
        const children = childElements.flatMap((child) => visit(child, depth + 1, actionsOnly || consumesDescendantName));
        if (actionsOnly && !interactive) return children;
        const meaningful = interactive || role !== 'generic' || rawName.length > 0;
        if (!meaningful && children.length === 1) {
          return [{ role: 'generic', domDepth: depth, transparent: true, children }];
        }
        if (!meaningful && children.length === 0) return [];
        const name = takeSemantic(rawName, fingerprintOptions.maxTextChars);
        const description = takeSemantic(descriptionFor(element), fingerprintOptions.maxTextChars);
        const node: RawNode = {
          role: takeSemantic(role === 'generic' && childElements.length === 0 ? 'text' : role, 100),
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          ...(interactive ? { interactive: true } : {}),
          domDepth: depth,
        };
        if (interactive) {
          if (targets.length < maxRefs) {
            const fingerprint = fingerprintFor(element);
            if (fingerprint.length <= semanticCharsRemaining) {
              semanticCharsRemaining -= fingerprint.length;
              node.targetIndex = targets.push(element) - 1;
              if (selectorPrefix) {
                const token = `${selectorPrefix}:${node.targetIndex}`;
                element.setAttribute('data-tendril-ref', token);
              }
              node.fingerprint = fingerprint;
            } else truncated = true;
          } else truncated = true;
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          if (sensitive) node.value = takeSemantic(redactedValue, 500);
          else if (element.value) node.value = takeSemantic(element.value, 500);
          if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(inputType)) {
            node.checked = element.indeterminate ? 'mixed' : element.checked;
          }
          if (element.disabled) node.disabled = true;
          if ('readOnly' in element && element.readOnly) node.readonly = true;
          if ('required' in element && element.required) node.required = true;
        }
        node.checked ??= ariaTriState(element, 'aria-checked');
        node.pressed = ariaTriState(element, 'aria-pressed');
        if (ariaBoolean(element, 'aria-disabled') === true) node.disabled = true;
        if (ariaBoolean(element, 'aria-readonly') === true) node.readonly = true;
        if (ariaBoolean(element, 'aria-required') === true) node.required = true;
        const expanded = ariaBoolean(element, 'aria-expanded');
        if (expanded !== undefined) node.expanded = expanded;
        if (ariaBoolean(element, 'aria-selected') === true) node.selected = true;
        const root = element.getRootNode() as Document | ShadowRoot;
        if ('activeElement' in root && root.activeElement === element) node.focused = true;
        if (role === 'heading') node.level = Number(element.tagName.slice(1)) || Number(element.getAttribute('aria-level')) || undefined;
        if (children.length) node.children = children;
        return [node];
      };
      return {
        nodes: descendants(body).flatMap((child) => visit(child, 0)),
        targets,
        document: body.ownerDocument,
        visitedNodes,
        semanticChars: snapshotOptions.maxSemanticChars - semanticCharsRemaining,
        truncated,
      };
    },
    {
      redactedValue: REDACTED_VALUE,
      fingerprintOptions: ELEMENT_FINGERPRINT_OPTIONS,
      maxDomNodes,
      maxDomDepth: SNAPSHOT_BOUNDS.maxDomDepth,
      maxRefs,
      maxSemanticChars,
      sensitiveControlPattern: SENSITIVE_CONTROL_PATTERN_SOURCE,
      selectorPrefix,
    },
  );

  const elements: Array<ElementHandle<SVGElement | HTMLElement> | undefined> = [];
  let targetsHandle;
  let documentHandle: JSHandle<Document> | undefined;
  try {
    const captured = await payload.evaluate((value) => ({
      nodes: value.nodes as RawNode[],
      visitedNodes: value.visitedNodes,
      semanticChars: value.semanticChars,
      truncated: value.truncated,
    }));
    targetsHandle = await payload.getProperty('targets');
    documentHandle = (await payload.getProperty('document')) as JSHandle<Document>;
    const properties = await targetsHandle.getProperties();
    for (const [key, handle] of properties) {
      if (!/^\d+$/.test(key)) {
        await handle.dispose();
        continue;
      }
      const element = handle.asElement();
      if (element) elements[Number(key)] = element as ElementHandle<SVGElement | HTMLElement>;
      else await handle.dispose();
    }
    return {
      nodes: captured.nodes,
      elements,
      document: documentHandle,
      visitedNodes: captured.visitedNodes,
      semanticChars: captured.semanticChars,
      truncated: captured.truncated,
    };
  } catch (error) {
    await Promise.all(
      elements
        .filter((element): element is ElementHandle<SVGElement | HTMLElement> => element !== undefined)
        .map((element) => element.dispose().catch(() => undefined)),
    );
    await documentHandle?.dispose().catch(() => undefined);
    throw error;
  } finally {
    await targetsHandle?.dispose();
    await payload.dispose();
  }
}

function projectRawNodes(nodes: RawNode[], options: { interactiveOnly: boolean; compact: boolean; maxDepth: number }, depth = 0): RawNode[] {
  return nodes.flatMap((raw): RawNode[] => {
    let children = projectRawNodes(raw.children ?? [], options, depth + 1);
    if (options.interactiveOnly && !raw.interactive && children.length === 0) return [];
    if (options.compact && (raw.domDepth ?? depth) > options.maxDepth && !raw.interactive) return children;
    let name = raw.name;
    if (options.compact && !raw.interactive && children.length === 1 && children[0]?.role === 'text') {
      name = children[0].name ?? name;
      children = [];
    }
    if (raw.transparent && !options.compact) return children;
    return [{ ...raw, ...(name ? { name } : {}), ...(children.length ? { children } : { children: undefined }) }];
  });
}

function boundedSnapshotString(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(?:https?:\/\/|\/|#|\?)[^\s"'<>]*/gi, (candidate) => (candidate.includes('=') ? redactUrl(candidate) : candidate))
    .replace(
      /(\b(?:api[_-]?key|key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|secret|token|credential|signature|sig|code|awsaccesskeyid|googleaccessid)\s*[=:]\s*)([^\s&;,]+)/gi,
      '$1[redacted]',
    );
}

export function boundedSnapshotUrl(value: string, maxChars: number = SNAPSHOT_BOUNDS.maxUrlChars): string {
  return boundedSnapshotString(redactUrl(value), Math.min(maxChars, SNAPSHOT_BOUNDS.maxUrlChars));
}

export function boundedSnapshotTitle(value: string): string {
  return boundedSnapshotString(redactSensitiveText(value), SNAPSHOT_BOUNDS.maxTitleChars);
}

export function boundedSnapshotFrameUrls(values: string[]): string[] {
  const selected = values.slice(0, SNAPSHOT_BOUNDS.maxFrames);
  let remaining = SNAPSHOT_BOUNDS.maxFrameUrlCharsTotal;
  return selected.map((value, index) => {
    const fairShare = Math.max(1, Math.floor(remaining / (selected.length - index)));
    const bounded = boundedSnapshotUrl(value, fairShare);
    remaining -= bounded.length;
    return bounded;
  });
}

export function boundedSnapshotWarnings(values: string[]): string[] {
  const selected = [...new Set(values)].slice(0, SNAPSHOT_BOUNDS.maxWarnings);
  let remaining = SNAPSHOT_BOUNDS.maxWarningCharsTotal;
  return selected.map((value, index) => {
    const fairShare = Math.max(1, Math.floor(remaining / (selected.length - index)));
    const bounded = boundedSnapshotString(value, Math.min(fairShare, SNAPSHOT_BOUNDS.maxWarningChars));
    remaining -= bounded.length;
    return bounded;
  });
}

export async function createSnapshot(options: {
  page: Page;
  pageId: string;
  mode: SnapshotResult['mode'];
  maxChars: number;
  previousContent?: string;
  baselineSnapshotId?: string;
  compact?: boolean;
  maxDepth?: number;
  markTargets?: boolean;
}): Promise<SnapshotCreation> {
  const snapshotId = newId('snap');
  const refs = new Map<ElementRef, ElementTarget>();
  const pageUrl = options.page.url();
  const rawTitle = await options.page.title();
  const allFrames = options.page.frames();
  const frames = allFrames.slice(0, SNAPSHOT_BOUNDS.maxFrames);
  const rawFrameUrls = frames.map((frame) => frame.url());
  const boundedFrameUrls = boundedSnapshotFrameUrls(rawFrameUrls);
  const displayNodes: SnapshotNode[] = [];
  const canonicalNodes: SnapshotNode[] = [];
  const documents: JSHandle<Document>[] = [];
  const warnings: string[] = [];
  let remainingDomNodes: number = SNAPSHOT_BOUNDS.maxDomNodesTotal;
  let remainingRefs: number = SNAPSHOT_BOUNDS.maxRefsTotal;
  let remainingSemanticChars: number = SNAPSHOT_BOUNDS.maxSemanticCharsTotal;
  if (allFrames.length > frames.length) warnings.push(`Snapshot omitted ${allFrames.length - frames.length} frames after the frame limit.`);
  if (
    pageUrl !== boundedSnapshotUrl(pageUrl) ||
    rawTitle !== boundedSnapshotTitle(rawTitle) ||
    rawFrameUrls.some((url, index) => url !== boundedFrameUrls[index])
  )
    warnings.push('Snapshot provenance was redacted or truncated to its output budget.');
  const ownedElements = new Set<ElementHandle<SVGElement | HTMLElement>>();
  let refCounter = 0;
  try {
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = frames[frameIndex]!;
      let rawNodes: RawNode[];
      let elements: Array<ElementHandle<SVGElement | HTMLElement> | undefined> = [];
      try {
        const selectorPrefix = options.markTargets ? `${snapshotId}:${frameIndex}` : undefined;
        const captured = await snapshotFrame(frame, remainingDomNodes, remainingRefs, remainingSemanticChars, selectorPrefix);
        rawNodes = captured.nodes;
        elements = captured.elements;
        documents.push(captured.document);
        remainingDomNodes = Math.max(0, remainingDomNodes - captured.visitedNodes);
        remainingRefs = Math.max(0, remainingRefs - elements.filter(Boolean).length);
        remainingSemanticChars = Math.max(0, remainingSemanticChars - captured.semanticChars);
        if (captured.truncated) warnings.push(`Frame ${frameIndex + 1} exceeded the DOM node, depth, or ref budget and was truncated.`);
        for (const element of elements) if (element) ownedElements.add(element);
      } catch (_error) {
        rawNodes = [
          {
            role: 'document',
            name: 'Snapshot unavailable for this frame.',
          },
        ];
      }
      const refByTarget = new Map<number, string>();
      const assignRefs = (raw: RawNode): void => {
        const element = raw.targetIndex === undefined ? undefined : elements[raw.targetIndex];
        if (element && raw.fingerprint && raw.targetIndex !== undefined) {
          const ref = `${snapshotId}:e${++refCounter}`;
          refByTarget.set(raw.targetIndex, ref);
          refs.set(ref, {
            pageId: options.pageId,
            pageUrl,
            page: options.page,
            frameUrl: rawFrameUrls[frameIndex]!,
            frameIndex,
            frame,
            ownerDocument: documents[documents.length - 1]!,
            element,
            ...(options.markTargets ? { selector: `[data-tendril-ref="${snapshotId}:${frameIndex}:${raw.targetIndex}"]` } : {}),
            ...(options.markTargets ? { identityToken: `${snapshotId}:${frameIndex}:${raw.targetIndex}` } : {}),
            fingerprint: raw.fingerprint,
            snapshotId,
          });
          ownedElements.delete(element);
        }
        for (const child of raw.children ?? []) assignRefs(child);
      };
      for (const raw of rawNodes) assignRefs(raw);
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
        if (raw.pressed !== undefined) node.pressed = raw.pressed;
        if (raw.readonly !== undefined) node.readonly = raw.readonly;
        if (raw.required !== undefined) node.required = raw.required;
        const ref = raw.targetIndex === undefined ? undefined : refByTarget.get(raw.targetIndex);
        if (ref) node.ref = ref;
        if (raw.children?.length) node.children = raw.children.map(convert);
        return node;
      };
      const projected = projectRawNodes(rawNodes, {
        interactiveOnly: options.mode === 'interactive',
        compact: options.mode === 'diff' ? false : (options.compact ?? false),
        maxDepth: Number.isFinite(options.maxDepth) ? Math.max(0, Math.floor(options.maxDepth ?? 3)) : 3,
      });
      const canonicalProjected = projectRawNodes(rawNodes, { interactiveOnly: false, compact: false, maxDepth: 0 });
      const canonicalConverted = canonicalProjected.map(convert);
      const displayConverted = projected.map(convert);
      if (frames.length > 1) {
        const frameName = boundedFrameUrls[frameIndex]!;
        canonicalNodes.push({ role: 'document', name: frameName, children: canonicalConverted });
        displayNodes.push({ role: 'document', name: frameName, children: displayConverted });
      } else {
        canonicalNodes.push(...canonicalConverted);
        displayNodes.push(...displayConverted);
      }
      await Promise.all([...ownedElements].map((element) => element.dispose().catch(() => undefined)));
      ownedElements.clear();
    }

    const currentFrames = options.page.frames();
    if (
      options.page.url() !== pageUrl ||
      currentFrames.length !== allFrames.length ||
      frames.some((frame, index) => currentFrames[index] !== frame || frame.url() !== rawFrameUrls[index])
    ) {
      throw new TendrilError('STALE_ELEMENT_REF', 'Page or frame changed while the snapshot was being captured; take a new snapshot');
    }

    const maxChars = Number.isFinite(options.maxChars) ? Math.max(1, Math.floor(options.maxChars)) : 1;
    const formattedDisplay = formatNodesBounded(displayNodes, true, maxChars);
    const formattedCanonical = formatNodesBounded(
      canonicalNodes,
      false,
      maxChars,
      options.mode === 'diff' ? formattedDisplay.lineCount : Number.POSITIVE_INFINITY,
    );
    const displayContent = formattedDisplay.content;
    const canonicalContent = formattedCanonical.content;
    if (formattedDisplay.truncated || formattedCanonical.truncated) {
      warnings.push('Snapshot semantic output exceeded its formatting budget and was truncated.');
    }
    let fullContent = displayContent;
    let diffSummary: SnapshotDiffSummary | undefined;
    if (options.mode === 'diff' && options.previousContent !== undefined) {
      const diff = diffSnapshotLines(options.previousContent, canonicalContent, displayContent);
      fullContent = diff.content;
      diffSummary = diff.summary;
      const visibleRefs = new Set([...fullContent.matchAll(/\[ref=([^\]]+)\]/g)].map((match) => match[1]!));
      for (const [ref, target] of [...refs]) {
        if (visibleRefs.has(ref)) continue;
        refs.delete(ref);
        await target.element.dispose().catch(() => undefined);
      }
    }
    const truncated = fullContent.length > maxChars;
    const result: SnapshotResult = {
      snapshotId,
      pageId: options.pageId,
      url: boundedSnapshotUrl(pageUrl),
      title: boundedSnapshotTitle(rawTitle),
      frameUrls: boundedFrameUrls,
      mode: options.mode,
      content: truncated ? fullContent.slice(0, maxChars) : fullContent,
      truncated,
      untrustedContent: true,
      warnings: boundedSnapshotWarnings([...warnings, ...detectInjectionWarnings(canonicalContent)]),
    };
    if (options.baselineSnapshotId) result.baselineSnapshotId = options.baselineSnapshotId;
    if (diffSummary) result.diffSummary = diffSummary;
    if (
      !truncated &&
      options.mode !== 'diff' &&
      countSnapshotNodes(displayNodes, MAX_STRUCTURED_SNAPSHOT_NODES) <= MAX_STRUCTURED_SNAPSHOT_NODES &&
      fullContent.length + JSON.stringify(displayNodes).length <= maxChars
    )
      result.nodes = displayNodes;
    return { result, refs, documents, canonicalContent, displayContent, fullContent };
  } catch (error) {
    await Promise.all([
      ...[...ownedElements].map((element) => element.dispose().catch(() => undefined)),
      ...[...refs.values()].map((target) => target.element.dispose().catch(() => undefined)),
      ...documents.map((document) => document.dispose().catch(() => undefined)),
    ]);
    throw error;
  }
}
