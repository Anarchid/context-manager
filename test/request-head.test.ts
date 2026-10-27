import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '@animalabs/membrane';
import type { ContextInjection, RenderStats } from '../src/types/index.js';
import type { RequestOverhead } from '../src/index.js';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'request-head-'));
const BUDGET = { maxTokens: 100_000, reserveForResponse: 2_000 };
const TIGHT = { maxTokens: 1_800, reserveForResponse: 200 };
after(() => rmSync(dir, { recursive: true, force: true }));

type Internals = {
  calibrationStateId: string;
  store: { setStateJson(id: string, value: unknown): void } | null;
};

const summarizer = {
  complete: async () => ({
    stopReason: 'end_turn',
    content: [{ type: 'text', text: 'A memory of this stretch, kept brief: ' + 'detail '.repeat(12) }],
    usage: { input_tokens: 1000, output_tokens: 40 },
  }),
};

type Shape = { adaptiveResolution?: boolean; foldingStrategy?: 'kv-stable' | 'kv-unified' };

const KV_UNIFIED = {
  policy: {
    alpha: 0.7,
    budgetLowRatio: 0.5,
    budgetHighRatio: 0.9,
    budgetUnderLambda: 10,
    budgetOverLambda: 10,
    cacheLambda: 1,
    cacheScale: 1000,
    cacheReadPrice: 0.1,
    cacheWritePrice: 1.25,
    continuityLambda: 1,
    continuityScale: 1000,
    continuityRecencyHalfLifeTokens: 1000,
    continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10,
    continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100,
  continuityBucketSize: 100,
  fidelityBucketSize: 100,
  labelCeiling: 10_000,
  adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false,
  preserveGapBearingSummaries: false,
};
const prefixFor = (shape: Shape) => (shape.foldingStrategy === 'kv-unified' ? { kvUnifiedImmutablePrefixHash: 'immutable-v1' } : {});

async function openManager(name: string, shape: Shape = {}) {
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'zz-model',
    targetChunkTokens: 120,
    headWindowTokens: 0,
    recentWindowTokens: 400,
    hierarchical: true,
    mergeThreshold: 3,
    adaptiveResolution: shape.adaptiveResolution ?? true,
    ...(shape.foldingStrategy ? { foldingStrategy: shape.foldingStrategy } : {}),
    ...(shape.foldingStrategy === 'kv-unified' ? { kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } } } : {}),
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane: summarizer as never });
  if (cm.getMessageCount() === 0) {
    for (let i = 0; i < 60; i++) {
      cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `turn ${i}: steady traffic about the ongoing work, with specifics `.repeat(4) }]);
      for (let k = 0; k < 200 && !cm.isReady(); k++) await cm.tick();
    }
  }
  return { cm, strategy, internals: strategy as unknown as Internals };
}

const TOOLS: ToolDefinition[] = Array.from({ length: 6 }, (_, i) => ({
  name: `server__tool_${i}`,
  description: 'Does one thing on the server. '.repeat(30),
  inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id.' } }, required: ['id'] },
}));
const HEAD: RequestOverhead = { system: `You are a resident. ${'Be precise. '.repeat(60)}`, tools: TOOLS };
const INJECTIONS: ContextInjection[] = [
  { namespace: 'retrieval', position: 'afterUser', content: [{ type: 'text', text: `Recalled: ${'a fact worth keeping. '.repeat(40)}` }] },
  { namespace: 'notes', position: 'beforeUser', content: [{ type: 'text', text: `Note: ${'something to mind. '.repeat(20)}` }] },
  { namespace: 'identity', position: 'system', content: [{ type: 'text', text: 'A system-position line, which goes into the system prompt.' }] },
];

