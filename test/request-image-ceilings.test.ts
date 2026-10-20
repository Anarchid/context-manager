/**
 * The image ceilings (imageCeiling, imageByteCeiling): the most top-level
 * image blocks, and their bytes, a strategy's live window keeps, and the most
 * images and bytes a compression prompt carries. The live window keeps its
 * own limits within them, compression prompts carry no more than them, and
 * imageCeilings() reports them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, WindowedPassthroughStrategy } from '../src/index.js';
import type { ContextStrategy, ImageCeilings } from '../src/index.js';
import { ceilingBoundLine, resolveLiveImageLimits } from '../src/live-image-limits.js';

const MiB = 1024 * 1024;
const PLACEHOLDER = '[image not shown: this context keeps only some images]';

/** A message holding one image of `bytes` base64 characters and a label. */
const imageMessage = (label: string, bytes = 4): ContentBlock[] => [
  { type: 'image', source: { type: 'base64', data: 'A'.repeat(bytes), mediaType: 'image/png' }, tokenEstimate: 100 } as ContentBlock,
  { type: 'text', text: label },
];

/** Which of img-1..n kept its image ('I'), was stripped ('.') or is missing ('-'). */
function pattern(messages: Array<{ content: ContentBlock[] }>, n: number): string {
  let out = '';
  for (let i = 1; i <= n; i++) {
    const m = messages.find((x) => x.content.some((b) => b.type === 'text' && b.text === `img-${i}`));
    out += !m ? '-' : m.content.some((b) => b.type === 'image') ? 'I' : '.';
  }
  return out;
}

/** The memory strategy's persisted hysteresis watermark, or null where it has
 *  none (or the strategy keeps none). */
function watermarkOf(manager: ContextManager, strategy: ContextStrategy): number | null {
  const id = (strategy as unknown as { imageWatermarkStateId?: string }).imageWatermarkStateId;
  if (!id) return null;
  const state = manager.getStore().getStateJson(id) as { sequence?: number } | null | undefined;
  return typeof state?.sequence === 'number' ? state.sequence : null;
}

