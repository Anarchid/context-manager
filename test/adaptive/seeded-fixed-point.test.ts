/**
 * Replanned on unchanged inputs, a seeded plan settles.
 *
 * 1. A nested tree (every node has one parent, and every listing agrees with
 *    lineage) whose L3 spans two parentless L1s. L3-0 lists L2-0, L2-1 and
 *    L2-2, and L1-6 and L1-7 (m14 to m17), between L2-1's leaves and L2-2's,
 *    have no parent. Seeded from the bootstrap plan, the inversion pass reads
 *    m18 and m19 (at L3 through L3-0) as deeper than the older m14 to m17 (at
 *    L1, as deep as their lineage goes) and lowers them, which breaks L3-0.
 *    The next compile folds L3-0 back, so the plan alternates.
 * 2. A store with a second L1 over the same leaves. R-2 lists m0 and m1, as
 *    L1-0 does, and m0's lineage is R-2. The plan alternates between
 *    rendering both L1s (173 tokens) and rendering m0 and m1 raw (348).
 * 3. The first store with L1-6 and L1-7 re-pointed at L3-0, which still
 *    doesn't list m14 to m17 (R3-2). Their parent links reach L3-0, where
 *    they can't render, so they are no evidence that m18 and m19 are
 *    inverted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { SummaryEntry } from '../../src/types/strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { planControlledFrontier } from '../../src/adaptive/kv-control.js';

type Leaf = [rawTokens: number, l1Id: string];
type Node = [id: string, level: number, sourceIds: string[], tokens: number, parentId: string | null];
type Budget = { targetTokens: number; foldAtTokens: number; windowTokens: number; now: number; mergeThreshold: number };

function replan(leaves: Leaf[], nodes: Node[], budget: Budget, count: number): string[] {
  const summaries = new Map<string, SummaryEntry>();
  for (const [id, level, sourceIds, tokens, parentId] of nodes) {
    summaries.set(id, {
      id, level, content: id, tokens, sourceLevel: level - 1, sourceIds, created: 0,
      sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! },
      ...(parentId ? { parentId } : {}),
    });
  }
  const inputs: PickerInputs = {
    chunks: leaves.map(([rawTokens, l1Id], i) => ({
      id: `m${i}`, sequence: i, rawTokens, currentResolution: 0, lockedByAgent: false, pinned: false, l1Id,
    })),
    summaries, headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  const tree = new SummaryTree(inputs);
  // Each plan's levels in chunk order, then its tokens: '333333333333331111330 248'.
  const plans: string[] = [];
  let previous: ReadonlyMap<string, number> = new Map();
  for (let k = 0; k < count; k++) {
    const p = planControlledFrontier(inputs, tree, { ...budget, previous, rawZone: new Set() });
    plans.push(`${inputs.chunks.map((c) => p.resolutions.get(c.id) ?? 0).join('')} ${p.tokens}`);
    previous = p.resolutions;
  }
  return plans;
}

/**
 * Under the expand threshold, a seeded plan that re-reads nothing is kept, not
 * released, even where the from-scratch cut renders the same. That cut folds
 * L1-0, since un-folding it would pass W, and renders 30 tokens. Replanned on
 * unchanged inputs, the seeded ideal is the carried frontier, which re-reads
 * nothing, so the release isn't weighed (R3-3; #186 R3-2; Greptile's P2).
 */