describe('the request head priced by the compile (RenderStats.request)', () => {
  it('reports the head and the message injections at the prices a calibration sample compares', async () => {
    const { cm, strategy } = await openManager('sample-agrees');
    const { renderStats } = await cm.compile(BUDGET, INJECTIONS, { requestHead: HEAD });
    const request = renderStats!.request!;
    assert.ok(request.headTokens > 0 && request.injectedTokens > 0, JSON.stringify(request));
    assert.equal(renderStats!.calibration!.provisional, true, 'premise: a store with no record starts provisional, so its first sample replaces the multiplier outright');
    const total = renderStats!.total.tokens + request.headTokens + request.injectedTokens;
    strategy.reportRealInputTokens(1.5 * total, HEAD);
    const next = await cm.compile(BUDGET, INJECTIONS, { requestHead: HEAD });
    assert.equal(next.renderStats!.calibration!.multiplier, 1.5,
      'a provider total of 1.5 times the reported window, head and injections reads exactly 1.5 only if the sample prices them as the render stats do');
    cm.close();
  });

  it('prices the head at the compile\'s multiplier, in the units of total', async () => {
    const plain = await openManager('at-one');
    const atOne = (await plain.cm.compile(BUDGET, undefined, { requestHead: HEAD })).renderStats!;
    plain.cm.close();
    const seeded = await openManager('at-one-and-a-half');
    await seeded.cm.compile(BUDGET);
    seeded.internals.store!.setStateJson(seeded.internals.calibrationStateId,
      { multiplier: 1.5, at: 1, pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH });
    seeded.cm.close();
    const reopened = await openManager('at-one-and-a-half');
    const atOneAndAHalf = (await reopened.cm.compile(BUDGET, undefined, { requestHead: HEAD })).renderStats!;
    assert.equal(atOneAndAHalf.calibration!.multiplier, 1.5, 'premise: the seeded multiplier is in force');
    const want = 1.5 * atOne.request!.headTokens;
    assert.ok(Math.abs(atOneAndAHalf.request!.headTokens - want) <= 2, `${atOneAndAHalf.request!.headTokens} vs ${want}`);
    reopened.cm.close();
  });

  it('is absent from a compile given no head, with or without message injections', async () => {
    const { cm } = await openManager('no-head');
    assert.equal((await cm.compile(BUDGET)).renderStats!.request, undefined);
    assert.equal((await cm.compile(BUDGET, INJECTIONS)).renderStats!.request, undefined);
    assert.equal(cm.getRenderStats()!.request, undefined);
    assert.equal((await cm.compile(BUDGET, INJECTIONS, { dryRun: true })).renderStats!.request, undefined);
    cm.close();
  });

  it('comes with every compile that returns render stats: live, dry, hierarchical and a preview', async () => {
    const adaptive = await openManager('paths-adaptive');
    const live = (await adaptive.cm.compile(TIGHT, INJECTIONS, { requestHead: HEAD })).renderStats!;
    const want = live.request;
    assert.ok(want && want.headTokens > 0 && want.injectedTokens > 0);
    assert.deepStrictEqual(adaptive.cm.getRenderStats()!.request, want, 'getRenderStats after the live compile');
    assert.deepStrictEqual((await adaptive.cm.compile(TIGHT, INJECTIONS, { requestHead: HEAD, dryRun: true })).renderStats!.request, want, 'a dry compile');
    const messageInjections = INJECTIONS.filter((i) => i.position !== 'system').map((i) => i.content);
    const preview = adaptive.cm.previewContext(TIGHT, undefined, { render: true, requestHead: HEAD, messageInjections })!;
    assert.deepStrictEqual(preview.stats!.request, want, 'a preview');
    adaptive.cm.close();
    const hierarchical = await openManager('paths-hierarchical', { adaptiveResolution: false });
    const hs = (await hierarchical.cm.compile(TIGHT, INJECTIONS, { requestHead: HEAD })).renderStats!;
    assert.deepStrictEqual(hs.request, want, 'the hierarchical path');
    hierarchical.cm.close();
  });

  const shapes: Array<[string, Shape]> = [
    ['adaptive, flat-profile', {}],
    ['adaptive, kv-stable', { foldingStrategy: 'kv-stable' }],
    ['adaptive, kv-unified', { foldingStrategy: 'kv-unified' }],
    ['hierarchical', { adaptiveResolution: false }],
  ];
  for (const [label, shape] of shapes) {
    it(`selects identically with and without a head (${label})`, async () => {
      const without = await openManager(`same-without-${label}`, shape);
      const withHead = await openManager(`same-with-${label}`, shape);
      for (let round = 0; round < 3; round++) {
        const a = await without.cm.compile(TIGHT, INJECTIONS, prefixFor(shape));
        const b = await withHead.cm.compile(TIGHT, INJECTIONS, { ...prefixFor(shape), requestHead: HEAD });
        const s = a.renderStats!.summaries;
        assert.ok(s.l1.count + s.l2.count + s.l3.count > 0, `premise, round ${round}: the budget folds`);
        assert.deepStrictEqual(b.messages, a.messages, `round ${round}: the messages`);
        const { request: _priced, ...bStats } = b.renderStats!;
        const strip = (s: RenderStats) => ({ ...s, planVsActual: s.planVsActual && { ...s.planVsActual, compileMs: 0, solveMs: 0 } });
        assert.deepStrictEqual(strip(bStats as RenderStats), strip(a.renderStats!), `round ${round}: the render stats besides the head's price`);
        for (const { cm } of [without, withHead]) {
          cm.addMessage('User', [{ type: 'text', text: `more ${round}: further traffic about the work `.repeat(4) }]);
          for (let k = 0; k < 200 && !cm.isReady(); k++) await cm.tick();
        }
      }
      without.cm.close();
      withHead.cm.close();
    });
  }
});

describe('the calibration ceiling (RenderStats.calibration.ceiling)', () => {
  it('is reported with every calibration, and is the multiplier a record above it loads at', async () => {
    const first = await openManager('ceiling');
    const fresh = (await first.cm.compile(BUDGET)).renderStats!;
    assert.equal(fresh.calibration!.ceiling, 1.8);
    first.internals.store!.setStateJson(first.internals.calibrationStateId,
      { multiplier: 2.5, at: 1, pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH });
    first.cm.close();
    const reopened = await openManager('ceiling');
    const stats = (await reopened.cm.compile(BUDGET)).renderStats!;
    assert.equal(stats.calibration!.multiplier, stats.calibration!.ceiling);
    reopened.cm.close();
  });
});
