/**
 * The image ceilings (imageCeiling, imageByteCeiling): the most images, and
 * their bytes, a strategy's live window keeps, and the most
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
/** What every ceiling line says, and no other line. */
const CEILING_LINE = 'so some images are now shown as placeholders';

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
    it(`${name}: the count ceiling binds the images the window counts, nested and generated ones included`, async () => {
      // What the ceilings bind is what the window counts: every image, an
      // image nested in a tool result and a generated image among them.
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
        assert.equal(nested, 0, 'the nested images are past a count ceiling of 1');
        const kept = blocks.filter((b) => b.type === 'generated_image').length;
        assert.equal(kept, 1, 'the newest image, a generated one, takes the one slot');
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

  it('the hysteresis rule trims against the ceiling when the count is unlimited', async () => {
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

describe('the hysteresis rule against the byte ceiling', () => {
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

describe('the line when an image ceiling first strips', () => {
  /** Run `steps` on a fresh store: each adds images (`add`, of `bytes` each,
   *  4 when not given) and compiles. Returns the ceiling lines each step said,
   *  in order, the pattern each compile kept, and the last pattern. Byte
   *  sizes are multiples of 4: the store keeps an
   *  image's data as the bytes its base64 decodes to, so other lengths
   *  come back changed. */
  async function ceilingLines(
    strategy: ContextStrategy,
    steps: Array<number | { add: number; bytes: number }>,
  ): Promise<{ lines: string[]; byStep: string[][]; patterns: string[]; last: string }> {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    let n = 0;
    const byStep: string[][] = [];
    const patterns: string[] = [];
    try {
      for (const step of steps) {
        const { add, bytes } = typeof step === 'number' ? { add: step, bytes: 4 } : step;
        const before = said.length;
        for (let i = 0; i < add; i++) manager.addMessage('user', imageMessage(`img-${++n}`, bytes));
        patterns.push(pattern((await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages, n));
        byStep.push(said.slice(before).filter((line) => line.includes(CEILING_LINE)));
      }
      return { lines: byStep.flat(), byStep, patterns, last: patterns[patterns.length - 1] ?? '' };
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: says once which ceiling strips, and what it holds`, async () => {
      const cases = [
        [{ maxLiveImages: 0, imageCeiling: 2 }, 'imageCeiling 2 holds maxLiveImages 0 (no limit) to it'],
        [{ maxLiveImages: 5, imageCeiling: 2 }, 'imageCeiling 2 holds maxLiveImages 5 to it'],
        [{ imageCeiling: 2 }, 'imageCeiling 2 holds maxLiveImages 6 (default) to it'],
        [{ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 8 },
          'imageByteCeiling 8 bytes holds maxLiveImageBytes 0 (no limit) to it'],
      ] as const;
      for (const [options, said] of cases) {
        // Three images, then two more: the ceiling strips at the first compile
        // and again at the second, and it's said once, at the first.
        const strategy = make(options);
        const { lines, byStep, patterns } = await ceilingLines(strategy, [3, 2]);
        assert.deepEqual(patterns, ['.II', '...II'], `the ceiling of 2 strips at each compile for ${JSON.stringify(options)}`);
        assert.deepEqual(byStep.map((step) => step.length), [1, 0], `said once, at the first step, for ${JSON.stringify(options)}`);
        assert.ok(lines[0]!.startsWith(`[${strategy.name}] ${said}, so some images are now shown as placeholders`), lines[0]);
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
      assert.ok(byStep[0]![0]!.includes('imageCeiling 3 holds'), byStep[0]![0]);
      assert.ok(byStep[1]![0]!.includes('imageByteCeiling 16 bytes holds'), byStep[1]![0]);
    });

    it(`${name}: says it for a single image bigger than the byte ceiling`, async () => {
      const { byStep, patterns } = await ceilingLines(make({ maxLiveImageBytes: 0, imageByteCeiling: 8 }), [{ add: 1, bytes: 12 }]);
      assert.deepEqual(patterns, ['.'], 'the one image is past the ceiling on its own');
      assert.equal(byStep[0]!.length, 1, JSON.stringify(byStep));
      assert.ok(byStep[0]![0]!.includes('imageByteCeiling 8 bytes holds maxLiveImageBytes 0 (no limit) to it'), byStep[0]![0]);
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
      const ours = () => said.filter((line) => line.includes(CEILING_LINE));
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
        [{ maxLiveImages: 0, imageCeiling: 2 }, 'imageCeiling 2 holds'],
        [{ maxLiveImageBytes: 0, imageByteCeiling: 8 }, 'imageByteCeiling 8 bytes holds'],
      ] as const) {
        const strategy = make(options);
        const said: string[] = [];
        const original = console.warn;
        console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
        const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
        const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
        const ours = () => said.filter((line) => line.includes(CEILING_LINE));
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

  it('the memory strategy says it when its hysteresis rule trims against a ceiling', async () => {
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 }),
      [5],
    );
    assert.equal(last, '...II', 'one trim to half the ceiling');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('imageCeiling 4 holds maxLiveImages 0 (no limit) to it'), lines[0]);
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
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
    try {
      for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      const entries = manager.previewContext({ maxTokens: 1_000_000, reserveForResponse: 0 }, { imageCeiling: 1 }, { render: true })?.entries ?? [];
      assert.equal(pattern(entries, 3), '..I', 'the preview strips to its own ceiling');
      assert.deepEqual(ours(), [], 'a preview, with its own ceiling, says nothing');
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 3), '.II');
      assert.equal(ours().length, 1, JSON.stringify(said));
      assert.ok(ours()[0]!.includes('imageCeiling 2 holds maxLiveImages 0 (no limit) to it'), ours()[0]);
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
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
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
        reportCeilingHits(store: unknown): void;
      };
      const kept = entries();
      strip.applyImageStripping(kept, view);
      assert.equal(kept.filter((e) => e.content.some((b) => b.type === 'image')).length, 1, 'the strip ran: the ceiling replaced one');
      strip.reportCeilingHits(view);
      assert.deepEqual(ours(), [], `a layout rendered to compare against leaves nothing for ${JSON.stringify(options)}`);
      strip.applyImageStripping(entries(), view, { returned: true });
      assert.deepEqual(ours(), [], 'the strip itself says nothing: select reports once it returns the render');
      strip.reportCeilingHits(view);
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
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
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

  it("the memory strategy says nothing for the rule's set under a preview's own ceiling", async () => {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const strategy = memory({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 0, imageCeiling: 10, imageStripHysteresisRatio: 0.5,
    });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
    try {
      for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      // A preview with a ceiling of 2 strips by the rule, for itself only: its
      // trim to half keeps one image when the third comes, and the fourth fits.
      const entries = manager.previewContext({ maxTokens: 1_000_000, reserveForResponse: 0 }, { imageCeiling: 2 }, { render: true })?.entries ?? [];
      assert.equal(pattern(entries, 4), '..II', "the preview's own set trims to half its ceiling");
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
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
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

  it("the memory strategy credits the rule's set from the stored messages alone, so a reopened instance says it at its first compile", async () => {
    // The rule keeps no state: a second instance on the same store replays
    // the same set, which the ceiling decided, so it says the line at the
    // first compile it returns, as the first instance did.
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const options = { maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 };
    const ours = () => said.filter((line) => line.includes(CEILING_LINE));
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
        assert.equal(pattern((await second.compile(budget)).messages, 5), '...II', 'the same set from the same messages');
        assert.equal(ours().length, 1, JSON.stringify(said));
        assert.ok(ours()[0]!.includes('imageCeiling 4 holds'), ours()[0]);
      } finally {
        await second.close();
      }
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [kind, options, named] of [
    ['count', { maxLiveImages: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 }, 'imageCeiling 4 holds'],
    ['byte', { maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 16, imageStripHysteresisRatio: 0.5 }, 'imageByteCeiling 16 bytes holds'],
  ] as const) {
    it(`the memory strategy credits the rule's set from the branch it compiles, under the ${kind} ceiling`, async () => {
      const said: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: memory(options) });
      const ours = () => said.filter((line) => line.includes(CEILING_LINE));
      const budget = { maxTokens: 1_000_000, reserveForResponse: 0 };
      try {
        manager.addMessage('user', imageMessage('img-1'));
        const main = manager.currentBranch().name;
        const busy = await manager.fork('busy');
        // On the fork, four more images make five, past a count of 4 and past
        // 16 bytes.
        for (let i = 2; i <= 5; i++) manager.addMessage('user', imageMessage(`img-${i}`));
        await manager.switchBranch(main);
        assert.equal(pattern((await manager.compile(budget)).messages, 1), 'I', 'main holds one image, under its ceiling');
        assert.deepEqual(ours(), [], "main's compile says nothing for the fork's messages");
        await manager.switchBranch(busy);
        assert.equal(pattern((await manager.compile(budget)).messages, 5), '...II', "the fork's set, from its own messages");
        assert.equal(ours().length, 1, JSON.stringify(said));
        assert.ok(ours()[0]!.includes(named), ours()[0]);
      } finally {
        console.warn = original;
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("the memory strategy's rule says nothing when the host's own limit binds", async () => {
    const { lines, last } = await ceilingLines(memory({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }), [5]);
    assert.equal(last, '...II', 'one trim to half the host limit');
    assert.deepEqual(lines, []);
  });

  it("the memory strategy's rule says nothing when the depth limit strips what the ceiling also would", async () => {
    // Three 8-byte images under a 20-byte ceiling: the oldest is past the
    // ceiling (24 bytes) and, two image messages deep, past the depth limit
    // too, so the set strips it with or without the ceiling.
    const depth = { maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 2500, imageStripHysteresisRatio: 0.5 };
    const alone = await ceilingLines(memory({ ...depth, imageByteCeiling: 0 }), [{ add: 3, bytes: 8 }]);
    const both = await ceilingLines(memory({ ...depth, imageByteCeiling: 20 }), [{ add: 3, bytes: 8 }]);
    assert.equal(alone.last, '..I', 'the depth limit alone strips the two older images');
    assert.equal(both.last, alone.last, 'the ceiling changes nothing the window keeps');
    assert.deepEqual(both.lines, [], JSON.stringify(both.lines));
  });

  it("the memory strategy's rule says it when only the ceiling strips, and nothing when the depth limit strips the same anyway", async () => {
    // Image messages price at about 1,600 tokens, so three of them are within
    // a 6,000-token depth limit: without a ceiling nothing binds and nothing
    // is stripped. A count ceiling of 2 binds at the third, and its trim to
    // half strips the two older images, which the depth limit alone keeps:
    // the ceiling decided.
    const options = { maxLiveImages: 0, imageStripDepthTokens: 6000, imageStripHysteresisRatio: 0.5 };
    const alone = await ceilingLines(memory({ ...options, imageCeiling: 0 }), [3]);
    assert.equal(alone.last, 'III', 'the depth limit alone strips nothing');
    const ceiling = await ceilingLines(memory({ ...options, imageCeiling: 2 }), [3]);
    assert.equal(ceiling.last, '..I', 'the ceiling strips what the depth limit alone keeps');
    assert.equal(ceiling.lines.length, 1, JSON.stringify(ceiling.lines));
    assert.ok(ceiling.lines[0]!.includes('imageCeiling 2 holds'), ceiling.lines[0]);
    // Under a 3,000-token depth limit, the first image is past the depth once
    // the second comes, before the count ceiling is passed, and the depth's
    // trims strip the same images with or without the ceiling.
    const deeper = { maxLiveImages: 0, imageStripDepthTokens: 3000, imageStripHysteresisRatio: 0.5 };
    const deepAlone = await ceilingLines(memory({ ...deeper, imageCeiling: 0 }), [3]);
    assert.equal(deepAlone.last, '..I', 'the depth limit alone strips the two older images');
    const deepCeiling = await ceilingLines(memory({ ...deeper, imageCeiling: 2 }), [3]);
    assert.equal(deepCeiling.last, deepAlone.last, 'the ceiling changes nothing the window keeps');
    assert.deepEqual(deepCeiling.lines, [], JSON.stringify(deepCeiling.lines));
  });

  /** Compile, after adding each message in turn, with a strategy built from
   *  `options`; the window kept and the ceiling lines said. */
  async function ruleRun(options: Record<string, unknown>, messages: unknown[][]) {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: memory(options) });
    try {
      for (const content of messages) manager.addMessage('user', content as never);
      const images = messages.filter((content) => content.some((b) => (b as { type?: string }).type === 'image')).length;
      const kept = pattern((await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages, images);
      return { kept, lines: said.filter((line) => line.includes(CEILING_LINE)) };
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("the memory strategy's rule says nothing for an image the ceiling strips first that the depth limit strips later anyway", async () => {
    // A 16-byte image, an 8-byte image, then about 1,500 tokens of text. When
    // the second image comes, the first passes a 20-byte ceiling (24 bytes)
    // while it's within a 4,000-token depth limit (about 3,200 tokens deep),
    // so the set strips it then. The text takes it past the depth (about
    // 4,700), and the set without the ceiling strips it there: the render is
    // the same, so the ceiling decided nothing in it.
    const text = [{ type: 'text', text: 'word '.repeat(870) }];
    const options = { maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 4000, imageStripHysteresisRatio: 0.9 };
    const messages = [imageMessage('img-1', 16), imageMessage('img-2', 8), text];
    const alone = await ruleRun({ ...options, imageByteCeiling: 0 }, messages);
    assert.equal(alone.kept, '.I', 'the depth limit alone strips the first image');
    const ceiling = await ruleRun({ ...options, imageByteCeiling: 20 }, messages);
    assert.equal(ceiling.kept, '.I', 'the render is the same');
    assert.deepEqual(ceiling.lines, []);
  });

  it("the memory strategy's rule names the count ceiling when the host's own byte limit binds and the ceiling's target strips more", async () => {
    // A host byte limit of 40, in force, and a count ceiling of 4. When three
    // 4-byte images come after a 32-byte one, the host's byte limit binds (44
    // bytes), and the trim goes to half of each limit: 20 bytes, and 2 images
    // under the count ceiling. Without the ceiling the trim to 20 bytes strips
    // only the 32-byte image; the count ceiling's target strips the next one
    // too, so the ceiling decided that one, though no image passed it.
    const options = { maxLiveImages: 0, maxLiveImageBytes: 40, imageStripHysteresisRatio: 0.5 };
    const steps = [{ add: 1, bytes: 32 }, { add: 3, bytes: 4 }];
    const alone = await ceilingLines(memory({ ...options, imageCeiling: 0 }), steps);
    assert.deepEqual(alone.patterns, ['I', '.III'], "the host's byte limit alone strips the 32-byte image");
    const { lines, patterns } = await ceilingLines(memory({ ...options, imageCeiling: 4 }), steps);
    assert.deepEqual(patterns, ['I', '..II'], 'the count trim strips the second-oldest image too');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('imageCeiling 4 holds'), lines[0]);
  });

  it("the memory strategy's rule names the count ceiling it decided by, not a byte ceiling that strips nothing alone", async () => {
    // Both window limits are set by their ceilings. The fifth 4-byte image
    // passes the count ceiling of 4, and 20 bytes are far under the byte
    // ceiling, so the set without the ceilings keeps every image, the set
    // under the count ceiling alone strips three, and the set under the byte
    // ceiling alone strips none.
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 4, imageStripHysteresisRatio: 0.5 }),
      [5],
    );
    assert.equal(last, '...II');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('imageCeiling 4 holds'), lines[0]);
  });

  it("the memory strategy's rule names each ceiling whose set alone strips an image the set without them keeps", async () => {
    // Both window limits are set by their ceilings: 4 images and 16 bytes.
    // Five 4-byte images pass both (5 images, 20 bytes) at the fifth, so the
    // set under either ceiling alone strips the three oldest, and the set
    // without the ceilings keeps them all: each ceiling decided them.
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 4, imageByteCeiling: 16, imageStripHysteresisRatio: 0.5 }),
      [5],
    );
    assert.equal(last, '...II');
    assert.equal(lines.length, 2, JSON.stringify(lines));
    assert.ok(lines.some((line) => line.includes('imageCeiling 4 holds')), JSON.stringify(lines));
    assert.ok(lines.some((line) => line.includes('imageByteCeiling 16 bytes holds')), JSON.stringify(lines));
  });

  it("the memory strategy's rule says nothing for images the ceiling strips that the host's own limit strips without it", async () => {
    // A count ceiling of 4 and a host byte limit of 40, in force. The fifth
    // image passes the count ceiling, and a 44-byte image then passes the
    // host's byte limit on its own: the host's limit strips every image now,
    // those the ceiling stripped too, so the render is the same with or
    // without the ceiling.
    const messages = [imageMessage('img-1', 20), ...[2, 3, 4, 5].map((i) => imageMessage(`img-${i}`)), imageMessage('img-6', 44)];
    const options = { maxLiveImages: 0, maxLiveImageBytes: 40, imageStripHysteresisRatio: 0.5 };
    const alone = await ruleRun({ ...options, imageCeiling: 0 }, messages);
    const ceiling = await ruleRun({ ...options, imageCeiling: 4 }, messages);
    assert.equal(ceiling.kept, '......');
    assert.equal(ceiling.kept, alone.kept, 'the render is the same without the ceiling');
    assert.deepEqual(ceiling.lines, []);
  });

  it("the memory strategy's rule names the count ceiling for images its trim strips that the host's own limit keeps", async () => {
    // A count ceiling of 4 and a host byte limit of 40, in force. When the
    // fifth image comes (8 bytes, after a 24-byte one and three 4-byte ones),
    // it passes both: the count ceiling and 44 bytes. The host's limit alone
    // trims to 20 bytes, stripping the oldest; the count ceiling's trim, to
    // 2, strips the two after it too, which the host's limit keeps.
    const messages = [imageMessage('img-1', 24), ...[2, 3, 4].map((i) => imageMessage(`img-${i}`)), imageMessage('img-5', 8)];
    const options = { maxLiveImages: 0, maxLiveImageBytes: 40, imageStripHysteresisRatio: 0.5 };
    const alone = await ruleRun({ ...options, imageCeiling: 0 }, messages);
    assert.equal(alone.kept, '.IIII', "the host's limit alone strips the oldest");
    const ceiling = await ruleRun({ ...options, imageCeiling: 4 }, messages);
    assert.equal(ceiling.kept, '...II');
    assert.equal(ceiling.lines.length, 1, JSON.stringify(ceiling.lines));
    assert.ok(ceiling.lines[0]!.includes('imageCeiling 4 holds'), ceiling.lines[0]);
  });

  it("the memory strategy's rule names the byte ceiling for an image its trim strips that the host's own limit keeps", async () => {
    // The mirror, with a byte ceiling of 20 and a host count limit of 4, in
    // force. When the fifth image comes (8 bytes, after three 4-byte ones and
    // an 8-byte one), it passes the host's count and the byte ceiling (28
    // bytes). The host's count alone trims to 2, stripping the three oldest;
    // the byte ceiling's trim, to 10 bytes, strips the 8-byte fourth image
    // too, which the host's count keeps.
    const messages = [...[1, 2, 3].map((i) => imageMessage(`img-${i}`)), imageMessage('img-4', 8), imageMessage('img-5', 8)];
    const options = { maxLiveImages: 4, maxLiveImageBytes: 0, imageStripHysteresisRatio: 0.5 };
    const alone = await ruleRun({ ...options, imageByteCeiling: 0 }, messages);
    assert.equal(alone.kept, '...II', "the host's count alone strips the three oldest");
    const ceiling = await ruleRun({ ...options, imageByteCeiling: 20 }, messages);
    assert.equal(ceiling.kept, '....I');
    assert.equal(ceiling.lines.length, 1, JSON.stringify(ceiling.lines));
    assert.ok(ceiling.lines[0]!.includes('imageByteCeiling 20 bytes holds'), ceiling.lines[0]);
  });

  it("the memory strategy's rule credits by each image's place in its message", async () => {
    // A count ceiling of 3 and a host byte limit of 16, in force. An 8-byte
    // image, a message of two 4-byte images, and a 4-byte image: the last
    // passes both (4 images, 20 bytes). The host's limit alone trims to 8
    // bytes, stripping the oldest and the first image of the pair; the count
    // ceiling's trim, to 1, strips the pair's second image too. So the
    // ceiling decided that one image, the second of its message.
    const pair = [
      { type: 'image', source: { type: 'base64', data: 'A'.repeat(4), mediaType: 'image/png' }, tokenEstimate: 100 },
      { type: 'image', source: { type: 'base64', data: 'B'.repeat(4), mediaType: 'image/png' }, tokenEstimate: 100 },
      { type: 'text', text: 'pair' },
    ] as ContentBlock[];
    const messages = [imageMessage('img-1', 8), pair, imageMessage('img-3', 4)];
    const kept = async (options: Record<string, unknown>) => {
      const said: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: memory(options) });
      try {
        for (const content of messages) manager.addMessage('user', content);
        const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
        const of = (label: string) => compiled.messages.find((m) => m.content.some((b) => b.type === 'text' && b.text === label));
        const marks = (label: string) => of(label)!.content.filter((b) => b.type === 'image' || (b.type === 'text' && b.text === PLACEHOLDER))
          .map((b) => b.type === 'image' ? 'I' : '.').join('');
        return { kept: [marks('img-1'), marks('pair'), marks('img-3')].join(' '), lines: said.filter((line) => line.includes(CEILING_LINE)) };
      } finally {
        console.warn = original;
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const options = { maxLiveImages: 0, maxLiveImageBytes: 16, imageStripHysteresisRatio: 0.5 };
    const alone = await kept({ ...options, imageCeiling: 0 });
    assert.equal(alone.kept, '. .I I', "the host's limit alone strips the oldest and the pair's first image");
    const ceiling = await kept({ ...options, imageCeiling: 3 });
    assert.equal(ceiling.kept, '. .. I', "the count ceiling's trim strips the pair's second image too");
    assert.equal(ceiling.lines.length, 1, JSON.stringify(ceiling.lines));
    assert.ok(ceiling.lines[0]!.includes('imageCeiling 3 holds'), ceiling.lines[0]);
  });

  it("the memory strategy's rule says nothing for images the ceiling's trim strips that the host's own limit strips too, later", async () => {
    // A count ceiling of 4 and a host byte limit of 40, in force. The fifth
    // image passes both, and the set strips the three oldest. Without the
    // ceiling the host's byte limit strips those three as well, once the
    // 24-byte image comes, so the ceiling decided none of them.
    const messages = [...[1, 2, 3].map((i) => imageMessage(`img-${i}`, 12)), imageMessage('img-4'), imageMessage('img-5'), imageMessage('img-6', 24)];
    const ceiling = await ruleRun({ maxLiveImages: 0, imageCeiling: 4, maxLiveImageBytes: 40, imageStripHysteresisRatio: 0.5 }, messages);
    assert.equal(ceiling.kept, '...III');
    assert.deepEqual(ceiling.lines, []);
  });

  it("the memory strategy's rule says nothing for an image the byte ceiling strips that the host's own count limit strips too, later", async () => {
    // A byte ceiling of 20 and a host count limit of 4, in force. A 16-byte
    // image and two 4-byte ones: the third passes the byte ceiling (24 bytes),
    // and the set strips the 16-byte image. Without the ceiling the host's
    // count strips it as well, with two more, when the fifth image comes.
    const messages = [imageMessage('img-1', 16), ...[2, 3, 4, 5].map((i) => imageMessage(`img-${i}`))];
    const ceiling = await ruleRun({ maxLiveImages: 4, maxLiveImageBytes: 0, imageByteCeiling: 20, imageStripHysteresisRatio: 0.5 }, messages);
    assert.equal(ceiling.kept, '.IIII');
    assert.deepEqual(ceiling.lines, []);
  });

  for (const [kind, options, why] of [
    ['byte', { maxLiveImages: 0, imageCeiling: 4, maxLiveImageBytes: 16 }, 'the host byte limit of 16 strips what the count ceiling of 4 does'],
    ['count', { maxLiveImages: 4, maxLiveImageBytes: 0, imageByteCeiling: 16 }, 'the host count limit of 4 strips what the byte ceiling of 16 does'],
  ] as const) {
    it(`the memory strategy's rule says nothing when the host's own ${kind} limit strips what a ceiling does`, async () => {
      // The fifth 4-byte image passes both the host's limit and the ceiling,
      // and both trims, to 2 images and to 8 bytes, strip the three oldest:
      // ${why}.
      const { lines, last } = await ceilingLines(memory({ ...options, imageStripHysteresisRatio: 0.5 }), [5]);
      assert.equal(last, '...II');
      assert.deepEqual(lines, [], why);
    });
  }

  it("the memory strategy's rule credits the ceiling whose trim it is, where the trim stops at the depth", async () => {
    // A count ceiling of 4 and a 20,000-token depth limit. The fifth image's
    // message passes the ceiling, with nothing past the depth. About 9,000
    // tokens of text before the newest image put the second-newest past half
    // the depth, so the trim strips it by the depth, not the count. Without
    // the ceiling nothing binds, so the ceiling decided all four.
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
      assert.equal(kept, '....I', 'the trim strips the second-newest image too');
      const ours = said.filter((line) => line.includes(CEILING_LINE));
      assert.equal(ours.length, 1, JSON.stringify(said));
      assert.ok(ours[0]!.includes('imageCeiling 4 holds'), ours[0]);
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the memory strategy's rule names only a ceiling whose limit took part in its set", async () => {
    // Both window limits are set by their ceilings: 2 images and 40 bytes.
    // Eleven 4-byte images: the count ceiling binds at every third, and its
    // trims keep the live bytes under half the byte ceiling, so the byte
    // ceiling takes no part. Under the byte ceiling alone, with no count, the
    // eleventh image would bring a byte trim that strips the oldest ones too,
    // but that isn't why they're stripped here.
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 2, imageByteCeiling: 40, imageStripHysteresisRatio: 0.5 }),
      [11],
    );
    assert.equal(last.slice(0, 6), '......', 'the count ceiling strips the oldest images');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('imageCeiling 2 holds'), lines[0]);
  });

  it("the memory strategy replays the rule for the credit only for a ceiling whose limit took part and is still to be said", async () => {
    // The credit replays the rule with the ceilings' limits lifted. Once each
    // line is said, a later compile replays nothing for it; nor does a host
    // whose limits no ceiling sets, or one whose ceiling's limit takes no part
    // in the set, as under a depth limit that strips first.
    const budget = { maxTokens: 1_000_000, reserveForResponse: 0 };
    for (const [options, first] of [
      [{ maxLiveImages: 0, imageCeiling: 4 }, 1],
      [{ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 4, imageByteCeiling: 16 }, 3],
      [{ maxLiveImages: 4 }, 0],
      [{ maxLiveImages: 0, imageStripDepthTokens: 3000 }, 0],
    ] as const) {
      const original = console.warn;
      console.warn = () => {};
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const strategy = memory({ ...options, imageStripHysteresisRatio: 0.5 });
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
      const s = strategy as unknown as {
        stripReplayHeld: (...args: unknown[]) => unknown;
        ruleCeilingHits: (...args: unknown[]) => unknown;
      };
      let crediting = false;
      let replays = 0;
      const held = s.stripReplayHeld.bind(strategy);
      s.stripReplayHeld = (...args: unknown[]) => { if (crediting) replays++; return held(...args); };
      const credit = s.ruleCeilingHits.bind(strategy);
      s.ruleCeilingHits = (...args: unknown[]) => {
        crediting = true;
        try { return credit(...args); } finally { crediting = false; }
      };
      try {
        for (let i = 1; i <= 5; i++) manager.addMessage('user', imageMessage(`img-${i}`));
        const kept = pattern((await manager.compile(budget)).messages, 5);
        assert.ok(kept.includes('.'), `the rule strips for ${JSON.stringify(options)}: ${kept}`);
        assert.equal(replays, first, `the first compile's credit, for ${JSON.stringify(options)}`);
        replays = 0;
        for (let i = 6; i <= 8; i++) manager.addMessage('user', imageMessage(`img-${i}`));
        await manager.compile(budget);
        assert.equal(replays, 0, `nothing at the next compile, for ${JSON.stringify(options)}`);
      } finally {
        console.warn = original;
        await manager.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('marks only defaults in force: an explicit undefined maxLiveImages is no limit in the memory strategy, and 6 in windowed passthrough', async () => {
    const auto = await ceilingLines(memory({ maxLiveImages: undefined, imageCeiling: 2 }), [3]);
    assert.equal(auto.lines.length, 1, JSON.stringify(auto.lines));
    assert.ok(auto.lines[0]!.includes('imageCeiling 2 holds maxLiveImages 0 (no limit) to it,'), auto.lines[0]);
    const win = await ceilingLines(windowed({ maxLiveImages: undefined, imageCeiling: 2 }), [3]);
    assert.equal(win.lines.length, 1, JSON.stringify(win.lines));
    assert.ok(win.lines[0]!.includes('imageCeiling 2 holds maxLiveImages 6 (default) to it,'), win.lines[0]);
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
    assert.ok(lines[0]!.includes('imageCeiling 2 holds'), lines[0]);
  });

  it('ceilingBoundLine marks a default or malformed ceiling, and gives bytes in MiB', () => {
    const configured = (o: Record<string, number>) =>
      ({ maxLiveImages: 0, maxLiveImageBytes: 0, imageCeiling: 500, imageByteCeiling: 24 * MiB, ...o });
    assert.equal(ceilingBoundLine('s', 'images', configured({}), new Set(['imageCeiling'])),
      '[s] imageCeiling 500 (default) holds maxLiveImages 0 (no limit) to it, so some images are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'images', configured({ imageCeiling: Number.NaN, maxLiveImages: 800 }), new Set()),
      '[s] imageCeiling 500 (default) holds maxLiveImages 800 to it, so some images are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'bytes', configured({ maxLiveImageBytes: 30 * MiB }), new Set()),
      '[s] imageByteCeiling 24 MiB holds maxLiveImageBytes 30 MiB to it, so some images are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'bytes', configured({ maxLiveImageBytes: 30 * MiB + 1 }), new Set(['imageByteCeiling'])),
      `[s] imageByteCeiling 24 MiB (default) holds maxLiveImageBytes ${30 * MiB + 1} bytes to it, so some images are now shown as placeholders`);
  });

  it('the memory strategy says it when its hysteresis rule trims against the byte ceiling', async () => {
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, maxLiveImageBytes: 0, imageByteCeiling: 16, imageStripHysteresisRatio: 0.5 }),
      [5],
    );
    assert.equal(last, '...II', 'one trim to half the ceiling');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('imageByteCeiling 16 bytes holds maxLiveImageBytes 0 (no limit) to it'), lines[0]);
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
