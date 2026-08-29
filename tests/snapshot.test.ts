import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { parseHTML } from 'linkedom';
import type { Frame, Page } from 'playwright';
import { createSnapshot } from '../src/browser/snapshot.js';
import type { SnapshotNode } from '../src/types.js';

const test = process.env.VITEST ? ((await import('vitest')).test as unknown as typeof nodeTest) : nodeTest;

interface TestRawNode {
  role: string;
  name?: string;
  selector?: string;
  children?: TestRawNode[];
}

function pageReturning(rawNodes: TestRawNode[]): Page {
  const frame = {
    url: () => 'https://example.test/',
    locator: () => ({ evaluate: async () => structuredClone(rawNodes) }),
  } as unknown as Frame;
  return {
    frames: () => [frame],
    url: () => 'https://example.test/',
    title: async () => 'Fixture',
  } as unknown as Page;
}

function pageForHtml(fragment: string): Page {
  const { document, window } = parseHTML(`<!doctype html><html><head><title>Fixture</title></head><body>${fragment}</body></html>`);
  const frame = {
    url: () => 'https://example.test/',
    locator: (selector: string) => {
      assert.equal(selector, 'body');
      return {
        evaluate: async (callback: (body: Element, options: unknown) => unknown, options: unknown) => {
          const host = globalThis as unknown as Record<string, unknown>;
          const browserWindow = window as unknown as Record<string, unknown>;
          const replacements: Record<string, unknown> = {
            document,
            Element: browserWindow.Element,
            HTMLInputElement: browserWindow.HTMLInputElement,
            HTMLTextAreaElement: browserWindow.HTMLTextAreaElement,
            HTMLSelectElement: browserWindow.HTMLSelectElement,
            getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
            CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
          };
          const previous = new Map<string, { present: boolean; value: unknown }>();
          for (const [key, value] of Object.entries(replacements)) {
            previous.set(key, { present: Object.hasOwn(host, key), value: host[key] });
            host[key] = value;
          }
          try {
            return callback(document.body, options);
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
  assert.match(result.content, /button "Deep action" \[ref=e1\]/);
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

test('diff snapshots return only changed lines and a line-count summary', async () => {
  const page = pageReturning([
    { role: 'button', name: 'Save', selector: '#save' },
    { role: 'text', name: 'New' },
  ]);
  const previousContent = '- button "Save" [ref=e1]\n- text "Old"';

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
