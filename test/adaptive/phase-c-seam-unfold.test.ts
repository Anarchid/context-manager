/**
 * Phase C un-folds by youngest POSITION, not deepest level.
 *
 * Reproduces the flap measured on Fable (fold-diff, 2026-10-07..09): after
 * the budget-forced fold, the old walk spent the remaining headroom by raising
 * the youngest DEEP group (right after the deep band — a ~300k-token front
 * edit) before any L1 at the seam. Now headroom is spent at the seam: the
 * deep groups are intact and the only raw content is the youngest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout, kvCost } from '../../src/adaptive/render-offsets.js';
import { planControlledFrontier } from '../../src/adaptive/kv-control.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

// 216 chunks = 1 L3 / 6 L2 / 36 L1 (groups of 6, harness chain). 50 raw
// tokens per chunk, 100 per recall pair: a raw group costs 300, its L1 100
// (un-fold quantum +200 at the seam); an L2 over 36 chunks costs 100 against
// six L1s at 600 (un-fold quantum +500 at the deep end) — both quanta fit the
// headroom, as on Fable (L3→L2 ≈ +14k, L1→raw ≈ +12k, headroom ≈ 38k).
function setup() {
  const ch = buildChronicleWithChain({ chunkCount: 216, tokensPerChunk: 50, mergeThreshold: 6, recallPairTokens: 100 });
  const tail = new Set(ch.chunks.slice(210).map((c) => c.id)); // raw tail: last 6
  const inputs: PickerInputs = {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 300, headChunkIds: new Set(), tailChunkIds: tail,
  };
  const tree = new SummaryTree(inputs);
  const ids = (a: number, b: number): ChunkId[] => ch.chunks.slice(a, b).map((c) => c.id);
  let now = 0; for (const c of inputs.chunks) if (c.sequence > now) now = c.sequence;
  return { ch, inputs, tree, ids, now, tail };
}

function plan(s: ReturnType<typeof setup>, target: number, W: number) {
  return planControlledFrontier(s.inputs, s.tree, {
    previous: new Map(), foldAtTokens: W, expandAtTokens: target, targetTokens: target,
    windowTokens: W, rawZone: s.tail, now: s.now, mergeThreshold: 6,
  });
}

const histogram = (F: ReadonlyMap<ChunkId, number>, ids: ChunkId[]): Record<number, number> => {
  const h: Record<number, number> = {};
  for (const id of ids) { const l = F.get(id) ?? 0; h[l] = (h[l] ?? 0) + 1; }
  return h;
};

test('phase C spends headroom at the seam: deep groups intact, youngest foldable group raw', () => {
  const s = setup();
  // All 35 foldable L1 groups = 3500 + tail 300 = 3800 > target 3650, so the
  // cut deepens the oldest L2 group (−500) → 3300. Headroom 350: the old walk
  // raised that L2 group first (+500 → 3800, closer than 3300, accepted) — the
  // front edit. By position, two seam groups open instead (+200, +200 → 3700)
  // and the L2 group is never touched.
  const p = plan(s, 3650, 4200);
  const middle = s.ids(0, 210);
  const h = histogram(p.resolutions, middle);
  assert.equal(h[2], 36, `the deep L2 group is intact: ${JSON.stringify(h)}`);
  assert.ok(s.ids(198, 210).every((id) => (p.resolutions.get(id) ?? 0) === 0), 'two youngest foldable groups are raw');
  assert.ok(s.ids(0, 198).every((id) => (p.resolutions.get(id) ?? 0) >= 1), 'nothing older than the seam is raw');
  assert.equal(p.tokens, 3700);
  assert.equal(renderLayout(s.inputs, s.tree, p.resolutions).totalTokens, p.tokens);
});

test('phase C takes the seam quantum that fits and leaves the deep group alone', () => {
  const s = setup();
  // Same fold state (3300); headroom 250 fits exactly one seam un-fold
  // (3500, 50 short) — a second (3700) or the deep one (3800) would overshoot.
  const p = plan(s, 3550, 4200);
  const h = histogram(p.resolutions, s.ids(0, 210));
  assert.equal(h[2], 36, `the deep L2 group is intact: ${JSON.stringify(h)}`);
  assert.ok(s.ids(204, 210).every((id) => (p.resolutions.get(id) ?? 0) === 0), 'youngest foldable group raw');
  assert.ok(s.ids(0, 204).every((id) => (p.resolutions.get(id) ?? 0) >= 1), 'nothing older is raw');
  assert.equal(p.tokens, 3500);
});

/**
 * Excision shape from the #156 review: a 72-leaf base-6 chain where leaves
 * 36..70 were removed by store surgery, leaving the younger L2 (L2-1) with a
 * single live member (leaf 71) that renders at 300 raw tokens with salience
 * 0.1 while its L2 pair costs 50. Six protected 1-token tail leaves follow.
 * Carried-less bootstrap, target 506 / W 806. Fold state before phase C is
 * 156 (L2-0 at 100 + L2-1 at 50 + tail 6). The youngest survivor's L2→L1 is
 * +50; its L1→raw is +200; the older L2-0's L2→L1 is +500. Walking on after
 * the first accept let L2-0 take the headroom (→706, survivor stuck at L1);
 * restarting after each accept gives 156 → 206 → 406 with the survivor raw
 * and the older group folded.
 */
