import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { parseHTML } from 'linkedom';
import type { ElementHandle, Frame, Page } from 'playwright';
import { createSnapshot, ELEMENT_FINGERPRINT_OPTIONS, SNAPSHOT_BOUNDS } from '../src/browser/snapshot.js';
import type { SnapshotNode } from '../src/types.js';

const test = process.env.VITEST ? ((await import('vitest')).test as unknown as typeof nodeTest) : nodeTest;

interface TestRawNode {
  role: string;
  name?: string;
  selector?: string;
  children?: TestRawNode[];
}

function fakeElementHandle(element: Element): ElementHandle<HTMLElement | SVGElement> {
  const handle = {
    asElement: () => handle,
    dispose: async () => undefined,
    evaluate: async (callback: (value: Element, argument?: unknown) => unknown, argument?: unknown) => callback(element, argument),
  };
  return handle as unknown as ElementHandle<HTMLElement | SVGElement>;
}

function fakePayloadHandle<
  T extends {
    nodes: unknown;
    targets: Element[];
    document: Document;
    visitedNodes: number;
    semanticChars: number;
    truncated: boolean;
  },
>(payload: T) {
  const targetHandles = payload.targets.map(fakeElementHandle);
  return {
    evaluate: async (callback: (value: T) => unknown) => callback(payload),
    getProperty: async (name: keyof T) => {
      if (name === 'document') return { dispose: async () => undefined };
      assert.equal(name, 'targets');
      return {
        getProperties: async () => new Map(targetHandles.map((handle, index) => [String(index), handle])),
        dispose: async () => undefined,
      };
    },
    dispose: async () => undefined,
  };
}