test('replanned on unchanged inputs under the expand threshold, a seeded plan that re-reads nothing isn\'t released', () => {
  const summaries = new Map<string, SummaryEntry>([['L1-0', {
    id: 'L1-0', level: 1, content: 'L1-0', tokens: 30, sourceLevel: 0, sourceIds: ['m0', 'm1', 'm2'], created: 0,
    sourceRange: { first: 'm0', last: 'm2' },
  }]]);
  const inputs: PickerInputs = {
    chunks: [0, 1, 2].map((i) => ({
      id: `m${i}`, sequence: i, rawTokens: 50, currentResolution: 0, lockedByAgent: false, pinned: false, l1Id: 'L1-0',
    })),
    summaries, headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  const tree = new SummaryTree(inputs);
  const params = {
    targetTokens: 100, foldAtTokens: 120, expandAtTokens: 100, windowTokens: 120, now: 12, mergeThreshold: 3,
    rawZone: new Set<string>(),
  };
  const levels = (F: ReadonlyMap<string, number>) => inputs.chunks.map((c) => F.get(c.id) ?? 0).join('');
  const first = planControlledFrontier(inputs, tree, { ...params, previous: new Map() });
  assert.equal(levels(first.resolutions), '111', 'premise: the from-scratch cut folds L1-0');
  assert.ok(first.tokens < params.expandAtTokens, `premise: the plan is under the expand threshold: ${first.tokens}`);
  const second = planControlledFrontier(inputs, tree, { ...params, previous: first.resolutions });
  assert.equal(levels(second.resolutions), '111');
  assert.equal(second.perturbation, 0);
  assert.notEqual(second.seedingReleased, true, 'a seeded plan that re-reads nothing is kept');
});

test('replanned on unchanged inputs, a seeded plan keeps its frontier (an L3 over parentless L1s)', () => {
  const raw = [109, 66, 121, 187, 122, 127, 132, 143, 173, 56, 50, 115, 57, 153, 137, 120, 127, 193, 81, 103, 169];
  const l1 = ['L1-0', 'L1-0', 'L1-0', 'L1-1', 'L1-1', 'L1-1', 'L1-2', 'L1-3', 'L1-3', 'L1-3', 'L1-4',
    'L1-4', 'L1-5', 'L1-5', 'L1-6', 'L1-6', 'L1-7', 'L1-7', 'L1-8', 'L1-9', 'L1-10'];
  const plans = replan(raw.map((r, i): Leaf => [r, l1[i]!]), [
    ['L1-0', 1, ['m0', 'm1', 'm2'], 12, 'L2-0'],
    ['L1-1', 1, ['m3', 'm4', 'm5'], 13, 'L2-0'],
    ['L1-2', 1, ['m6'], 29, 'L2-0'],
    ['L1-3', 1, ['m7', 'm8', 'm9'], 32, 'L2-1'],
    ['L1-4', 1, ['m10', 'm11'], 13, 'L2-1'],
    ['L1-5', 1, ['m12', 'm13'], 14, 'L2-1'],
    ['L1-6', 1, ['m14', 'm15'], 13, null],
    ['L1-7', 1, ['m16', 'm17'], 30, null],
    ['L1-8', 1, ['m18'], 40, 'L2-2'],
    ['L1-9', 1, ['m19'], 31, 'L2-2'],
    ['L1-10', 1, ['m20'], 36, null],
    ['L2-0', 2, ['L1-0', 'L1-1', 'L1-2'], 44, 'L3-0'],
    ['L2-1', 2, ['L1-3', 'L1-4', 'L1-5'], 43, 'L3-0'],
    ['L2-2', 2, ['L1-8', 'L1-9'], 44, 'L3-0'],
    ['L3-0', 3, ['L2-0', 'L2-1', 'L2-2'], 36, null],
  ], { targetTokens: 206, foldAtTokens: 216, windowTokens: 5082, now: 72, mergeThreshold: 6 }, 4);
  for (let k = 1; k < plans.length; k++) assert.equal(plans[k], plans[0], `plan ${k + 1} moved: ${plans.join(' → ')}`);
});

test('replanned on unchanged inputs, seeded plans settle (a second L1 over the same leaves)', () => {
  const plans = replan([[92, 'R-2'], [152, 'L1-0'], [139, 'L1-1'], [148, 'L1-1'], [146, 'L1-1'], [61, 'L1-2']], [
    ['L1-0', 1, ['m0', 'm1'], 24, null],
    ['L1-1', 1, ['m2', 'm3', 'm4'], 43, null],
    ['L1-2', 1, ['m5'], 26, null],
    ['R-2', 1, ['m0', 'm1'], 45, null],
  ], { targetTokens: 271, foldAtTokens: 284, windowTokens: 1476, now: 12, mergeThreshold: 3 }, 6);
  assert.equal(plans[5], plans[4], `still moving at plan 6: ${plans.join(' → ')}`);
});

test('replanned on unchanged inputs, a seeded plan keeps its frontier (L1s re-pointed at an L3 that doesn\'t list them)', () => {
  const raw = [109, 66, 121, 187, 122, 127, 132, 143, 173, 56, 50, 115, 57, 153, 137, 120, 127, 193, 81, 103, 169];
  const l1 = ['L1-0', 'L1-0', 'L1-0', 'L1-1', 'L1-1', 'L1-1', 'L1-2', 'L1-3', 'L1-3', 'L1-3', 'L1-4',
    'L1-4', 'L1-5', 'L1-5', 'L1-6', 'L1-6', 'L1-7', 'L1-7', 'L1-8', 'L1-9', 'L1-10'];
  const plans = replan(raw.map((r, i): Leaf => [r, l1[i]!]), [
    ['L1-0', 1, ['m0', 'm1', 'm2'], 12, 'L2-0'],
    ['L1-1', 1, ['m3', 'm4', 'm5'], 13, 'L2-0'],
    ['L1-2', 1, ['m6'], 29, 'L2-0'],
    ['L1-3', 1, ['m7', 'm8', 'm9'], 32, 'L2-1'],
    ['L1-4', 1, ['m10', 'm11'], 13, 'L2-1'],
    ['L1-5', 1, ['m12', 'm13'], 14, 'L2-1'],
    ['L1-6', 1, ['m14', 'm15'], 13, 'L3-0'],
    ['L1-7', 1, ['m16', 'm17'], 30, 'L3-0'],
    ['L1-8', 1, ['m18'], 40, 'L2-2'],
    ['L1-9', 1, ['m19'], 31, 'L2-2'],
    ['L1-10', 1, ['m20'], 36, null],
    ['L2-0', 2, ['L1-0', 'L1-1', 'L1-2'], 44, 'L3-0'],
    ['L2-1', 2, ['L1-3', 'L1-4', 'L1-5'], 43, 'L3-0'],
    ['L2-2', 2, ['L1-8', 'L1-9'], 44, 'L3-0'],
    ['L3-0', 3, ['L2-0', 'L2-1', 'L2-2'], 36, null],
  ], { targetTokens: 206, foldAtTokens: 216, windowTokens: 5082, now: 72, mergeThreshold: 6 }, 4);
  for (let k = 1; k < plans.length; k++) assert.equal(plans[k], plans[0], `plan ${k + 1} moved: ${plans.join(' → ')}`);
});