/** Compile a fresh store holding `n` image messages of `bytes` each. */
async function compiled(strategy: ContextStrategy, n: number, bytes = 4): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
  try {
    for (let i = 1; i <= n; i++) manager.addMessage('user', imageMessage(`img-${i}`, bytes));
    const result = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
    return pattern(result.messages, n);
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const memory = (options: Record<string, unknown>) => new AutobiographicalStrategy({
  headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0, ...options,
} as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
const windowed = (options: Record<string, unknown>) => new WindowedPassthroughStrategy({
  imageStripDepthTokens: 0, ...options,
} as ConstructorParameters<typeof WindowedPassthroughStrategy>[0]);
const STRATEGIES = { autobiographical: memory, 'windowed passthrough': windowed };
const DEFAULTS = {
  autobiographical: () => new AutobiographicalStrategy(),
  'windowed passthrough': () => new WindowedPassthroughStrategy(),
};

describe('imageCeilings()', () => {
  it('is reachable through the ContextStrategy interface, typed by the exported ImageCeilings', () => {
    const strategy: ContextStrategy = new WindowedPassthroughStrategy();
    const ceilings: ImageCeilings | undefined = strategy.imageCeilings?.();
    assert.deepEqual(ceilings, { imageCeiling: 500, imageByteCeiling: 24 * MiB });
  });

  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: the defaults are 500 images and 24 MiB`, () => {
      assert.deepEqual(DEFAULTS[name as keyof typeof DEFAULTS]().imageCeilings(), { imageCeiling: 500, imageByteCeiling: 24 * MiB });
    });

    it(`${name}: reports the ceilings as the window applies them`, () => {
      const ceilings = (options: Record<string, unknown>) => make(options).imageCeilings();
      assert.deepEqual(ceilings({ imageCeiling: 10, imageByteCeiling: 2 * MiB }), { imageCeiling: 10, imageByteCeiling: 2 * MiB });
      assert.deepEqual(ceilings({ imageCeiling: 0, imageByteCeiling: 0 }), { imageCeiling: 0, imageByteCeiling: 0 }, '0 is none');
      for (const bad of [-3, Number.NaN, Infinity]) {
        assert.deepEqual(ceilings({ imageCeiling: bad, imageByteCeiling: bad }), { imageCeiling: 500, imageByteCeiling: 24 * MiB },
          `a ceiling of ${bad} takes the default`);
      }
      assert.deepEqual(ceilings({ imageCeiling: 0.5, imageByteCeiling: 100.7 }), { imageCeiling: 1, imageByteCeiling: 100 },
        'a fraction is floored, to at least 1');
      assert.deepEqual(ceilings({ maxLiveImages: 800, maxLiveImageBytes: 30 * MiB }), { imageCeiling: 500, imageByteCeiling: 24 * MiB },
        "the window's own limits leave the ceilings as they are");
    });
  }
});

describe("the memory strategy's effective config", () => {
  it('reports both ceilings, as the library defaults when the host sets neither, and as the host set them otherwise', async () => {
    const report = async (options: Record<string, unknown>) => {
      const lines: string[] = [];
      const original = console.error;
      console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      try {
        const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: new AutobiographicalStrategy({ logEffectiveConfig: true, ...options }) });
        await manager.close();
      } finally {
        console.error = original;
        rmSync(dir, { recursive: true, force: true });
      }
      const line = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.event === 'config:effective');
      assert.ok(line, JSON.stringify(lines));
      return line as { effective: Record<string, unknown>; provenance: Record<string, unknown> };
    };
    const defaults = await report({});
    assert.equal(defaults.effective.imageCeiling, 500);
    assert.equal(defaults.effective.imageByteCeiling, 24 * MiB);
    assert.equal(defaults.provenance.imageCeiling, 'library-default');
    assert.equal(defaults.provenance.imageByteCeiling, 'library-default');
    const set = await report({ imageCeiling: 40, imageByteCeiling: 0 });
    assert.equal(set.effective.imageCeiling, 40);
    assert.equal(set.effective.imageByteCeiling, 0);
    assert.equal(set.provenance.imageCeiling, 'caller');
  });
});

describe('the window limits resolved within the ceilings', () => {
  const resolve = (configured: Partial<Record<'maxLiveImages' | 'maxLiveImageBytes' | 'imageCeiling' | 'imageByteCeiling', number>>) =>
    resolveLiveImageLimits({ maxLiveImages: 6, maxLiveImageBytes: 20 * MiB, imageCeiling: 500, imageByteCeiling: 24 * MiB, ...configured });

  it('the defaults are a window of 6 images and 20 MiB under ceilings of 500 images and 24 MiB', () => {
    assert.deepEqual(resolve({}), { target: { images: 6, bytes: 20 * MiB }, ceiling: { images: 500, bytes: 24 * MiB } });
  });

  it('the window is kept within the ceilings, and a ceiling of 0 is none', () => {
    assert.deepEqual(resolve({ maxLiveImages: 0, maxLiveImageBytes: 0 }), {
      target: { images: 500, bytes: 24 * MiB }, ceiling: { images: 500, bytes: 24 * MiB },
    }, 'an unlimited window means up to the ceilings');
    assert.deepEqual(resolve({ maxLiveImages: 800, maxLiveImageBytes: 30 * MiB }).target,
      { images: 500, bytes: 24 * MiB }, 'a window above the ceilings keeps the ceilings');
    assert.deepEqual(resolve({ maxLiveImages: 4, maxLiveImageBytes: MiB, imageCeiling: 10, imageByteCeiling: 2 * MiB }), {
      target: { images: 4, bytes: MiB }, ceiling: { images: 10, bytes: 2 * MiB },
    }, 'a window under configured ceilings keeps its own limits');
    assert.deepEqual(resolve({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 0, imageByteCeiling: 0 }), {
      target: { images: 0, bytes: 0 }, ceiling: { images: 0, bytes: 0 },
    }, 'no ceiling leaves an unlimited window unlimited');
    assert.equal(resolve({ maxLiveImages: 4, imageCeiling: 0 }).target.images, 4, 'no ceiling leaves a window as set');
  });

  it("a window limit that isn't a positive finite number is none, and a malformed ceiling takes its default", () => {
    for (const bad of [-3, Number.NaN, Infinity]) {
      assert.equal(resolve({ maxLiveImages: bad }).target.images, 500, `maxLiveImages ${bad} is unlimited, so up to the ceiling`);
      assert.equal(resolve({ maxLiveImageBytes: bad }).target.bytes, 24 * MiB, `maxLiveImageBytes ${bad} is unlimited, so up to the ceiling`);
      assert.equal(resolve({ imageCeiling: bad }).ceiling.images, 500, `imageCeiling ${bad} takes the default`);
      assert.equal(resolve({ imageByteCeiling: bad }).ceiling.bytes, 24 * MiB, `imageByteCeiling ${bad} takes the default`);
    }
    assert.equal(resolve({ maxLiveImages: 0, imageCeiling: -1 }).target.images, 500, 'the window is clamped to the default the malformed ceiling took');
    assert.equal(resolve({ maxLiveImages: Infinity, imageCeiling: 0 }).target.images, 0,
      'an infinite limit with no ceiling is reported as none, 0');
  });

  it('a fractional limit or ceiling is floored, to at least 1', () => {
    assert.equal(resolve({ maxLiveImages: 2.5 }).target.images, 2);
    assert.deepEqual(resolve({ maxLiveImages: 0, imageCeiling: 1.5 }), {
      target: { images: 1, bytes: 20 * MiB }, ceiling: { images: 1, bytes: 24 * MiB },
    });
    assert.equal(resolve({ imageCeiling: 0.5 }).ceiling.images, 1, 'a fraction under 1 is 1, not none');
    assert.equal(resolve({ imageByteCeiling: 100.7 }).ceiling.bytes, 100);
  });
});

describe('the live window within the image ceilings', () => {
  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: an unlimited count keeps the newest imageCeiling`, async () => {
      assert.equal(await compiled(make({ maxLiveImages: 0, imageCeiling: 2 }), 4), '..II');
    });
    it(`${name}: a count above the ceiling keeps the ceiling's worth`, async () => {
      assert.equal(await compiled(make({ maxLiveImages: 3, imageCeiling: 2 }), 4), '..II');
    });
    it(`${name}: an unlimited byte budget keeps the newest imageByteCeiling`, async () => {
      assert.equal(await compiled(make({ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 2000 }), 4, 1000), '..II');
    });
    it(`${name}: with no window and no ceilings, every image stays, more than the default window's 6`, async () => {
      assert.equal(await compiled(make({
        maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 0, imageByteCeiling: 0,
      }), 8), 'IIIIIIII');
    });
    it(`${name}: the window counts top-level image blocks only, so a nested or a generated image passes the count ceiling`, async () => {
      // What the ceilings bind is what the window counts. An image nested in
      // a tool result, or a generated image, isn't one of those (a change
      // that counts them would change this).
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: make({ maxLiveImages: 0, imageCeiling: 1 }) });
      try {
        const image = (data: string) =>
          ({ type: 'image', source: { type: 'base64', data, mediaType: 'image/png' } }) as ContentBlock;
        manager.addMessage('Claude', [{ type: 'tool_use', id: 'tu-1', name: 'shot', input: {} }] as ContentBlock[]);
        manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'tu-1', content: [image('AAAA'), image('BBBB')] }] as ContentBlock[]);
        for (let i = 1; i <= 2; i++) {
          manager.addMessage('user', [
            { type: 'generated_image', data: 'A'.repeat(4), mimeType: 'image/png' } as ContentBlock,
            { type: 'text', text: `gen-${i}` },
          ]);
        }
        const result = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        const blocks = result.messages.flatMap((m) => m.content);
        const nested = blocks
          .filter((b) => b.type === 'tool_result')
          .flatMap((b) => (b as { content: ContentBlock[] }).content)
          .filter((b) => b.type === 'image').length;
        assert.equal(nested, 2, 'both nested images stay, past a count ceiling of 1');
        const kept = blocks.filter((b) => b.type === 'generated_image').length;
        assert.equal(kept, 2, 'both generated images stay, past a count ceiling of 1');
      } finally {
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('the post-strip estimates price an image the ceiling strips as the placeholder', () => {
    const image = (): ContentBlock =>
      ({ type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } }) as ContentBlock;
    const messages = [{ id: 'old', content: [image()] }, { id: 'new', content: [image()] }];
    const store = {
      getAll: () => messages as never[],
      get: (id: string) => (messages.find((m) => m.id === id) as never) ?? null,
      getFrom: (i: number) => messages.slice(i) as never[],
      getTail: (n: number) => messages.slice(-n) as never[],
      length: () => messages.length,
      estimateTokens: (m: { content: ContentBlock[] }) =>
        m.content.reduce((sum, b) => sum + (b.type === 'image' ? 1600 : b.type === 'text' ? Math.ceil(b.text.length / 4) : 0), 0),
      getTokenCalibration: () => 1,
    };
    const estimate = (strategy: AutobiographicalStrategy) =>
      (strategy as unknown as { postStripEstimates(s: typeof store): number[] }).postStripEstimates(store);
    const stripped = [Math.ceil(PLACEHOLDER.length / 4), 1600];
    assert.deepEqual(estimate(memory({ maxLiveImages: 0, imageCeiling: 1 })), stripped, 'by the count ceiling');
    assert.deepEqual(estimate(memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 5 })), stripped,
      'by the byte ceiling: 4 bytes fit, 8 do not');
    // The memo is keyed by the clamped limits, so a changed ceiling prices anew.
    const strategy = memory({ maxLiveImages: 0, imageCeiling: 1 });
    assert.deepEqual(estimate(strategy), stripped);
    (strategy as unknown as { config: { imageCeiling: number } }).config.imageCeiling = 2;
    assert.deepEqual(estimate(strategy), [1600, 1600], 'with a ceiling of 2, both are live');
  });

  it('the hysteresis watermark trims against the ceiling when the count is unlimited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      strategy: memory({ maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 }),
    });
    try {
      const strip = async (n: number) => pattern((await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages, n);
      for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      assert.equal(await strip(4), 'IIII');
      manager.addMessage('user', imageMessage('img-5'));
      assert.equal(await strip(5), '...II', 'the ceiling binds: one trim to half of it, not a slide of one');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the hysteresis watermark against the byte ceiling', () => {
  it('trims against the byte ceiling when the byte budget is unlimited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      strategy: memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 16, imageStripHysteresisRatio: 0.5 }),
    });
    try {
      const strip = async (n: number) => pattern((await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages, n);
      for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-${i}`, 4));
      assert.equal(await strip(4), 'IIII', 'four 4-byte images fill the 16-byte ceiling');
      manager.addMessage('user', imageMessage('img-5', 4));
      assert.equal(await strip(5), '...II', 'the ceiling binds: one trim to half of it');
    } finally {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the image limits warning', () => {
  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: says once, at initialize, when a configured window limit is above its ceiling`, async () => {
      const lines: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      try {
        const cases = [
          [{ maxLiveImages: 8, imageCeiling: 4 }, ['maxLiveImages 8 is above imageCeiling 4, so the live window keeps at most 4']],
          [{ maxLiveImageBytes: 3 * MiB, imageByteCeiling: 2 * MiB },
            ['maxLiveImageBytes 3 MiB is above imageByteCeiling 2 MiB, so the live window keeps at most 2 MiB']],
          [{ maxLiveImages: 8, imageCeiling: 4, maxLiveImageBytes: 3 * MiB, imageByteCeiling: 2 * MiB },
            ['maxLiveImages 8 is above imageCeiling 4', 'maxLiveImageBytes 3 MiB is above imageByteCeiling 2 MiB']],
          // A byte figure that isn't a whole number of MiB reads in bytes.
          [{ maxLiveImageBytes: 3 * MiB + 1, imageByteCeiling: 2 * MiB }, [`maxLiveImageBytes ${3 * MiB + 1} bytes is above imageByteCeiling 2 MiB`]],
          [{ imageCeiling: Number.NaN }, ["imageCeiling NaN isn't 0 or a finite number above it, so the default 500 applies"]],
          [{ imageByteCeiling: -1 }, ["imageByteCeiling -1 isn't 0 or a finite number above it, so the default 24 MiB applies"]],
          [{ maxLiveImages: 0, maxLiveImageBytes: 0 }, null],
          [{ maxLiveImages: 4, imageCeiling: 4 }, null],
          // At or above the memory strategy's 12 MiB compression budget, so
          // that budget isn't above the ceiling either.
          [{ maxLiveImageBytes: 16 * MiB, imageByteCeiling: 16 * MiB }, null],
          // A default above a lowered ceiling is named too, marked as the
          // default, and so is a default ceiling under a limit the host set.
          [{ imageByteCeiling: 2 * MiB }, ['maxLiveImageBytes 20 MiB (default) is above imageByteCeiling 2 MiB, so the live window keeps at most 2 MiB']],
          [{ maxLiveImages: 600 }, ['maxLiveImages 600 is above imageCeiling 500 (default), so the live window keeps at most 500']],
          // The default window of 6 comes from the strategy's default config,
          // not from the host, so it's marked too.
          [{ imageCeiling: 4 }, ['maxLiveImages 6 (default) is above imageCeiling 4, so the live window keeps at most 4']],
          // An infinite limit is none, like 0, so nothing is said.
          [{ maxLiveImages: Infinity }, null],
          // A malformed ceiling takes its default, which the later clause marks.
          [{ maxLiveImages: 600, imageCeiling: Number.NaN },
            ["imageCeiling NaN isn't 0 or a finite number above it, so the default 500 applies",
              'maxLiveImages 600 is above imageCeiling 500 (default)']],
          // A byte budget given as null takes its default, and is marked so.
          [{ maxLiveImageBytes: null, imageByteCeiling: 2 * MiB }, ['maxLiveImageBytes 20 MiB (default) is above imageByteCeiling 2 MiB']],
          [{ maxLiveImageBytes: undefined, imageByteCeiling: 2 * MiB }, ['maxLiveImageBytes 20 MiB (default) is above imageByteCeiling 2 MiB']],
          [{ maxLiveImageBytes: 30 * MiB, imageByteCeiling: -1 },
            ["imageByteCeiling -1 isn't 0 or a finite number above it, so the default 24 MiB applies",
              'maxLiveImageBytes 30 MiB is above imageByteCeiling 24 MiB (default)']],
          [{ maxLiveImages: 8, imageCeiling: 0 }, null],
          [{ maxLiveImageBytes: 30 * MiB, imageByteCeiling: 0 }, null],
        ] as const;
        for (const [index, [options, said]] of cases.entries()) {
          lines.length = 0;
          const strategy = make(options);
          // Two stores opened in turn with the one strategy initialize it twice.
          for (const store of ['first', 'second']) {
            const manager = await ContextManager.open({ path: join(dir, `${index}-${store}`), strategy });
            await manager.close();
          }
          const ours = lines.filter((line) => line.includes('above') || line.includes('the default'));
          if (said === null) assert.deepEqual(ours, [], `nothing said for ${JSON.stringify(options)}`);
          else {
            assert.equal(ours.length, 1, `said once, in one line, for ${JSON.stringify(options)}: ${JSON.stringify(ours)}`);
            for (const part of said) assert.ok(ours[0]!.includes(part), `${ours[0]} names ${part}`);
          }
        }
      } finally {
        console.warn = original;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

class Prepared extends AutobiographicalStrategy {
  prepare(request: NormalizedRequest) { return this.prepareCompressionRequest(request); }
  send(request: NormalizedRequest, label: string): NormalizedRequest {
    return (this as unknown as { prepareCompressionCandidate(r: NormalizedRequest, l: string): NormalizedRequest })
      .prepareCompressionCandidate(request, label);
  }
}
function captureErrors<T>(run: () => T): string[] {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
  try { run(); return logs; } finally { console.error = original; }
}
const imageBlock = (data: string) => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data } }) as ContentBlock;
const request = (...messages: ContentBlock[][]): NormalizedRequest => ({
  messages: messages.map((content) => ({ participant: 'User', content })), config: { model: 'mock', maxTokens: 1000 },
});

describe("the memory strategy's warning names a compression budget above the byte ceiling", () => {
  it('says it once, at initialize', async () => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    try {
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: memory({ maxCompressionImageBytes: 30 * MiB }) });
      await manager.close();
      const ours = lines.filter((line) => line.includes('maxCompressionImageBytes'));
      assert.equal(ours.length, 1, JSON.stringify(lines));
      assert.ok(ours[0]!.includes('maxCompressionImageBytes 30 MiB is above imageByteCeiling 24 MiB (default), so a compression prompt keeps at most 24 MiB'), ours[0]);
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the memory strategy's warning names its default compression budget under a lowered byte ceiling", () => {
  it('says it, marked as the default, with no clause for a window limit under the ceiling', async () => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    try {
      const manager = await ContextManager.open({
        path: join(dir, 'store'), strategy: memory({ maxLiveImageBytes: 1 * MiB, imageByteCeiling: 2 * MiB }),
      });
      await manager.close();
      const ours = lines.filter((line) => line.includes('is above'));
      assert.equal(ours.length, 1, JSON.stringify(lines));
      assert.ok(ours[0]!.includes('maxCompressionImageBytes 12 MiB (default) is above imageByteCeiling 2 MiB, so a compression prompt keeps at most 2 MiB'), ours[0]);
      assert.ok(!ours[0]!.includes('maxLiveImageBytes'), ours[0]);
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the line when an image first falls past an image ceiling', () => {
  /** Run `steps` on a fresh store: each adds images (`add`, of `bytes` each,
   *  4 when not given) and compiles. Returns the ceiling lines each step said,
   *  in order (a new message can move the memory strategy's watermark, so a
   *  step's adds count with its compile), the pattern each compile kept, and
   *  the last pattern. Byte sizes are multiples of 4: the store keeps an
   *  image's data as the bytes its base64 decodes to, so other lengths
   *  come back changed. */
  async function ceilingLines(
    strategy: ContextStrategy,
    steps: Array<number | { add: number; bytes: number }>,
  ): Promise<{ lines: string[]; byStep: string[][]; patterns: string[]; last: string; watermarks: Array<number | null> }> {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    let n = 0;
    const byStep: string[][] = [];
    const patterns: string[] = [];
    const watermarks: Array<number | null> = [];
    try {
      for (const step of steps) {
        const { add, bytes } = typeof step === 'number' ? { add: step, bytes: 4 } : step;
        const before = said.length;
        for (let i = 0; i < add; i++) manager.addMessage('user', imageMessage(`img-${++n}`, bytes));
        patterns.push(pattern((await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages, n));
        byStep.push(said.slice(before).filter((line) => line.includes('an image fell past')));
        watermarks.push(watermarkOf(manager, strategy));
      }
      return { lines: byStep.flat(), byStep, patterns, last: patterns[patterns.length - 1] ?? '', watermarks };
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: says once which ceiling an image fell past, and what it held`, async () => {
      const cases = [
        [{ maxLiveImages: 0, imageCeiling: 2 }, 'imageCeiling 2, which holds maxLiveImages 0 (no limit) to it'],
        [{ maxLiveImages: 5, imageCeiling: 2 }, 'imageCeiling 2, which holds maxLiveImages 5 to it'],
        [{ imageCeiling: 2 }, 'imageCeiling 2, which holds maxLiveImages 6 (default) to it'],
        [{ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 8 },
          'imageByteCeiling 8 bytes, which holds maxLiveImageBytes 0 (no limit) to it'],
      ] as const;
      for (const [options, said] of cases) {
        // Three images, then two more: the ceiling strips at the first compile
        // and again at the second, and it's said once, at the first.
        const strategy = make(options);
        const { lines, byStep, patterns } = await ceilingLines(strategy, [3, 2]);
        assert.deepEqual(patterns, ['.II', '...II'], `the ceiling of 2 strips at each compile for ${JSON.stringify(options)}`);
        assert.deepEqual(byStep.map((step) => step.length), [1, 0], `said once, at the first step, for ${JSON.stringify(options)}`);
        assert.ok(lines[0]!.startsWith(`[${strategy.name}] an image fell past ${said}, so older images are now shown as placeholders`), lines[0]);
        assert.match(lines[0]!, / ns=/, 'through the namespaced route the warning takes');
      }
    });

    it(`${name}: says nothing when the host's own limit strips, or nothing falls past the ceiling`, async () => {
      for (const [options, steps, kept] of [
        [{ maxLiveImages: 2 }, [3, 2], '...II'],
        [{ maxLiveImages: 2, imageCeiling: 2 }, [3, 2], '...II'],
        [{ maxLiveImages: 0, imageCeiling: 2 }, [1, 1], 'II'],
        // The host's own byte limit strips, under the default byte ceiling.
        [{ maxLiveImageBytes: 8 }, [3, 2], '...II'],
        [{ maxLiveImageBytes: 8, imageByteCeiling: 8 }, [3, 2], '...II'],
      ] as const) {
        const { lines, last } = await ceilingLines(make(options), [...steps]);
        assert.equal(last, kept, `the strip ran for ${JSON.stringify(options)}`);
        assert.deepEqual(lines, [], `nothing said for ${JSON.stringify(options)}`);
      }
    });

    it(`${name}: says it once for each ceiling, when each first strips`, async () => {
      // Four-byte images fill the count ceiling of 3 first, at 12 of the 16
      // bytes; then a 16-byte image fills the byte ceiling, and the next one
      // falls past it.
      const strategy = make({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 3, imageByteCeiling: 16 });
      const { byStep, patterns } = await ceilingLines(strategy, [{ add: 4, bytes: 4 }, { add: 1, bytes: 16 }, { add: 1, bytes: 4 }]);
      // At the third step the byte walk drops the 16-byte image and, being
      // greedy, keeps two older 4-byte ones that still fit (as on main).
      assert.deepEqual(patterns, ['.III', '....I', '..II.I'], 'the count, then the bytes, strip');
      assert.deepEqual(byStep.map((step) => step.length), [1, 1, 0], JSON.stringify(byStep));
      assert.ok(byStep[0]![0]!.includes('an image fell past imageCeiling 3'), byStep[0]![0]);
      assert.ok(byStep[1]![0]!.includes('an image fell past imageByteCeiling 16 bytes'), byStep[1]![0]);
    });

    it(`${name}: says it for a single image bigger than the byte ceiling`, async () => {
      const { byStep, patterns } = await ceilingLines(make({ maxLiveImageBytes: 0, imageByteCeiling: 8 }), [{ add: 1, bytes: 12 }]);
      assert.deepEqual(patterns, ['.'], 'the one image is past the ceiling on its own');
      assert.equal(byStep[0]!.length, 1, JSON.stringify(byStep));
      assert.ok(byStep[0]![0]!.includes('an image fell past imageByteCeiling 8 bytes, which holds maxLiveImageBytes 0 (no limit) to it'), byStep[0]![0]);
    });

    it(`${name}: says nothing when the depth limit strips the image the ceiling would, and says it when only the ceiling does`, async () => {
      // Two 8-byte images under a 12-byte ceiling: the older one is past the
      // ceiling. With a depth limit that the older one is also past, the
      // depth strips it with or without the ceiling, so the ceiling decided
      // nothing (Anarchid's probe on #268, R1-4).
      const depth = { maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 2500 };
      const alone = await ceilingLines(make({ ...depth, imageByteCeiling: 0 }), [{ add: 2, bytes: 8 }]);
      assert.equal(alone.last, '.I', 'the depth limit alone strips the older image');
      const both = await ceilingLines(make({ ...depth, imageByteCeiling: 12 }), [{ add: 2, bytes: 8 }]);
      assert.equal(both.last, '.I', 'the ceiling changes nothing the window keeps');
      assert.deepEqual(both.lines, [], JSON.stringify(both.lines));
      const ceilingOnly = await ceilingLines(make({ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 12 }), [{ add: 2, bytes: 8 }]);
      assert.equal(ceilingOnly.last, '.I', 'without the depth limit, the ceiling strips the older image');
      assert.equal(ceilingOnly.lines.length, 1, JSON.stringify(ceilingOnly.lines));
    });

    it(`${name}: says nothing when the host's own count limit strips the image the byte ceiling would`, async () => {
      // The older image is past the host's maxLiveImages of 1 and past the
      // 12-byte ceiling: the host's limit strips it whatever the ceiling.
      const { lines, last } = await ceilingLines(make({ maxLiveImages: 1, maxLiveImageBytes: 0, imageByteCeiling: 12 }), [{ add: 2, bytes: 8 }]);
      assert.equal(last, '.I');
      assert.deepEqual(lines, [], JSON.stringify(lines));
    });

    it(`${name}: says nothing from renderAsNewest, whose render a ceiling strips, and leaves the line for the next compile`, async () => {
      const said: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: make({ maxLiveImages: 0, imageCeiling: 1 }) });
      const ours = () => said.filter((line) => line.includes('an image fell past'));
      try {
        const ids = [1, 2].map((i) => manager.addMessage('user', imageMessage(`img-${i}`)));
        const rendered = manager.renderAsNewest(ids);
        assert.ok(rendered, 'the strategy renders');
        const images = rendered.flatMap((content) => content ?? []).filter((b) => b.type === 'image').length;
        assert.equal(images, 1, 'the ceiling of 1 stripped the older image in the render');
        assert.deepEqual(ours(), [], 'the render says nothing');
        await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        assert.equal(ours().length, 1, JSON.stringify(said));
      } finally {
        console.warn = original;
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${name}: says nothing from a dry compile, and leaves the line for the first compile select returns`, async () => {
      for (const [options, said0] of [
        [{ maxLiveImages: 0, imageCeiling: 2 }, 'an image fell past imageCeiling 2'],
        [{ maxLiveImageBytes: 0, imageByteCeiling: 8 }, 'an image fell past imageByteCeiling 8 bytes'],
      ] as const) {
        const strategy = make(options);
        const said: string[] = [];
        const original = console.warn;
        console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
        const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
        const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
        const ours = () => said.filter((line) => line.includes('an image fell past'));
        try {
          for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
          const dry = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 }, undefined, { dryRun: true });
          assert.equal(pattern(dry.messages, 3), '.II', `the dry compile strips for ${JSON.stringify(options)}`);
          assert.deepEqual(ours(), [], `a dry compile says nothing for ${JSON.stringify(options)}`);
          await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
          assert.equal(ours().length, 1, `the compile returned says it for ${JSON.stringify(options)}`);
          assert.ok(ours()[0]!.includes(said0), ours()[0]);
        } finally {
          console.warn = original;
          await manager.close();
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }

  it('the memory strategy says it when its hysteresis watermark trims against a ceiling', async () => {
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 }),
      [5],
    );
    assert.equal(last, '...II', 'one trim to half the ceiling');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('an image fell past imageCeiling 4, which holds maxLiveImages 0 (no limit) to it'), lines[0]);
  });

  it('the memory strategy says it from its adaptive selection too, and nothing from a preview', async () => {
    const adaptive = memory({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 0, imageCeiling: 2,
    });
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: adaptive });
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    try {
      for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      const entries = manager.previewContext({ maxTokens: 1_000_000, reserveForResponse: 0 }, { imageCeiling: 1 }, { render: true })?.entries ?? [];
      assert.equal(pattern(entries, 3), '..I', 'the preview strips to its own ceiling');
      assert.deepEqual(ours(), [], 'a preview, with its own ceiling, says nothing');
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 3), '.II');
      assert.equal(ours().length, 1, JSON.stringify(said));
      assert.ok(ours()[0]!.includes('an image fell past imageCeiling 2, which holds maxLiveImages 0 (no limit) to it'), ours()[0]);
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the memory strategy's strip leaves the line only from a render select returns, not a layout rendered to compare against", async () => {
    for (const options of [
      { maxLiveImages: 0, imageCeiling: 1 },
      { maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 4 },
    ]) {
    const strategy = memory(options);
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    try {
      for (let i = 1; i <= 2; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      const view = (manager as unknown as { messageStore: { createView(): unknown } }).messageStore.createView() as {
        getAll(): Array<{ id: string; participant: string; content: ContentBlock[] }>;
      };
      const entries = () => view.getAll().map((m, index) => ({
        index, sourceMessageId: m.id, sourceRelation: 'copy', participant: m.participant, content: m.content,
      }));
      const strip = strategy as unknown as {
        applyImageStripping(entries: unknown[], store: unknown, opts?: { returned?: boolean }): void;
        reportCeilingHits(): void;
      };
      const kept = entries();
      strip.applyImageStripping(kept, view);
      assert.equal(kept.filter((e) => e.content.some((b) => b.type === 'image')).length, 1, 'the strip ran: the ceiling replaced one');
      strip.reportCeilingHits();
      assert.deepEqual(ours(), [], `a layout rendered to compare against leaves nothing for ${JSON.stringify(options)}`);
      strip.applyImageStripping(entries(), view, { returned: true });
      assert.deepEqual(ours(), [], 'the strip itself says nothing: select reports once it returns the render');
      strip.reportCeilingHits();
      assert.equal(ours().length, 1, JSON.stringify(said));
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
    }
  });

  it('the memory strategy says nothing for a select it refuses, and says it for the next one it returns', async () => {
    const adaptive = memory({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 0, imageCeiling: 2,
    });
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: adaptive });
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    try {
      for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      // The newest turn is a call with no result yet: structural repair drops
      // it, and the check after the strip refuses the select.
      manager.addMessage('Claude', [{ type: 'tool_use', id: 'tu-1', name: 'shot', input: {} }] as ContentBlock[]);
      await assert.rejects(manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 }),
        { message: /^Structural repair did not retain the newest turn/ });
      assert.deepEqual(ours(), [], 'a refused select says nothing');
      manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'tu-1', content: 'done' }] as ContentBlock[]);
      await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(ours().length, 1, JSON.stringify(said));
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the memory strategy's watermark, moved by a new message, says nothing until a compile returns", async () => {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const strategy = memory({ maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    try {
      // The fifth image's message moves the watermark past the ceiling of 4.
      for (let i = 1; i <= 5; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      assert.notEqual(watermarkOf(manager, strategy), null, 'the new messages moved the watermark');
      assert.deepEqual(ours(), [], 'the new messages say nothing');
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 5), '...II', 'one trim to half the ceiling');
      assert.equal(ours().length, 1, JSON.stringify(said));
      assert.ok(ours()[0]!.includes('an image fell past imageCeiling 4'), ours()[0]);
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the memory strategy says nothing for a watermark a preview's own ceiling moved", async () => {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const strategy = memory({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 0, imageCeiling: 10, imageStripHysteresisRatio: 0.5,
    });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    try {
      for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      // A preview with a ceiling of 2 moves the watermark, for itself only:
      // its trim to half keeps one image, where the count alone keeps two.
      const entries = manager.previewContext({ maxTokens: 1_000_000, reserveForResponse: 0 }, { imageCeiling: 2 }, { render: true })?.entries ?? [];
      assert.equal(pattern(entries, 4), '...I', "the preview's own watermark trimmed to half its ceiling");
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 4), 'IIII', 'the real ceiling of 10 strips nothing');
      assert.deepEqual(ours(), [], "the preview's hypothetical ceiling left no line");
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the memory strategy says nothing for a host with no limits, after a preview with a ceiling of its own', async () => {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    // Every limit off (the helper sets no depth strip), so the compile's strip has nothing to record.
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      strategy: memory({
        hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
        autoTickOnNewMessage: false, maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 0, imageByteCeiling: 0,
      }),
    });
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    try {
      for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      const entries = manager.previewContext({ maxTokens: 1_000_000, reserveForResponse: 0 }, { imageCeiling: 1 }, { render: true })?.entries ?? [];
      assert.equal(pattern(entries, 3), '..I', 'the preview strips to its own ceiling');
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 3), 'III', 'with no limits, the compile keeps every image');
      assert.deepEqual(ours(), [], "the preview's strip isn't the compile's");
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the memory strategy leaves an image below a watermark it loaded to the watermark, and says it when its own walk meets the ceiling', async () => {
    // One instance's ceiling moves the watermark and says so. A second
    // instance loads that watermark, which carries no record of what moved it.
    // When the images above it exactly fill the ceiling, an image below it is
    // past the ceiling too, but the watermark is what strips it, so the second
    // instance says nothing until its own walk meets the ceiling.
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const options = { maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 };
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    const budget = { maxTokens: 1_000_000, reserveForResponse: 0 };
    try {
      const first = await ContextManager.open({ path: join(dir, 'store'), strategy: memory(options) });
      for (let i = 1; i <= 5; i++) first.addMessage('user', imageMessage(`img-${i}`));
      assert.equal(pattern((await first.compile(budget)).messages, 5), '...II', 'the ceiling trims to half of 4');
      assert.equal(ours().length, 1, JSON.stringify(said));
      await first.close();
      said.length = 0;
      const second = await ContextManager.open({ path: join(dir, 'store'), strategy: memory(options) });
      try {
        for (let i = 6; i <= 7; i++) second.addMessage('user', imageMessage(`img-${i}`));
        assert.equal(pattern((await second.compile(budget)).messages, 7), '...IIII', 'four above the loaded watermark fill the ceiling');
        assert.deepEqual(ours(), [], JSON.stringify(said));
        second.addMessage('user', imageMessage('img-8'));
        assert.equal(pattern((await second.compile(budget)).messages, 8), '......II', "the second instance's own walk meets the ceiling");
        assert.equal(ours().length, 1, JSON.stringify(said));
      } finally {
        await second.close();
      }
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [kind, options] of [
    ['count', { maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 }],
    ['byte', { maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 16, imageStripHysteresisRatio: 0.5 }],
  ] as const) {
    it(`the memory strategy leaves a watermark's line with the branch it moved on, under the ${kind} ceiling`, async () => {
      const said: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const strategy = memory(options);
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
      const ours = () => said.filter((line) => line.includes('an image fell past'));
      try {
        manager.addMessage('user', imageMessage('img-1'));
        const main = manager.currentBranch().name;
        await manager.fork('busy');
        // On the fork, new messages move the watermark past the ceiling: four
        // more images make five, past a count of 4 and past 16 bytes.
        for (let i = 2; i <= 5; i++) manager.addMessage('user', imageMessage(`img-${i}`));
        assert.notEqual(watermarkOf(manager, strategy), null, "the fork's new messages moved its watermark");
        await manager.switchBranch(main);
        const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        assert.equal(pattern(compiled.messages, 1), 'I', 'main holds one image, under its ceiling');
        assert.deepEqual(ours(), [], "main's compile says nothing for the fork's watermark");
      } finally {
        console.warn = original;
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("the memory strategy's watermark says nothing when the host's own limit binds", async () => {
    const { lines, last } = await ceilingLines(memory({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }), [5]);
    assert.equal(last, '...II', 'one trim to half the host limit');
    assert.deepEqual(lines, []);
  });

  it("the memory strategy's watermark says nothing when the depth limit moves it where the ceiling also would", async () => {
    // Three 8-byte images under a 20-byte ceiling: the oldest is past the
    // ceiling (24 bytes) and, two image messages deep, past the depth limit
    // too, so the depth moves the watermark with or without the ceiling.
    const depth = { maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 2500, imageStripHysteresisRatio: 0.5 };
    const alone = await ceilingLines(memory({ ...depth, imageByteCeiling: 0 }), [{ add: 3, bytes: 8 }]);
    const both = await ceilingLines(memory({ ...depth, imageByteCeiling: 20 }), [{ add: 3, bytes: 8 }]);
    assert.notEqual(alone.watermarks[0], null, 'the depth limit alone moves the watermark');
    assert.equal(both.watermarks[0], alone.watermarks[0], 'to the same place with the ceiling');
    assert.equal(both.last, alone.last, 'the ceiling changes nothing the window keeps');
    assert.equal(both.last, '..I');
    assert.deepEqual(both.lines, [], JSON.stringify(both.lines));
  });

  it("the memory strategy's watermark says it when only the ceiling moves it, and nothing when the depth limit would move it anyway", async () => {
    // Image messages price at about 1,600 tokens. Under a 4,000-token depth
    // limit, the oldest of three is past the depth by the strips' measure
    // (its own message counted) but not by the watermark's (newer messages
    // only), so without a ceiling the watermark doesn't move. A count ceiling
    // of 2 moves it, and its trim to half strips the middle image too, which
    // the depth limit alone keeps: the ceiling decided.
    const options = { maxLiveImages: 0, imageStripDepthTokens: 4000, imageStripHysteresisRatio: 0.5 };
    const alone = await ceilingLines(memory({ ...options, imageCeiling: 0 }), [3]);
    assert.equal(alone.watermarks[0], null, 'the depth limit alone moves no watermark');
    assert.equal(alone.last, '.II');
    const ceiling = await ceilingLines(memory({ ...options, imageCeiling: 2 }), [3]);
    assert.notEqual(ceiling.watermarks[0], null);
    assert.equal(ceiling.last, '..I', 'the ceiling strips what the depth limit alone keeps');
    assert.equal(ceiling.lines.length, 1, JSON.stringify(ceiling.lines));
    assert.ok(ceiling.lines[0]!.includes('an image fell past imageCeiling 2'), ceiling.lines[0]);
    // Under a 3,000-token depth limit, the oldest of the three is past the
    // depth by the watermark's measure too, from the message that brings the
    // ceiling's first misfit on, so the depth limit moves the watermark with
    // or without the ceiling, to the same place.
    const deeper = { maxLiveImages: 0, imageStripDepthTokens: 3000, imageStripHysteresisRatio: 0.5 };
    const deepAlone = await ceilingLines(memory({ ...deeper, imageCeiling: 0 }), [3]);
    assert.notEqual(deepAlone.watermarks[0], null, 'the depth limit moves the watermark');
    const deepCeiling = await ceilingLines(memory({ ...deeper, imageCeiling: 2 }), [3]);
    assert.equal(deepCeiling.watermarks[0], deepAlone.watermarks[0]);
    assert.equal(deepCeiling.last, deepAlone.last, 'the ceiling changes nothing the window keeps');
    assert.deepEqual(deepCeiling.lines, [], JSON.stringify(deepCeiling.lines));
  });

  /** Compile, after adding each message in turn, with a strategy built from
   *  `options`; the window kept, the watermark, and the ceiling lines said. */
  async function watermarkRun(options: Record<string, unknown>, messages: unknown[][]) {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const strategy = memory(options);
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    try {
      for (const content of messages) manager.addMessage('user', content as never);
      const images = messages.filter((content) => content.some((b) => (b as { type?: string }).type === 'image')).length;
      const kept = pattern((await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages, images);
      return { kept, watermark: watermarkOf(manager, strategy), lines: said.filter((line) => line.includes('an image fell past')) };
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("the memory strategy's watermark says nothing when the depth limit brings the move on, though the byte ceiling's trim lands it newer", async () => {
    // A 4-byte image, about 3,100 tokens of text, then a 16-byte image. When
    // the second image comes, the first is past a 4,000-token depth limit, so
    // the watermark moves with or without a ceiling. Without one, its trim to
    // half the depth lands on the first image. The trim to half of a 20-byte
    // ceiling, 10 bytes, can't keep the 16-byte image either, so it lands
    // there and strips it. No image passed the ceiling itself (20 bytes in
    // all), so the line, which says one did, stays quiet.
    const text = [{ type: 'text', text: 'word '.repeat(1800) }];
    const options = { maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 4000, imageStripHysteresisRatio: 0.5 };
    const alone = await watermarkRun({ ...options, imageByteCeiling: 0 }, [imageMessage('img-1', 4), text, imageMessage('img-2', 16)]);
    assert.notEqual(alone.watermark, null, 'the depth limit alone moves the watermark');
    assert.equal(alone.kept, '.I', 'and keeps the 16-byte image');
    const ceiling = await watermarkRun({ ...options, imageByteCeiling: 20 }, [imageMessage('img-1', 4), text, imageMessage('img-2', 16)]);
    assert.equal(ceiling.kept, '..', "the ceiling's trim strips the 16-byte image too");
    assert.ok(ceiling.watermark! > alone.watermark!, 'it lands newer');
    assert.deepEqual(ceiling.lines, []);
  });

  it("the memory strategy's watermark says nothing for an image its move strips that the depth limit strips anyway", async () => {
    // A 16-byte image, about 1,500 tokens of text, then an 8-byte image. The
    // first image passes a 20-byte ceiling (24 bytes), so the watermark moves
    // onto it. By the watermark's measure, the messages newer than it, it's
    // within a 4,000-token depth limit, so the host's own limits wouldn't
    // move it. But the strip counts the image's own message too, and by that
    // measure it's past the depth: the render strips it with or without the
    // ceiling, so the ceiling decided nothing.
    const text = [{ type: 'text', text: 'word '.repeat(870) }];
    const options = { maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 4000, imageStripHysteresisRatio: 0.5 };
    const messages = [imageMessage('img-1', 16), text, imageMessage('img-2', 8)];
    const alone = await watermarkRun({ ...options, imageByteCeiling: 0 }, messages);
    assert.equal(alone.watermark, null, 'without the ceiling the watermark stays');
    assert.equal(alone.kept, '.I', 'the depth limit strips the first image');
    const ceiling = await watermarkRun({ ...options, imageByteCeiling: 20 }, messages);
    assert.notEqual(ceiling.watermark, null, 'the ceiling moves the watermark');
    assert.equal(ceiling.kept, '.I', 'the render is the same');
    assert.deepEqual(ceiling.lines, []);
  });

  it("the memory strategy's watermark says nothing when the host's own count limit brings the move on, though the byte ceiling's trim lands it newer", async () => {
    // A host count limit of 2, in force, and a byte ceiling of 20. When the
    // third image (12 bytes) comes, the host's count misfits the oldest, so
    // the watermark moves anyway; its own trim, to a count of 1, would land on
    // the middle image. The byte ceiling's trim, to 10 bytes, can't keep the
    // 12-byte image, so it lands newer, on it. No image passed the byte
    // ceiling itself (20 bytes in all), and the count limit is the host's.
    const { lines, patterns } = await ceilingLines(
      memory({ maxLiveImages: 2, maxLiveImageBytes: 0, imageByteCeiling: 20, imageStripHysteresisRatio: 0.5 }),
      [{ add: 2, bytes: 4 }, { add: 1, bytes: 12 }],
    );
    assert.deepEqual(patterns, ['II', '...'], 'the byte trim strips the newest image too');
    assert.deepEqual(lines, []);
  });

  it("the memory strategy's watermark says nothing when the host's own byte limit brings the move on, though the count ceiling's trim lands it newer", async () => {
    // A host byte limit of 40, in force, and a count ceiling of 4. When three
    // 4-byte images come after a 32-byte one, the host's byte limit misfits
    // the oldest (44 bytes), so the watermark moves anyway; its own trim, to
    // 20 bytes, would land on that oldest image. The count ceiling's trim, to
    // 2, lands newer, on the second-oldest. No image passed the count
    // ceiling itself (4 images in all), and the byte limit is the host's.
    const { lines, patterns } = await ceilingLines(
      memory({ maxLiveImages: 0, imageCeiling: 4, maxLiveImageBytes: 40, imageStripHysteresisRatio: 0.5 }),
      [{ add: 1, bytes: 32 }, { add: 3, bytes: 4 }],
    );
    assert.deepEqual(patterns, ['I', '..II'], 'the count trim strips the second-oldest image too');
    assert.deepEqual(lines, []);
  });

  it("the memory strategy's watermark names the count ceiling an image passed, not a byte ceiling none did", async () => {
    // Both window limits are set by their ceilings. The fifth 4-byte image
    // passes the count ceiling of 4, and 20 bytes are far under the byte
    // ceiling, so only the count ceiling brought the move on.
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 }),
      [5],
    );
    assert.equal(last, '...II');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('an image fell past imageCeiling 4'), lines[0]);
  });

  it("the memory strategy's watermark says nothing for a ceiling's move that the host's own limit later overtakes, before a render", async () => {
    // A count ceiling of 4 and a host byte limit of 40, in force. The fifth
    // image passes the count ceiling and moves the watermark onto the
    // third-newest. Before any compile, a 44-byte image passes the host's
    // byte limit on its own and moves the watermark onto itself: the host's
    // limit strips every image now, those the ceiling's move stripped too, so
    // the render is the same with or without the ceiling.
    const messages = [imageMessage('img-1', 20), ...[2, 3, 4, 5].map((i) => imageMessage(`img-${i}`)), imageMessage('img-6', 44)];
    const options = { maxLiveImages: 0, maxLiveImageBytes: 40, imageStripHysteresisRatio: 0.5 };
    const alone = await watermarkRun({ ...options, imageCeiling: 0 }, messages);
    const ceiling = await watermarkRun({ ...options, imageCeiling: 4 }, messages);
    assert.equal(ceiling.kept, '......');
    assert.equal(ceiling.kept, alone.kept, 'the render is the same without the ceiling');
    assert.deepEqual(ceiling.lines, []);
  });

  it("the memory strategy's watermark names the count ceiling for an image its move stripped that the host's own limit, landing older, keeps", async () => {
    // A count ceiling of 4 and a host byte limit of 40, in force. When the
    // fifth image comes (8 bytes, after a 24-byte one and three 4-byte ones),
    // it passes both: the count ceiling and 44 bytes. The host's limit alone
    // would trim to 20 bytes, landing on the oldest; the count ceiling's trim,
    // to 2, lands on the middle image. So the two between are stripped only
    // because an image passed the count ceiling.
    const messages = [imageMessage('img-1', 24), ...[2, 3, 4].map((i) => imageMessage(`img-${i}`)), imageMessage('img-5', 8)];
    const options = { maxLiveImages: 0, maxLiveImageBytes: 40, imageStripHysteresisRatio: 0.5 };
    const alone = await watermarkRun({ ...options, imageCeiling: 0 }, messages);
    assert.equal(alone.kept, '.IIII', "the host's limit alone strips the oldest");
    const ceiling = await watermarkRun({ ...options, imageCeiling: 4 }, messages);
    assert.equal(ceiling.kept, '...II');
    assert.equal(ceiling.lines.length, 1, JSON.stringify(ceiling.lines));
    assert.ok(ceiling.lines[0]!.includes('an image fell past imageCeiling 4'), ceiling.lines[0]);
  });

  it("the memory strategy's watermark names the byte ceiling for an image its move stripped that the host's own limit, landing older, keeps", async () => {
    // The mirror, with a byte ceiling of 20 and a host count limit of 4, in
    // force. When the fifth image comes (8 bytes, after three 4-byte ones and
    // an 8-byte one), the second-oldest passes the byte ceiling (24 bytes)
    // while the count is 3. The host's count alone would move the watermark
    // only at the oldest and trim to 2, landing on the middle image; the byte
    // ceiling's trim, to 10 bytes, lands on the 8-byte fourth image. So that
    // one is stripped only because an image passed the byte ceiling.
    const messages = [...[1, 2, 3].map((i) => imageMessage(`img-${i}`)), imageMessage('img-4', 8), imageMessage('img-5', 8)];
    const options = { maxLiveImages: 4, maxLiveImageBytes: 0, imageStripHysteresisRatio: 0.5 };
    const alone = await watermarkRun({ ...options, imageByteCeiling: 0 }, messages);
    assert.equal(alone.kept, '...II', "the host's count alone strips the three oldest");
    const ceiling = await watermarkRun({ ...options, imageByteCeiling: 20 }, messages);
    assert.equal(ceiling.kept, '....I');
    assert.equal(ceiling.lines.length, 1, JSON.stringify(ceiling.lines));
    assert.ok(ceiling.lines[0]!.includes('an image fell past imageByteCeiling 20 bytes'), ceiling.lines[0]);
  });

  it("the memory strategy's watermark says nothing for an image its move stripped that the host's own limit strips anyway by render time", async () => {
    // A count ceiling of 4 and a host byte limit of 40, in force. The fifth
    // image passes the count ceiling and moves the watermark onto the middle
    // image, which the host's limit alone would keep then. A 24-byte image
    // comes before any compile: above the watermark it fits, but in the
    // render the middle image no longer fits the host's 40 bytes with the
    // images kept after it, so the host's limit strips it anyway.
    const messages = [...[1, 2, 3].map((i) => imageMessage(`img-${i}`, 12)), imageMessage('img-4'), imageMessage('img-5'), imageMessage('img-6', 24)];
    const ceiling = await watermarkRun({ maxLiveImages: 0, imageCeiling: 4, maxLiveImageBytes: 40, imageStripHysteresisRatio: 0.5 }, messages);
    assert.equal(ceiling.kept, '...III');
    assert.deepEqual(ceiling.lines, []);
  });

  for (const [kind, options, why] of [
    ['byte', { maxLiveImages: 0, imageCeiling: 4, maxLiveImageBytes: 16 }, 'the host byte limit of 16 lands it where the count ceiling of 4 does'],
    ['count', { maxLiveImages: 4, maxLiveImageBytes: 0, imageByteCeiling: 16 }, 'the host count limit of 4 lands it where the byte ceiling of 16 does'],
  ] as const) {
    it(`the memory strategy's watermark says nothing when the host's own ${kind} limit would land it where a ceiling does`, async () => {
      // The fifth 4-byte image passes both the host's limit and the ceiling,
      // and both trims, to 2 images and to 8 bytes, land on the third-newest:
      // ${why}, so the host's limits strip the same images anyway.
      const { lines, last } = await ceilingLines(memory({ ...options, imageStripHysteresisRatio: 0.5 }), [5]);
      assert.equal(last, '...II');
      assert.deepEqual(lines, [], why);
    });
  }

  it("the memory strategy's watermark credits the ceiling that brought the move, where the trim stops at the depth", async () => {
    // A count ceiling of 4 and a 20,000-token depth limit. The fifth image's
    // message brings the ceiling's misfit on the oldest, with nothing past
    // the depth. About 9,000 tokens of text before the newest image put the
    // second-newest past half the depth, so the trim lands there by the
    // depth, not the count: the move is still the ceiling's.
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const strategy = memory({ maxLiveImages: 0, imageCeiling: 4, imageStripDepthTokens: 20000, imageStripHysteresisRatio: 0.5 });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    try {
      for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(5200) }]);
      manager.addMessage('user', imageMessage('img-5'));
      const kept = pattern((await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages, 5);
      assert.equal(kept, '....I', 'the trim lands on the second-newest image');
      const ours = said.filter((line) => line.includes('an image fell past'));
      assert.equal(ours.length, 1, JSON.stringify(said));
      assert.ok(ours[0]!.includes('an image fell past imageCeiling 4'), ours[0]);
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks only defaults in force: an explicit undefined maxLiveImages is no limit in the memory strategy, and 6 in windowed passthrough', async () => {
    const auto = await ceilingLines(memory({ maxLiveImages: undefined, imageCeiling: 2 }), [3]);
    assert.equal(auto.lines.length, 1, JSON.stringify(auto.lines));
    assert.ok(auto.lines[0]!.includes('which holds maxLiveImages 0 (no limit) to it,'), auto.lines[0]);
    const win = await ceilingLines(windowed({ maxLiveImages: undefined, imageCeiling: 2 }), [3]);
    assert.equal(win.lines.length, 1, JSON.stringify(win.lines));
    assert.ok(win.lines[0]!.includes('which holds maxLiveImages 6 (default) to it,'), win.lines[0]);
  });

  it("doesn't mark a value a subclass's enforced layer gives as a default", async () => {
    class Enforced extends AutobiographicalStrategy {
      protected override enforcedConfigLayer() {
        return { source: 'enforced', values: { imageCeiling: 2 } };
      }
    }
    const { lines } = await ceilingLines(
      new Enforced({ headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0, maxLiveImages: 0 } as ConstructorParameters<typeof AutobiographicalStrategy>[0]),
      [3],
    );
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('an image fell past imageCeiling 2, which holds'), lines[0]);
  });

  it('ceilingBoundLine marks a default or malformed ceiling, and gives bytes in MiB', () => {
    const configured = (o: Record<string, number>) =>
      ({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 500, imageByteCeiling: 24 * MiB, ...o });
    assert.equal(ceilingBoundLine('s', 'images', configured({}), new Set(['imageCeiling'])),
      '[s] an image fell past imageCeiling 500 (default), which holds maxLiveImages 0 (no limit) to it, so older images are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'images', configured({ imageCeiling: Number.NaN, maxLiveImages: 800 }), new Set()),
      '[s] an image fell past imageCeiling 500 (default), which holds maxLiveImages 800 to it, so older images are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'bytes', configured({ maxLiveImageBytes: 30 * MiB }), new Set()),
      '[s] an image fell past imageByteCeiling 24 MiB, which holds maxLiveImageBytes 30 MiB to it, so older images are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'bytes', configured({ maxLiveImageBytes: 30 * MiB + 1 }), new Set(['imageByteCeiling'])),
      `[s] an image fell past imageByteCeiling 24 MiB (default), which holds maxLiveImageBytes ${30 * MiB + 1} bytes to it, so older images are now shown as placeholders`);
  });

  it('the memory strategy says it when its hysteresis watermark trims against the byte ceiling', async () => {
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 16, imageStripHysteresisRatio: 0.5 }),
      [5],
    );
    assert.equal(last, '...II', 'one trim to half the ceiling');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('an image fell past imageByteCeiling 16 bytes, which holds maxLiveImageBytes 0 (no limit) to it'), lines[0]);
  });
});