function pageReturning(rawNodes: TestRawNode[]): Page {
  const document = parseHTML('<!doctype html><html><body></body></html>').document;
  const targets: Element[] = [];
  const prepare = (raw: TestRawNode): Record<string, unknown> => {
    const prepared: Record<string, unknown> = { role: raw.role };
    if (raw.name) prepared.name = raw.name;
    if (raw.selector) {
      const element = document.createElement(raw.role === 'link' ? 'a' : raw.role === 'textbox' ? 'input' : raw.role === 'button' ? 'button' : 'div');
      element.id = raw.selector.replace(/^#/, '');
      prepared.targetIndex = targets.push(element) - 1;
      prepared.fingerprint = JSON.stringify([element.tagName.toLowerCase(), '', element.id, '', '', '']);
    }
    if (raw.children) prepared.children = raw.children.map(prepare);
    return prepared;
  };
  const nodes = rawNodes.map(prepare);
  const frame = {
    url: () => 'https://example.test/',
    locator: () => ({
      evaluateHandle: async () =>
        fakePayloadHandle({
          nodes: structuredClone(nodes),
          targets,
          document,
          visitedNodes: nodes.length,
          truncated: false,
          semanticChars: JSON.stringify(nodes).length,
        }),
    }),
  } as unknown as Frame;
  return {
    frames: () => [frame],
    url: () => 'https://example.test/',
    title: async () => 'Fixture',
  } as unknown as Page;
}

function pageForHtml(fragment: string, inspectPayload?: (payload: { nodes: unknown; targets: Element[] }) => void): Page {
  const { document, window } = parseHTML(`<!doctype html><html><head><title>Fixture</title></head><body>${fragment}</body></html>`);
  const frame = {
    url: () => 'https://example.test/',
    locator: (selector: string) => {
      assert.equal(selector, 'body');
      return {
        evaluateHandle: async (callback: (body: Element, options: unknown) => { nodes: unknown; targets: Element[] }, options: unknown) => {
          const host = globalThis as unknown as Record<string, unknown>;
          const browserWindow = window as unknown as Record<string, unknown>;
          const replacements: Record<string, unknown> = {
            document,
            Element: browserWindow.Element,
            HTMLElement: browserWindow.HTMLElement,
            HTMLInputElement: browserWindow.HTMLInputElement,
            HTMLTextAreaElement: browserWindow.HTMLTextAreaElement,
            HTMLSelectElement: browserWindow.HTMLSelectElement,
            ShadowRoot: browserWindow.ShadowRoot,
            getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
            CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
          };
          const previous = new Map<string, { present: boolean; value: unknown }>();
          for (const [key, value] of Object.entries(replacements)) {
            previous.set(key, { present: Object.hasOwn(host, key), value: host[key] });
            host[key] = value;
          }
          try {
            const payload = callback(document.body, options);
            inspectPayload?.(payload);
            return fakePayloadHandle(
              payload as ReturnType<typeof callback> & {
                document: Document;
                visitedNodes: number;
                semanticChars: number;
                truncated: boolean;
              },
            );
          } finally {
            for (const [key, saved] of previous) {
              if (saved.present) host[key] = saved.value;
              else delete host[key];
            }
          }
        },
      };
    },
  } as unknown as Frame;
  return {
    frames: () => [frame],
    url: () => 'https://example.test/',
    title: async () => document.title,
  } as unknown as Page;
}

function roles(nodes: SnapshotNode[]): string[] {
  return nodes.flatMap((node) => [node.role, ...roles(node.children ?? [])]);
}

test('compact snapshots enforce the default depth while retaining deep interactive elements', async () => {
  const page = pageForHtml(`
    <main>
      <section><div><div>
        <h2>Too deep heading</h2>
        <button id="deep-action">Deep action</button>
      </div></div></section>
    </main>
  `);

  const { result, refs } = await createSnapshot({
    page,
    pageId: 'page-1',
    mode: 'full',
    maxChars: 10_000,
    compact: true,
  });

  assert.ok(result.nodes);
  assert.ok(!roles(result.nodes).includes('heading'));
  assert.ok(roles(result.nodes).includes('button'));
  assert.equal(refs.size, 1);
  assert.match(result.content, /button "Deep action" \[ref=snap_[a-f0-9]{20}:e1\]/);
});

test('compact snapshots honor maxDepth, inline a sole text child, and drop empty generic nodes', async () => {
  const inlinePage = pageForHtml(`
    <section><span>Inline me</span></section>
    <div></div>
  `);

  const { result: inlineResult } = await createSnapshot({
    page: inlinePage,
    pageId: 'page-1',
    mode: 'full',
    maxChars: 10_000,
    compact: true,
  });

  assert.deepEqual(inlineResult.nodes, [{ role: 'generic', name: 'Inline me' }]);

  const depthPage = pageForHtml('<main><h2>Beyond limit</h2><button id="kept">Kept action</button></main>');
  const { result: depthResult } = await createSnapshot({
    page: depthPage,
    pageId: 'page-1',
    mode: 'full',
    maxChars: 10_000,
    compact: true,
    maxDepth: 0,
  });

  assert.ok(depthResult.nodes);
  assert.equal(
    depthResult.nodes.some((node) => node.role === 'generic' && !node.name && !node.children?.length),
    false,
  );
  assert.ok(!roles(depthResult.nodes).includes('heading'));
  assert.ok(roles(depthResult.nodes).includes('button'));
});

test('avoids duplicate control names without dropping actionable descendants', async () => {
  const page = pageForHtml(`
    <button id="save"><span>Save changes</span></button>
    <h2>Documentation <a id="docs" href="/docs">Read docs</a></h2>
  `);

  const { result, refs } = await createSnapshot({
    page,
    pageId: 'page-1',
    mode: 'full',
    maxChars: 10_000,
  });

  assert.equal(result.content.match(/Save changes/g)?.length, 1);
  assert.equal(result.content.match(/Read docs/g)?.length, 1);
  assert.ok(result.nodes);
  assert.ok(roles(result.nodes).includes('heading'));
  assert.ok(roles(result.nodes).includes('link'));
  assert.equal(refs.size, 2);
});

test('caps actionable handles collected from a hostile wide DOM', async () => {
  const page = pageForHtml(`<main>${Array.from({ length: 5_005 }, (_, index) => `<button>Action ${index}</button>`).join('')}</main>`);

  const created = await createSnapshot({ page, pageId: 'page-1', mode: 'full', maxChars: 1_000_000 });

  assert.equal(created.refs.size, 5_000);
  assert.ok(created.result.warnings.some((warning) => warning.includes('DOM node, depth, or ref budget')));
});

test('bounds fingerprint representations and the aggregate browser-side semantic payload', async () => {
  const oversized = 'z'.repeat(500);
  const attributes = ELEMENT_FINGERPRINT_OPTIONS.attributes.map((name) => `${name}="${oversized}"`).join(' ');
  let largestFingerprint = 0;
  let serializedNodes = 0;
  const page = pageForHtml(
    `<button ${attributes}></button>${Array.from({ length: 2_099 }, () => `<button aria-label="${oversized}"></button>`).join('')}`,
    (payload) => {
      serializedNodes = JSON.stringify(payload.nodes).length;
      const pending = [...(payload.nodes as Array<Record<string, unknown>>)] as Array<Record<string, unknown>>;
      while (pending.length > 0) {
        const node = pending.pop()!;
        if (typeof node.fingerprint === 'string') largestFingerprint = Math.max(largestFingerprint, node.fingerprint.length);
        if (Array.isArray(node.children)) pending.push(...(node.children as Array<Record<string, unknown>>));
      }
    },
  );

  const created = await createSnapshot({ page, pageId: 'page-1', mode: 'full', maxChars: 1_000_000 });

  assert.ok(largestFingerprint <= ELEMENT_FINGERPRINT_OPTIONS.maxFingerprintChars);
  assert.ok(serializedNodes <= SNAPSHOT_BOUNDS.maxSemanticCharsTotal + 1_000_000);
  assert.ok(created.result.warnings.some((warning) => warning.includes('DOM node, depth, or ref budget')));
});

test('diff snapshots return only changed lines and a line-count summary', async () => {
  const page = pageReturning([
    { role: 'button', name: 'Save', selector: '#save' },
    { role: 'text', name: 'New' },
  ]);
  const previousContent = '- button "Save" [ref]\n- text "Old"';

  const { result } = await createSnapshot({
    page,
    pageId: 'page-1',
    mode: 'diff',
    maxChars: 10_000,
    previousContent,
  });

  assert.equal(result.content, '- - text "Old"\n+ - text "New"');
  assert.deepEqual(result.diffSummary, { added: 1, removed: 1, unchanged: 1 });
});

test('diff snapshots retain handles only for actionable refs visible in the diff', async () => {
  const added = await createSnapshot({
    page: pageReturning([{ role: 'button', name: 'New action', selector: '#new-action' }]),
    pageId: 'page-1',
    mode: 'diff',
    maxChars: 10_000,
    previousContent: '',
  });
  assert.equal(added.refs.size, 1);
  assert.match(added.result.content, /^\+ - button "New action" \[ref=snap_[a-f0-9]{20}:e1\]$/);

  const unchanged = await createSnapshot({
    page: pageReturning([{ role: 'button', name: 'Existing action', selector: '#existing-action' }]),
    pageId: 'page-1',
    mode: 'diff',
    maxChars: 10_000,
    previousContent: '- button "Existing action" [ref]',
  });
  assert.equal(unchanged.refs.size, 0);
  assert.equal(unchanged.result.content, '');
});

test('diff snapshots account for duplicate lines and emit no unchanged content', async () => {
  const line = '- text "Repeated"';
  const { result } = await createSnapshot({
    page: pageReturning([{ role: 'text', name: 'Repeated' }]),
    pageId: 'page-1',
    mode: 'diff',
    maxChars: 10_000,
    previousContent: `${line}\n${line}`,
  });

  assert.equal(result.content, `- ${line}`);
  assert.deepEqual(result.diffSummary, { added: 0, removed: 1, unchanged: 1 });
});

test('identical diff snapshots have an empty body and only unchanged lines', async () => {
  const line = '- text "Same"';
  const { result } = await createSnapshot({
    page: pageReturning([{ role: 'text', name: 'Same' }]),
    pageId: 'page-1',
    mode: 'diff',
    maxChars: 10_000,
    previousContent: line,
  });

  assert.equal(result.content, '');
  assert.deepEqual(result.diffSummary, { added: 0, removed: 0, unchanged: 1 });
});

test('does not treat page-authored ref-like text as a capability token', async () => {
  const line = '- text "Example [ref=literal]"';
  const { result } = await createSnapshot({
    page: pageReturning([{ role: 'text', name: 'Example [ref=literal]' }]),
    pageId: 'page-1',
    mode: 'diff',
    maxChars: 10_000,
    previousContent: line,
  });

  assert.equal(result.content, '');
  assert.deepEqual(result.diffSummary, { added: 0, removed: 0, unchanged: 1 });
});