test('phase C: a singleton group after excision steps all the way down before an older group is touched', () => {
  const ch = buildChronicleWithChain({ chunkCount: 72, tokensPerChunk: 50, mergeThreshold: 6, recallPairTokens: 100 });
  const survivor = ch.chunks[71]!;
  survivor.rawTokens = 300;
  survivor.salience = 0.1;
  // Price the younger L2 at 50 so the survivor's L2→L1 step is +50.
  const l2ids = [...ch.summaries.values()].filter((s) => s.level === 2).map((s) => s.id).sort();
  ch.recallPairTokens.set(l2ids[1]!, 50);
  const removed = new Set(ch.chunks.slice(36, 71).map((c) => c.id));
  const tailIds: ChunkId[] = [];
  for (let i = 0; i < 6; i++) {
    const c = ch.addChunk({ id: `tail-${i}`, rawTokens: 1 });
    // Far ahead in sequence, so the survivor's log-age cap allows L2 and
    // phase A folds it there (the probe's 156 pre-C state); with the tail
    // adjacent its cap is L1 and the case degenerates to a one-step un-fold.
    c.sequence = 200 + i;
    tailIds.push(c.id);
  }
  const chunks = ch.chunks.filter((c) => !removed.has(c.id));
  const tail = new Set(tailIds);
  const inputs: PickerInputs = {
    chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 6, headChunkIds: new Set(), tailChunkIds: tail,
  };
  const tree = new SummaryTree(inputs);
  let now = 0; for (const c of chunks) if (c.sequence > now) now = c.sequence;
  const p = planControlledFrontier(inputs, tree, {
    previous: new Map(), foldAtTokens: 806, expandAtTokens: 506, targetTokens: 506,
    windowTokens: 806, rawZone: tail, now, mergeThreshold: 6,
  });
  assert.equal(p.resolutions.get(survivor.id) ?? 0, 0, 'youngest survivor is raw');
  for (const id of ch.chunks.slice(0, 36).map((c) => c.id)) {
    assert.equal(p.resolutions.get(id), 2, `${id}: older group stays folded`);
  }
  assert.equal(p.tokens, 406);
});

/**
 * Carried-growth replay (shape from the #156 review): a base-6 chain at 50
 * raw / 100 recall, the last six leaves protected, one appended leaf per
 * turn, a summary every six leaves (upper levels pre-produced), every
 * returned frontier carried into the next solve. Crosses W repeatedly.
 * With the carried-seeded ideal no deep (L3) group is ever raised and the
 * total re-read is well below the from-scratch cut's.
 */
function growthReplay(opts: { seedFromCarried: boolean; turns: number }) {
  const ch = new MockChronicle({ mergeThreshold: 6, recallPairTokens: 100 });
  let n = 0;
  const add = () => { ch.addChunk({ id: `c-${String(n).padStart(5, '0')}`, rawTokens: 50 }); n++; };
  const produce = () => {
    for (let i = 0; i + 6 <= ch.chunks.length; i += 6) {
      if (!ch.chunks[i]!.l1Id) ch.produceL1(ch.chunks.slice(i, i + 6).map((c) => c.id));
    }
    ch.preProduceUpperLevels();
  };
  for (let i = 0; i < 1296; i++) add();
  produce();
  const TARGET = 1600, W = 2150;
  let previous = new Map<ChunkId, number>();
  let prevLayout: ReturnType<typeof renderLayout> | null = null;
  let totalPert = 0, deepRaises = 0, folds = 0;
  for (let t = 0; t < opts.turns; t++) {
    add(); produce();
    const tail = new Set(ch.chunks.slice(-6).map((c) => c.id));
    const inputs: PickerInputs = {
      chunks: ch.chunks.map((c) => ({ ...c, currentResolution: previous.get(c.id) ?? 0 })),
      summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
      headTokens: 0, tailTokens: 300, headChunkIds: new Set(), tailChunkIds: tail,
    };
    const tree = new SummaryTree(inputs);
    let now = 0; for (const c of inputs.chunks) if (c.sequence > now) now = c.sequence;
    const plan = planControlledFrontier(inputs, tree, {
      previous, foldAtTokens: W, expandAtTokens: TARGET, targetTokens: TARGET, windowTokens: W,
      rawZone: tail, now, mergeThreshold: 6, seedFromCarried: opts.seedFromCarried,
    });
    const layout = renderLayout(inputs, tree, plan.resolutions);
    if (prevLayout) totalPert += kvCost(prevLayout, layout);
    for (const c of inputs.chunks) {
      const before = previous.get(c.id) ?? 0, after = plan.resolutions.get(c.id) ?? 0;
      if (before === 3 && after < 3) deepRaises++;
    }
    if (plan.folded) folds++;
    previous = plan.resolutions; prevLayout = layout;
  }
  return { totalPert, deepRaises, folds };
}

test('carried growth: the seeded ideal never raises a deep group across repeated W crossings', () => {
  const seeded = growthReplay({ seedFromCarried: true, turns: 120 });
  assert.ok(seeded.folds >= 2, `crossed W at least twice (folds=${seeded.folds})`);
  assert.equal(seeded.deepRaises, 0, 'no L3 leaf was ever raised');
  const scratch = growthReplay({ seedFromCarried: false, turns: 120 });
  assert.ok(scratch.deepRaises > 0, `the from-scratch ideal does raise deep groups here (${scratch.deepRaises} leaves)`);
  // Both totals include the same pure-append baseline (one 50-token leaf per
  // turn) and the same seam folds; the difference is the band-boundary flap.
  // Measured 20,000 vs 25,900 at 120 turns (this replay's seam folds land
  // right after the deep band, so they are expensive here too); the deep
  // raises above are the load-bearing assertion.
  assert.ok(seeded.totalPert < scratch.totalPert * 0.9,
    `re-read: seeded ${seeded.totalPert} vs from-scratch ${scratch.totalPert}`);
});