describe('compression prompts within the image ceilings', () => {
  it('carry at most imageCeiling, the newest messages first', () => {
    const prepared = new Prepared({ imageCeiling: 2 }).prepare(
      request([imageBlock('AAAA')], [imageBlock('BBBB')], [imageBlock('CCCC')]),
    );
    assert.equal(prepared.imageReplacements, 1);
    assert.equal(prepared.imageCountCap, 2);
    assert.equal(prepared.imagesKept, 2);
    assert.deepEqual(prepared.request.messages.map((m) => m.content[0]!.type), ['text', 'image', 'image']);
    assert.equal((prepared.request.messages[0]!.content[0] as { text: string }).text, PLACEHOLDER);
  });

  it('count an image nested in a tool result toward the ceiling', () => {
    const prepared = new Prepared({ imageCeiling: 1 }).prepare(request(
      [imageBlock('AAAA')],
      [{ type: 'tool_result', toolUseId: 't', content: [imageBlock('BBBB')] } as ContentBlock],
    ));
    assert.equal(prepared.imageReplacements, 1);
    assert.equal(prepared.imagesKept, 1);
    const nested = (prepared.request.messages[1]!.content[0] as { content: ContentBlock[] }).content[0]!;
    assert.equal(nested.type, 'image', 'the newer, nested image takes the one slot');
    assert.equal((prepared.request.messages[0]!.content[0] as { text: string }).text, PLACEHOLDER, 'and the older one is replaced');
  });

  it('count a generated image toward the ceiling, so a newer one takes the last slot from an older image', () => {
    const generated = { type: 'generated_image', data: 'BBBB', mimeType: 'image/png' } as ContentBlock;
    const prepared = new Prepared({ imageCeiling: 1 }).prepare(request([imageBlock('AAAA')], [generated]));
    assert.equal(prepared.imageReplacements, 1);
    assert.equal(prepared.imagesKept, 1);
    assert.equal(prepared.request.messages[1]!.content[0]!.type, 'generated_image', 'the newer, generated image takes the one slot');
    assert.equal((prepared.request.messages[0]!.content[0] as { text: string }).text, PLACEHOLDER, 'and the older one is replaced');
  });

  it('keep their byte budget within imageByteCeiling, and the images kept are what it lets through', () => {
    const prepared = new Prepared({ maxCompressionImageBytes: 3 * MiB, imageByteCeiling: 2 * MiB }).prepare(request([]));
    assert.equal(prepared.imageBudgetBytes, 2 * MiB);
    for (const none of [0, Infinity, -3, Number.NaN]) {
      assert.equal(new Prepared({ maxCompressionImageBytes: none, imageByteCeiling: 8 }).prepare(request([])).imageBudgetBytes, 8,
        `a budget of ${none} is none, so up to the byte ceiling`);
    }
    assert.equal(new Prepared({ maxCompressionImageBytes: 8.5, imageByteCeiling: 100 }).prepare(request([])).imageBudgetBytes, 8,
      'a fractional budget is floored');
    const walked = new Prepared({ maxCompressionImageBytes: 12, imageByteCeiling: 8 }).prepare(
      request([imageBlock('AAAA')], [imageBlock('BBBB')], [imageBlock('CCCC')]),
    );
    assert.equal(walked.imageBudgetBytes, 8);
    assert.equal(walked.imageReplacements, 1, 'under the clamped 8 bytes, two 4-byte images fit and the oldest does not');
    assert.equal(walked.imageBytesKept, 8);
    assert.deepEqual(walked.request.messages.map((m) => m.content[0]!.type), ['text', 'image', 'image'], 'the oldest is the one replaced');
    assert.equal(new Prepared({ maxCompressionImageBytes: 0, imageByteCeiling: 2 * MiB }).prepare(request([])).imageBudgetBytes,
      2 * MiB, 'an unlimited budget means up to the ceiling');
    assert.equal(new Prepared().prepare(request([])).imageBudgetBytes, 12 * MiB, 'the default budget is under the default ceiling');
  });

  it('carry at most imageCeiling with no byte budget, and say only the ceiling', () => {
    const strategy = new Prepared({ maxCompressionImageBytes: 0, imageByteCeiling: 0, imageCeiling: 1 });
    const input = request([imageBlock('AAAA')], [imageBlock('BBBB')]);
    assert.equal(strategy.prepare(input).imageReplacements, 1);
    assert.deepEqual(captureErrors(() => strategy.send(input, 'no-budget')), [
      '[autobiographical] compression prompt: replaced 1 image(s) with placeholders to stay under the ' +
        '1-image ceiling (kept 1 image(s), 0.0MiB, newest messages first) [no-budget]',
    ]);
  });

  it('with no count ceiling, keep to the byte budget, and the log says only the budget', () => {
    const strategy = new Prepared({ maxCompressionImageBytes: 8, imageCeiling: 0 });
    const input = request([imageBlock('AAAA')], [imageBlock('BBBB')], [imageBlock('CCCC')]);
    const prepared = strategy.prepare(input);
    assert.equal(prepared.imageCountCap, 0);
    assert.equal(prepared.imageReplacements, 1, 'two 4-byte images fit the 8-byte budget, the oldest does not');
    assert.deepEqual(prepared.request.messages.map((m) => m.content[0]!.type), ['text', 'image', 'image']);
    const logs = captureErrors(() => strategy.send(input, 'no-count'));
    assert.equal(logs.length, 1);
    assert.ok(!logs[0]!.includes('image ceiling'), logs[0]);
    assert.ok(logs[0]!.includes('inline image budget (kept 2 image(s)'), logs[0]);
  });

  it('with no budget and no ceilings, keep every image, more than the default ceiling of 500', () => {
    const images = Array.from({ length: 501 }, () => [imageBlock('AAAA')]);
    const prepared = new Prepared({ maxCompressionImageBytes: 0, imageCeiling: 0, imageByteCeiling: 0 }).prepare(
      request(...images),
    );
    assert.equal(prepared.imageReplacements, 0);
    assert.equal(prepared.request.messages.filter((m) => m.content[0]!.type === 'image').length, 501, 'all 501 are still images');
  });
});
