/**
 * The request ceilings (maxRequestImages, maxRequestImageBytes): the most
 * images, and image bytes, one request may carry. The live window keeps its
 * own limits within them, compression prompts carry no more than them, and
 * liveImageLimits() reports both, for a caller that appends to a compiled
 * request without recompiling.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, WindowedPassthroughStrategy } from '../src/index.js';
import type { ContextStrategy } from '../src/index.js';
import { ceilingBoundLine } from '../src/live-image-limits.js';

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

describe('liveImageLimits()', () => {
  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: the defaults are a window of 6 images and 20 MiB under ceilings of 500 images and 24 MiB`, () => {
      assert.deepEqual(DEFAULTS[name as keyof typeof DEFAULTS]().liveImageLimits(), {
        target: { images: 6, bytes: 20 * MiB },
        ceiling: { images: 500, bytes: 24 * MiB },
      });
    });

    it(`${name}: the window is kept within the ceilings, and a ceiling of 0 is none`, () => {
      const limits = (options: Record<string, unknown>) => make(options).liveImageLimits();
      assert.deepEqual(limits({ maxLiveImages: 0, maxLiveImageBytes: 0 }), {
        target: { images: 500, bytes: 24 * MiB }, ceiling: { images: 500, bytes: 24 * MiB },
      }, 'an unlimited window means up to the ceilings');
      assert.deepEqual(limits({ maxLiveImages: 800, maxLiveImageBytes: 30 * MiB }).target,
        { images: 500, bytes: 24 * MiB }, 'a window above the ceilings keeps the ceilings');
      assert.deepEqual(limits({ maxLiveImages: 4, maxLiveImageBytes: MiB, maxRequestImages: 10, maxRequestImageBytes: 2 * MiB }), {
        target: { images: 4, bytes: MiB }, ceiling: { images: 10, bytes: 2 * MiB },
      }, 'a window under configured ceilings keeps its own limits');
      assert.deepEqual(limits({ maxLiveImages: 0, maxLiveImageBytes: 0, maxRequestImages: 0, maxRequestImageBytes: 0 }), {
        target: { images: 0, bytes: 0 }, ceiling: { images: 0, bytes: 0 },
      }, 'no ceiling leaves an unlimited window unlimited');
      assert.equal(limits({ maxLiveImages: 4, maxRequestImages: 0 }).target.images, 4, 'no ceiling leaves a window as set');
    });

    it(`${name}: a window limit that isn't a positive finite number is none, and a malformed ceiling takes its default`, () => {
      const limits = (options: Record<string, unknown>) => make(options).liveImageLimits();
      for (const bad of [-3, Number.NaN, Infinity]) {
        assert.equal(limits({ maxLiveImages: bad }).target.images, 500, `maxLiveImages ${bad} is unlimited, so up to the ceiling`);
        assert.equal(limits({ maxLiveImageBytes: bad }).target.bytes, 24 * MiB, `maxLiveImageBytes ${bad} is unlimited, so up to the ceiling`);
        assert.equal(limits({ maxRequestImages: bad }).ceiling.images, 500, `maxRequestImages ${bad} takes the default`);
        assert.equal(limits({ maxRequestImageBytes: bad }).ceiling.bytes, 24 * MiB, `maxRequestImageBytes ${bad} takes the default`);
      }
      assert.equal(limits({ maxLiveImages: 0, maxRequestImages: -1 }).target.images, 500, 'the window is clamped to the default the malformed ceiling took');
      assert.equal(limits({ maxLiveImages: Infinity, maxRequestImages: 0 }).target.images, 0,
        'an infinite limit with no ceiling is reported as none, 0');
    });

    it(`${name}: a fractional limit or ceiling is floored, to at least 1`, () => {
      const limits = (options: Record<string, unknown>) => make(options).liveImageLimits();
      assert.equal(limits({ maxLiveImages: 2.5 }).target.images, 2);
      assert.deepEqual(limits({ maxLiveImages: 0, maxRequestImages: 1.5 }), {
        target: { images: 1, bytes: 20 * MiB }, ceiling: { images: 1, bytes: 24 * MiB },
      });
      assert.equal(limits({ maxRequestImages: 0.5 }).ceiling.images, 1, 'a fraction under 1 is 1, not none');
      assert.equal(limits({ maxRequestImageBytes: 100.7 }).ceiling.bytes, 100);
    });
  }
});

describe('the live window within the request ceilings', () => {
  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: an unlimited count keeps the newest maxRequestImages`, async () => {
      assert.equal(await compiled(make({ maxLiveImages: 0, maxRequestImages: 2 }), 4), '..II');
    });
    it(`${name}: a count above the ceiling keeps the ceiling's worth`, async () => {
      assert.equal(await compiled(make({ maxLiveImages: 3, maxRequestImages: 2 }), 4), '..II');
    });
    it(`${name}: an unlimited byte budget keeps the newest maxRequestImageBytes`, async () => {
      assert.equal(await compiled(make({ maxLiveImages: 0, maxLiveImageBytes: 0, maxRequestImageBytes: 2000 }), 4, 1000), '..II');
    });
    it(`${name}: with no window and no ceilings, every image stays, more than the default window's 6`, async () => {
      assert.equal(await compiled(make({
        maxLiveImages: 0, maxLiveImageBytes: 0, maxRequestImages: 0, maxRequestImageBytes: 0,
      }), 8), 'IIIIIIII');
    });
    it(`${name}: the window counts top-level image blocks only, so a nested or a generated image passes the count ceiling`, async () => {
      // What the ceilings bind is what the window counts. An image nested in
      // a tool result, or a generated image, isn't one of those (a change
      // that counts them would change this).
      const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
      const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: make({ maxLiveImages: 0, maxRequestImages: 1 }) });
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
    assert.deepEqual(estimate(memory({ maxLiveImages: 0, maxRequestImages: 1 })), stripped, 'by the count ceiling');
    assert.deepEqual(estimate(memory({ maxLiveImages: 0, maxLiveImageBytes: 0, maxRequestImageBytes: 5 })), stripped,
      'by the byte ceiling: 4 bytes fit, 8 do not');
    // The memo is keyed by the clamped limits, so a changed ceiling prices anew.
    const strategy = memory({ maxLiveImages: 0, maxRequestImages: 1 });
    assert.deepEqual(estimate(strategy), stripped);
    (strategy as unknown as { config: { maxRequestImages: number } }).config.maxRequestImages = 2;
    assert.deepEqual(estimate(strategy), [1600, 1600], 'with a ceiling of 2, both are live');
  });

  it('the hysteresis watermark trims against the ceiling when the count is unlimited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      strategy: memory({ maxLiveImages: 0, maxRequestImages: 4, imageStripHysteresisRatio: 0.5 }),
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
      strategy: memory({ maxLiveImages: 0, maxLiveImageBytes: 0, maxRequestImageBytes: 16, imageStripHysteresisRatio: 0.5 }),
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
          [{ maxLiveImages: 8, maxRequestImages: 4 }, ['maxLiveImages 8 is above maxRequestImages 4, so the live window keeps at most 4']],
          [{ maxLiveImageBytes: 3 * MiB, maxRequestImageBytes: 2 * MiB },
            ['maxLiveImageBytes 3 MiB is above maxRequestImageBytes 2 MiB, so the live window keeps at most 2 MiB']],
          [{ maxLiveImages: 8, maxRequestImages: 4, maxLiveImageBytes: 3 * MiB, maxRequestImageBytes: 2 * MiB },
            ['maxLiveImages 8 is above maxRequestImages 4', 'maxLiveImageBytes 3 MiB is above maxRequestImageBytes 2 MiB']],
          // A byte figure that isn't a whole number of MiB reads in bytes.
          [{ maxLiveImageBytes: 3 * MiB + 1, maxRequestImageBytes: 2 * MiB }, [`maxLiveImageBytes ${3 * MiB + 1} bytes is above maxRequestImageBytes 2 MiB`]],
          [{ maxRequestImages: Number.NaN }, ["maxRequestImages NaN isn't 0 or a finite number above it, so the default 500 applies"]],
          [{ maxRequestImageBytes: -1 }, ["maxRequestImageBytes -1 isn't 0 or a finite number above it, so the default 24 MiB applies"]],
          [{ maxLiveImages: 0, maxLiveImageBytes: 0 }, null],
          [{ maxLiveImages: 4, maxRequestImages: 4 }, null],
          // At or above the memory strategy's 12 MiB compression budget, so
          // that budget isn't above the ceiling either.
          [{ maxLiveImageBytes: 16 * MiB, maxRequestImageBytes: 16 * MiB }, null],
          // A default above a lowered ceiling is named too, marked as the
          // default, and so is a default ceiling under a limit the host set.
          [{ maxRequestImageBytes: 2 * MiB }, ['maxLiveImageBytes 20 MiB (default) is above maxRequestImageBytes 2 MiB, so the live window keeps at most 2 MiB']],
          [{ maxLiveImages: 600 }, ['maxLiveImages 600 is above maxRequestImages 500 (default), so the live window keeps at most 500']],
          // The default window of 6 comes from the strategy's default config,
          // not from the host, so it's marked too.
          [{ maxRequestImages: 4 }, ['maxLiveImages 6 (default) is above maxRequestImages 4, so the live window keeps at most 4']],
          // An infinite limit is none, like 0, so nothing is said.
          [{ maxLiveImages: Infinity }, null],
          // A malformed ceiling takes its default, which the later clause marks.
          [{ maxLiveImages: 600, maxRequestImages: Number.NaN },
            ["maxRequestImages NaN isn't 0 or a finite number above it, so the default 500 applies",
              'maxLiveImages 600 is above maxRequestImages 500 (default)']],
          // A byte budget given as null takes its default, and is marked so.
          [{ maxLiveImageBytes: null, maxRequestImageBytes: 2 * MiB }, ['maxLiveImageBytes 20 MiB (default) is above maxRequestImageBytes 2 MiB']],
          [{ maxLiveImageBytes: undefined, maxRequestImageBytes: 2 * MiB }, ['maxLiveImageBytes 20 MiB (default) is above maxRequestImageBytes 2 MiB']],
          [{ maxLiveImageBytes: 30 * MiB, maxRequestImageBytes: -1 },
            ["maxRequestImageBytes -1 isn't 0 or a finite number above it, so the default 24 MiB applies",
              'maxLiveImageBytes 30 MiB is above maxRequestImageBytes 24 MiB (default)']],
          [{ maxLiveImages: 8, maxRequestImages: 0 }, null],
          [{ maxLiveImageBytes: 30 * MiB, maxRequestImageBytes: 0 }, null],
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
      assert.ok(ours[0]!.includes('maxCompressionImageBytes 30 MiB is above maxRequestImageBytes 24 MiB (default), so a compression prompt keeps at most 24 MiB'), ours[0]);
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
        path: join(dir, 'store'), strategy: memory({ maxLiveImageBytes: 1 * MiB, maxRequestImageBytes: 2 * MiB }),
      });
      await manager.close();
      const ours = lines.filter((line) => line.includes('is above'));
      assert.equal(ours.length, 1, JSON.stringify(lines));
      assert.ok(ours[0]!.includes('maxCompressionImageBytes 12 MiB (default) is above maxRequestImageBytes 2 MiB, so a compression prompt keeps at most 2 MiB'), ours[0]);
      assert.ok(!ours[0]!.includes('maxLiveImageBytes'), ours[0]);
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the line when an image first falls past a request ceiling', () => {
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
        byStep.push(said.slice(before).filter((line) => line.includes('an image fell past')));
      }
      return { lines: byStep.flat(), byStep, patterns, last: patterns[patterns.length - 1] ?? '' };
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const [name, make] of Object.entries(STRATEGIES)) {
    it(`${name}: says once which ceiling an image fell past, and what it held`, async () => {
      const cases = [
        [{ maxLiveImages: 0, maxRequestImages: 2 }, 'maxRequestImages 2, which holds maxLiveImages 0 (no limit) to it'],
        [{ maxLiveImages: 5, maxRequestImages: 2 }, 'maxRequestImages 2, which holds maxLiveImages 5 to it'],
        [{ maxRequestImages: 2 }, 'maxRequestImages 2, which holds maxLiveImages 6 (default) to it'],
        [{ maxLiveImages: 0, maxLiveImageBytes: 0, maxRequestImageBytes: 8 },
          'maxRequestImageBytes 8 bytes, which holds maxLiveImageBytes 0 (no limit) to it'],
      ] as const;
      for (const [options, said] of cases) {
        // Three images, then two more: the ceiling strips at the first compile
        // and again at the second, and it's said once, at the first.
        const strategy = make(options);
        const { lines, byStep, patterns } = await ceilingLines(strategy, [3, 2]);
        assert.deepEqual(patterns, ['.II', '...II'], `the ceiling of 2 strips at each compile for ${JSON.stringify(options)}`);
        assert.deepEqual(byStep.map((step) => step.length), [1, 0], `said once, at the first step, for ${JSON.stringify(options)}`);
        assert.ok(lines[0]!.startsWith(`[${strategy.name}] an image fell past ${said}, so images past it are now shown as placeholders`), lines[0]);
        assert.match(lines[0]!, / ns=/, 'through the namespaced route the warning takes');
      }
    });

    it(`${name}: says nothing when the host's own limit strips, or nothing falls past the ceiling`, async () => {
      for (const [options, steps, kept] of [
        [{ maxLiveImages: 2 }, [3, 2], '...II'],
        [{ maxLiveImages: 2, maxRequestImages: 2 }, [3, 2], '...II'],
        [{ maxLiveImages: 0, maxRequestImages: 2 }, [1, 1], 'II'],
        // The host's own byte limit strips, under the default byte ceiling.
        [{ maxLiveImageBytes: 8 }, [3, 2], '...II'],
        [{ maxLiveImageBytes: 8, maxRequestImageBytes: 8 }, [3, 2], '...II'],
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
      const strategy = make({ maxLiveImages: 0, maxLiveImageBytes: 0, maxRequestImages: 3, maxRequestImageBytes: 16 });
      const { byStep, patterns } = await ceilingLines(strategy, [{ add: 4, bytes: 4 }, { add: 1, bytes: 16 }, { add: 1, bytes: 4 }]);
      // At the third step the byte walk drops the 16-byte image and, being
      // greedy, keeps two older 4-byte ones that still fit (as on main).
      assert.deepEqual(patterns, ['.III', '....I', '..II.I'], 'the count, then the bytes, strip');
      assert.deepEqual(byStep.map((step) => step.length), [1, 1, 0], JSON.stringify(byStep));
      assert.ok(byStep[0]![0]!.includes('an image fell past maxRequestImages 3'), byStep[0]![0]);
      assert.ok(byStep[1]![0]!.includes('an image fell past maxRequestImageBytes 16 bytes'), byStep[1]![0]);
    });

    it(`${name}: says it for a single image bigger than the byte ceiling`, async () => {
      const { byStep, patterns } = await ceilingLines(make({ maxLiveImageBytes: 0, maxRequestImageBytes: 8 }), [{ add: 1, bytes: 12 }]);
      assert.deepEqual(patterns, ['.'], 'the one image is past the ceiling on its own');
      assert.equal(byStep[0]!.length, 1, JSON.stringify(byStep));
      assert.ok(byStep[0]![0]!.includes('an image fell past maxRequestImageBytes 8 bytes, which holds maxLiveImageBytes 0 (no limit) to it'), byStep[0]![0]);
    });

    it(`${name}: says nothing from a dry compile, and leaves the line for the first compile that's sent`, async () => {
      for (const [options, said0] of [
        [{ maxLiveImages: 0, maxRequestImages: 2 }, 'an image fell past maxRequestImages 2'],
        [{ maxLiveImageBytes: 0, maxRequestImageBytes: 8 }, 'an image fell past maxRequestImageBytes 8 bytes'],
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
          assert.equal(ours().length, 1, `the sent compile says it for ${JSON.stringify(options)}`);
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
      memory({ maxLiveImages: 0, maxRequestImages: 4, imageStripHysteresisRatio: 0.5 }),
      [5],
    );
    assert.equal(last, '...II', 'one trim to half the ceiling');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('an image fell past maxRequestImages 4, which holds maxLiveImages 0 (no limit) to it'), lines[0]);
  });

  it('the memory strategy says it from its adaptive selection too, and nothing from a preview', async () => {
    const adaptive = memory({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 0, maxRequestImages: 2,
    });
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy: adaptive });
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    try {
      for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      const entries = manager.previewContext({ maxTokens: 1_000_000, reserveForResponse: 0 }, { maxRequestImages: 1 }, { render: true })?.entries ?? [];
      assert.equal(pattern(entries, 3), '..I', 'the preview strips to its own ceiling');
      assert.deepEqual(ours(), [], 'a preview, with its own ceiling, says nothing');
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 3), '.II');
      assert.equal(ours().length, 1, JSON.stringify(said));
      assert.ok(ours()[0]!.includes('an image fell past maxRequestImages 2, which holds maxLiveImages 0 (no limit) to it'), ours()[0]);
    } finally {
      console.warn = original;
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the memory strategy's strip leaves the line only from a render that's sent, not a layout rendered to compare against", async () => {
    for (const options of [
      { maxLiveImages: 0, maxRequestImages: 1 },
      { maxLiveImages: 0, maxLiveImageBytes: 0, maxRequestImageBytes: 4 },
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
        applyImageStripping(entries: unknown[], store: unknown, opts?: { sent?: boolean }): void;
        reportCeilingHits(): void;
      };
      const kept = entries();
      strip.applyImageStripping(kept, view);
      assert.equal(kept.filter((e) => e.content.some((b) => b.type === 'image')).length, 1, 'the strip ran: the ceiling replaced one');
      strip.reportCeilingHits();
      assert.deepEqual(ours(), [], `a layout rendered to compare against leaves nothing for ${JSON.stringify(options)}`);
      strip.applyImageStripping(entries(), view, { sent: true });
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
      autoTickOnNewMessage: false, maxLiveImages: 0, maxRequestImages: 2,
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
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      strategy: memory({ maxLiveImages: 0, maxRequestImages: 4, imageStripHysteresisRatio: 0.5 }),
    });
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    try {
      // The fifth image's message moves the watermark past the ceiling of 4.
      for (let i = 1; i <= 5; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      assert.deepEqual(ours(), [], 'the new messages say nothing');
      const compiled = await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
      assert.equal(pattern(compiled.messages, 5), '...II', 'one trim to half the ceiling');
      assert.equal(ours().length, 1, JSON.stringify(said));
      assert.ok(ours()[0]!.includes('an image fell past maxRequestImages 4'), ours()[0]);
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
      autoTickOnNewMessage: false, maxLiveImages: 0, maxRequestImages: 10, imageStripHysteresisRatio: 0.5,
    });
    const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    try {
      for (let i = 1; i <= 4; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      // A preview with a ceiling of 2 moves the watermark, for itself only:
      // its trim to half keeps one image, where the count alone keeps two.
      const entries = manager.previewContext({ maxTokens: 1_000_000, reserveForResponse: 0 }, { maxRequestImages: 2 }, { render: true })?.entries ?? [];
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
        autoTickOnNewMessage: false, maxLiveImages: 0, maxLiveImageBytes: 0, maxRequestImages: 0, maxRequestImageBytes: 0,
      }),
    });
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    try {
      for (let i = 1; i <= 3; i++) manager.addMessage('user', imageMessage(`img-${i}`));
      const entries = manager.previewContext({ maxTokens: 1_000_000, reserveForResponse: 0 }, { maxRequestImages: 1 }, { render: true })?.entries ?? [];
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

  it("the memory strategy leaves a watermark's line with the branch it moved on", async () => {
    const said: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
    const dir = mkdtempSync(join(tmpdir(), 'cm-request-ceilings-'));
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      strategy: memory({ maxLiveImages: 0, maxRequestImages: 4, imageStripHysteresisRatio: 0.5 }),
    });
    const ours = () => said.filter((line) => line.includes('an image fell past'));
    try {
      manager.addMessage('user', imageMessage('img-1'));
      const main = manager.currentBranch().name;
      await manager.fork('busy');
      // On the fork, new messages move the watermark past the ceiling of 4.
      for (let i = 2; i <= 5; i++) manager.addMessage('user', imageMessage(`img-${i}`));
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

  it("the memory strategy's watermark says nothing when the host's own limit binds", async () => {
    const { lines, last } = await ceilingLines(memory({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }), [5]);
    assert.equal(last, '...II', 'one trim to half the host limit');
    assert.deepEqual(lines, []);
  });

  it('marks only defaults in force: an explicit undefined maxLiveImages is no limit in the memory strategy, and 6 in windowed passthrough', async () => {
    const auto = await ceilingLines(memory({ maxLiveImages: undefined, maxRequestImages: 2 }), [3]);
    assert.equal(auto.lines.length, 1, JSON.stringify(auto.lines));
    assert.ok(auto.lines[0]!.includes('which holds maxLiveImages 0 (no limit) to it,'), auto.lines[0]);
    const win = await ceilingLines(windowed({ maxLiveImages: undefined, maxRequestImages: 2 }), [3]);
    assert.equal(win.lines.length, 1, JSON.stringify(win.lines));
    assert.ok(win.lines[0]!.includes('which holds maxLiveImages 6 (default) to it,'), win.lines[0]);
  });

  it("doesn't mark a value a subclass's enforced layer gives as a default", async () => {
    class Enforced extends AutobiographicalStrategy {
      protected override enforcedConfigLayer() {
        return { source: 'enforced', values: { maxRequestImages: 2 } };
      }
    }
    const { lines } = await ceilingLines(
      new Enforced({ headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0, maxLiveImages: 0 } as ConstructorParameters<typeof AutobiographicalStrategy>[0]),
      [3],
    );
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('an image fell past maxRequestImages 2, which holds'), lines[0]);
  });

  it('ceilingBoundLine marks a default or malformed ceiling, and gives bytes in MiB', () => {
    const configured = (o: Record<string, number>) =>
      ({ maxLiveImages: 0, maxLiveImageBytes: 0, maxRequestImages: 500, maxRequestImageBytes: 24 * MiB, ...o });
    assert.equal(ceilingBoundLine('s', 'images', configured({}), new Set(['maxRequestImages'])),
      '[s] an image fell past maxRequestImages 500 (default), which holds maxLiveImages 0 (no limit) to it, so images past it are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'images', configured({ maxRequestImages: Number.NaN, maxLiveImages: 800 }), new Set()),
      '[s] an image fell past maxRequestImages 500 (default), which holds maxLiveImages 800 to it, so images past it are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'bytes', configured({ maxLiveImageBytes: 30 * MiB }), new Set()),
      '[s] an image fell past maxRequestImageBytes 24 MiB, which holds maxLiveImageBytes 30 MiB to it, so images past it are now shown as placeholders');
    assert.equal(ceilingBoundLine('s', 'bytes', configured({ maxLiveImageBytes: 30 * MiB + 1 }), new Set(['maxRequestImageBytes'])),
      `[s] an image fell past maxRequestImageBytes 24 MiB (default), which holds maxLiveImageBytes ${30 * MiB + 1} bytes to it, so images past it are now shown as placeholders`);
  });

  it('the memory strategy says it when its hysteresis watermark trims against the byte ceiling', async () => {
    const { lines, last } = await ceilingLines(
      memory({ maxLiveImages: 0, maxLiveImageBytes: 0, maxRequestImageBytes: 16, imageStripHysteresisRatio: 0.5 }),
      [5],
    );
    assert.equal(last, '...II', 'one trim to half the ceiling');
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0]!.includes('an image fell past maxRequestImageBytes 16 bytes, which holds maxLiveImageBytes 0 (no limit) to it'), lines[0]);
  });
});

describe('compression prompts within the request ceilings', () => {
  it('carry at most maxRequestImages, the newest messages first', () => {
    const prepared = new Prepared({ maxRequestImages: 2 }).prepare(
      request([imageBlock('AAAA')], [imageBlock('BBBB')], [imageBlock('CCCC')]),
    );
    assert.equal(prepared.imageReplacements, 1);
    assert.equal(prepared.imageCountCap, 2);
    assert.equal(prepared.imagesKept, 2);
    assert.deepEqual(prepared.request.messages.map((m) => m.content[0]!.type), ['text', 'image', 'image']);
    assert.equal((prepared.request.messages[0]!.content[0] as { text: string }).text, PLACEHOLDER);
  });

  it('count an image nested in a tool result toward the ceiling', () => {
    const prepared = new Prepared({ maxRequestImages: 1 }).prepare(request(
      [imageBlock('AAAA')],
      [{ type: 'tool_result', toolUseId: 't', content: [imageBlock('BBBB')] } as ContentBlock],
    ));
    assert.equal(prepared.imageReplacements, 1);
    assert.equal(prepared.imagesKept, 1);
    const nested = (prepared.request.messages[1]!.content[0] as { content: ContentBlock[] }).content[0]!;
    assert.equal(nested.type, 'image', 'the newer, nested image takes the one slot');
    assert.equal((prepared.request.messages[0]!.content[0] as { text: string }).text, PLACEHOLDER, 'and the older one is replaced');
  });

  it('keep their byte budget within maxRequestImageBytes, and the images kept are what it lets through', () => {
    const prepared = new Prepared({ maxCompressionImageBytes: 3 * MiB, maxRequestImageBytes: 2 * MiB }).prepare(request([]));
    assert.equal(prepared.imageBudgetBytes, 2 * MiB);
    for (const none of [0, Infinity, -3, Number.NaN]) {
      assert.equal(new Prepared({ maxCompressionImageBytes: none, maxRequestImageBytes: 8 }).prepare(request([])).imageBudgetBytes, 8,
        `a budget of ${none} is none, so up to the byte ceiling`);
    }
    assert.equal(new Prepared({ maxCompressionImageBytes: 8.5, maxRequestImageBytes: 100 }).prepare(request([])).imageBudgetBytes, 8,
      'a fractional budget is floored');
    const walked = new Prepared({ maxCompressionImageBytes: 12, maxRequestImageBytes: 8 }).prepare(
      request([imageBlock('AAAA')], [imageBlock('BBBB')], [imageBlock('CCCC')]),
    );
    assert.equal(walked.imageBudgetBytes, 8);
    assert.equal(walked.imageReplacements, 1, 'under the clamped 8 bytes, two 4-byte images fit and the oldest does not');
    assert.equal(walked.imageBytesKept, 8);
    assert.deepEqual(walked.request.messages.map((m) => m.content[0]!.type), ['text', 'image', 'image'], 'the oldest is the one replaced');
    assert.equal(new Prepared({ maxCompressionImageBytes: 0, maxRequestImageBytes: 2 * MiB }).prepare(request([])).imageBudgetBytes,
      2 * MiB, 'an unlimited budget means up to the ceiling');
    assert.equal(new Prepared().prepare(request([])).imageBudgetBytes, 12 * MiB, 'the default budget is under the default ceiling');
  });

  it('carry at most maxRequestImages with no byte budget, and say only the ceiling', () => {
    const strategy = new Prepared({ maxCompressionImageBytes: 0, maxRequestImageBytes: 0, maxRequestImages: 1 });
    const input = request([imageBlock('AAAA')], [imageBlock('BBBB')]);
    assert.equal(strategy.prepare(input).imageReplacements, 1);
    assert.deepEqual(captureErrors(() => strategy.send(input, 'no-budget')), [
      '[autobiographical] compression prompt: replaced 1 image(s) with placeholders to stay under the ' +
        '1-image request ceiling (kept 1 image(s), 0.0MiB, newest messages first) [no-budget]',
    ]);
  });

  it('with no count ceiling, keep to the byte budget, and the log says only the budget', () => {
    const strategy = new Prepared({ maxCompressionImageBytes: 8, maxRequestImages: 0 });
    const input = request([imageBlock('AAAA')], [imageBlock('BBBB')], [imageBlock('CCCC')]);
    const prepared = strategy.prepare(input);
    assert.equal(prepared.imageCountCap, 0);
    assert.equal(prepared.imageReplacements, 1, 'two 4-byte images fit the 8-byte budget, the oldest does not');
    assert.deepEqual(prepared.request.messages.map((m) => m.content[0]!.type), ['text', 'image', 'image']);
    const logs = captureErrors(() => strategy.send(input, 'no-count'));
    assert.equal(logs.length, 1);
    assert.ok(!logs[0]!.includes('request ceiling'), logs[0]);
    assert.ok(logs[0]!.includes('inline image budget (kept 2 image(s)'), logs[0]);
  });

  it('with no budget and no ceilings, keep every image, more than the default ceiling of 500', () => {
    const images = Array.from({ length: 501 }, () => [imageBlock('AAAA')]);
    const prepared = new Prepared({ maxCompressionImageBytes: 0, maxRequestImages: 0, maxRequestImageBytes: 0 }).prepare(
      request(...images),
    );
    assert.equal(prepared.imageReplacements, 0);
    assert.equal(prepared.request.messages.filter((m) => m.content[0]!.type === 'image').length, 501, 'all 501 are still images');
  });
});
