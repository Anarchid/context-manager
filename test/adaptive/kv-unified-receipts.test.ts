import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KvUnifiedReceiptChain } from '../../src/adaptive/kv-unified-receipts.js';

const leaves = (rep: string) => new Map([
  ['a', { repHash: rep, level: rep === 'raw:a' ? 0 : 1, lastChangedSeq: 0 }],
]);

test('kv-unified receipts keep a single flight and advance only on acceptance', () => {
  const chain = new KvUnifiedReceiptChain();
  const first = chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: leaves('raw:a') });
  assert.equal(first.superseded, null);
  assert.equal(chain.inFlightSubmissionId, 's1');
  assert.equal(chain.head?.sequence ?? null, null, 'submission is not acceptance');
  const accepted = chain.accept('s1', 100, null);
  assert.equal(accepted.presentationAdvanced, true);
  assert.equal(chain.head?.sequence, 1);
  assert.equal(chain.leaves.get('a')?.repHash, 'raw:a');
});

test('kv-unified receipts supersede an unsettled flight instead of wedging the next submission', () => {
  // A provider call that died before its usage event (transport error, retry,
  // restart) leaves s1 open; the retry's submission must not fail on it.
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: leaves('raw:a') });
  const second = chain.begin({ submissionId: 's2', requestHash: 'r2', layoutHash: 'l2', leaves: leaves('summary:L1') });
  assert.equal(second.superseded, 's1');
  assert.equal(chain.inFlightSubmissionId, 's2');
  assert.equal(chain.head?.sequence ?? null, null, 'superseding never advances presentation');
  // Late callbacks for the superseded flight are duplicates, never state changes.
  assert.deepEqual(chain.accept('s1', 50, null), { presentationAdvanced: false, duplicate: true });
  chain.fail('s1');
  assert.equal(chain.inFlightSubmissionId, 's2');
  const accepted = chain.accept('s2', 100, null);
  assert.equal(accepted.presentationAdvanced, true);
  assert.equal(chain.head?.sequence, 1);
  assert.equal(chain.leaves.get('a')?.repHash, 'summary:L1');
  // A superseded id is remembered as settled across persistence too.
  const reloaded = KvUnifiedReceiptChain.deserialize(chain.serialize());
  assert.deepEqual(reloaded.accept('s1', 51, null), { presentationAdvanced: false, duplicate: true });
});

test('kv-unified receipts clear single flight on failure without changing baselines', () => {
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: leaves('raw:a') });
  chain.fail('s1');
  assert.equal(chain.inFlightSubmissionId, null);
  assert.equal(chain.head, null);
  chain.begin({ submissionId: 's2', requestHash: 'r2', layoutHash: 'l2', leaves: leaves('summary:L1') });
  assert.equal(chain.inFlightSubmissionId, 's2');
});

test('kv-unified keepalive leaves continuity head unchanged but refreshes cache state', () => {
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'same', leaves: leaves('raw:a') });
  chain.accept('s1', 100, null);
  const head = chain.head;
  const cache = {
    immutablePrefixHash: 'tools',
    layout: { units: [], totalTokens: 0 },
    markers: [],
  };
  chain.begin({ submissionId: 's2', requestHash: 'r1', layoutHash: 'same', leaves: leaves('raw:a') });
  const result = chain.accept('s2', 200, cache);
  assert.equal(result.presentationAdvanced, false);
  assert.equal(chain.head, head);
  assert.equal(chain.cache?.immutablePrefixHash, 'tools');
});

test('kv-unified receipt callbacks are idempotent by unique submission id', () => {
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'same-content', layoutHash: 'l1', leaves: leaves('raw:a') });
  chain.accept('s1', 100, null);
  assert.deepEqual(chain.accept('s1', 100, null), { presentationAdvanced: false, duplicate: true });
  chain.begin({ submissionId: 's2', requestHash: 'same-content', layoutHash: 'l2', leaves: leaves('summary:L1') });
  chain.accept('s2', 200, null);
  assert.equal(chain.head?.sequence, 2);
  assert.equal(chain.head?.parentReceiptHash?.length, 64);
  assert.notEqual(chain.head?.receiptHash, chain.head?.parentReceiptHash);
});

test('kv-unified receipt state round-trips through a Chronicle-safe JSON shape', () => {
  const chain = new KvUnifiedReceiptChain();
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: leaves('raw:a') });
  chain.accept('s1', 100, null, {
    requestHash: 'wire',
    markers: [{ ordinal: 0, prefixHash: 'prefix', estimatedOffset: 123 }],
  });
  const encoded = JSON.parse(JSON.stringify(chain.serialize()));
  const restored = KvUnifiedReceiptChain.deserialize(encoded);
  assert.equal(restored.head?.receiptHash, chain.head?.receiptHash);
  assert.equal(restored.leaves.get('a')?.repHash, 'raw:a');
  assert.equal(restored.wireReceipt?.acceptedAt, 100);
  assert.equal(restored.wireReceipt?.markers[0]?.estimatedOffset, 123);
  assert.deepEqual(restored.accept('s1', 100, null), {
    presentationAdvanced: false,
    duplicate: true,
  });
});

// ── Persisted form (#148) ──────────────────────────────────────────────────

import {
  encodeLeafRuns,
  decodeLeafRuns,
  type SerializedReceiptChainV1,
} from '../../src/adaptive/kv-unified-receipts.js';
import type { PresentedLeaf } from '../../src/adaptive/kv-unified-policy.js';

const leaf = (repHash: string, level: number, lastChangedSeq = 1): PresentedLeaf => ({ repHash, level, lastChangedSeq });

test('leaf runs are lossless for every id shape and keep presentation order', () => {
  const entries: Array<[string, PresentedLeaf | null]> = [
    ['10', leaf('summary:L2-1', 2)],
    ['11', leaf('summary:L2-1', 2)],
    ['12', leaf('summary:L2-1', 2)],
    ['14', leaf('summary:L2-1', 2)],       // gap: 13 is not a chunk
    ['007', leaf('summary:L2-1', 2)],      // non-canonical decimal stays verbatim
    ['8', leaf('summary:L2-1', 2)],        // not 007+1 — no range across it
    ['9', leaf('summary:L2-1', 2)],
    ['a', leaf('summary:L2-1', 2)],
    ['b', leaf('summary:L2-1', 2)],
    ['20', leaf('raw:20', 0)],
    ['21', leaf('raw:21', 0)],             // same level, different rep: its own run
    ['22', null],
    ['23', null],
    ['24', leaf('raw:24', 0, 1)],
    ['25', leaf('raw:24', 0, 2)],          // lastChangedSeq differs: its own run
    ['1', leaf('x', 1)],
    ['2', leaf('x', 1)],
    ['3', leaf('x', 1)],
  ];
  const runs = encodeLeafRuns(entries);
  assert.deepEqual(JSON.parse(JSON.stringify(decodeLeafRuns(runs))), entries);
  assert.deepEqual(runs[0].ids, ['10', -2, 2, '007', '8', -1, 'a', 'b']);
  assert.deepEqual(runs.map((r) => r.value === null ? null : r.value.repHash), [
    'summary:L2-1', 'raw:20', 'raw:21', null, 'raw:24', 'raw:24', 'x',
  ]);
  assert.deepEqual(runs[runs.length - 1].ids, ['1', -2]);
  assert.deepEqual(encodeLeafRuns([]), []);
  // Out-of-order ids inside a run are literals, never negative gaps.
  const back = encodeLeafRuns([['5', leaf('x', 1)], ['3', leaf('x', 1)], ['4', leaf('x', 1)]]);
  assert.deepEqual(back[0].ids, ['5', '3', -1]);
  assert.throws(() => decodeLeafRuns([{ value: null, ids: [2] }]), /malformed gap-coded leaf id/);
  // Ids beyond the safe-integer range are never ranged.
  const huge = encodeLeafRuns([['9007199254740993', leaf('x', 1)], ['9007199254740994', leaf('x', 1)]]);
  assert.deepEqual(huge[0].ids, ['9007199254740993', '9007199254740994']);
});

test('kv-unified receipt chain round-trips through the run-length form and still loads the pre-#148 form', () => {
  const chain = new KvUnifiedReceiptChain();
  const wide = new Map<string, PresentedLeaf>();
  for (let i = 100; i < 160; i++) wide.set(String(i), leaf('summary:L3-1', 3, 1));
  for (let i = 160; i < 170; i++) wide.set(String(i), leaf(`raw:${i}`, 0, 1));
  chain.begin({ submissionId: 's1', requestHash: 'r1', layoutHash: 'l1', leaves: wide });
  chain.accept('s1', 100, null);
  // Second presentation: a fold replaces ten raws with one summary, one chunk disappears.
  const next = new Map(wide);
  for (let i = 160; i < 170; i++) next.set(String(i), leaf('summary:L1-9', 1, 2));
  next.delete('150');
  chain.begin({ submissionId: 's2', requestHash: 'r2', layoutHash: 'l2', leaves: next });
  chain.accept('s2', 200, { immutablePrefixHash: 'p', layout: { totalTokens: 1, units: [] }, markers: [] } as never);

  const encoded = JSON.parse(JSON.stringify(chain.serialize()));
  assert.equal(encoded.format, 2);
  assert.equal(encoded.leafRuns.length, 2, 'the summary run and the folded run');
  assert.deepEqual(encoded.leafRuns[0].ids, ['100', -49, 2, -8], 'the removed chunk is a gap inside the run, not a new run');
  assert.equal(encoded.head.changeRuns.length, 2, 'one removal, one fold');
  assert.equal('changes' in encoded.head, false);
  assert.equal('leaves' in encoded, false);

  const restored = KvUnifiedReceiptChain.deserialize(encoded);
  assert.deepEqual(restored.head, chain.head, 'head (with its hash and change list) survives verbatim');
  assert.deepEqual([...restored.leaves], [...chain.leaves], 'leaf table and its order survive');
  assert.deepEqual(restored.cache, chain.cache);
  assert.deepEqual(restored.accept('s2', 201, null), { presentationAdvanced: false, duplicate: true });

  // A store written by the previous release still loads.
  const legacy: SerializedReceiptChainV1 = {
    head: chain.head,
    leaves: [...chain.leaves],
    cache: chain.cache,
    settledSubmissionIds: ['s1', 's2'],
    wireReceipt: null,
  };
  const fromLegacy = KvUnifiedReceiptChain.deserialize(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(fromLegacy.head, chain.head);
  assert.deepEqual([...fromLegacy.leaves], [...chain.leaves]);
  assert.deepEqual(fromLegacy.accept('s1', 1, null), { presentationAdvanced: false, duplicate: true });
});

test('kv-unified receipt bytes for a long session leaf table stay small', () => {
  // The shape of a long session: thousands of chunks folded under a few
  // hundred summaries, a few dozen raw at the tail.
  const leaves = new Map<string, PresentedLeaf>();
  let id = 1000;
  for (let summary = 0; summary < 150; summary++) {
    for (let k = 0; k < 130; k++) leaves.set(String(id++), leaf(`summary:L4-${summary}`, 4, summary));
    id += 3; // ids of messages that are not chunks
  }
  for (let k = 0; k < 40; k++) leaves.set(String(id++), leaf(`raw:${id}`, 0, 150));
  assert.equal(leaves.size, 150 * 130 + 40);
  const chain = new KvUnifiedReceiptChain({ head: null, leaves, cache: null });
  const bytes = JSON.stringify(chain.serialize()).length;
  const legacyBytes = JSON.stringify({ head: null, leaves: [...leaves], cache: null, settledSubmissionIds: [], wireReceipt: null }).length;
  assert.ok(legacyBytes > 1_000_000, `legacy form is O(leaves): ${legacyBytes}`);
  assert.ok(bytes < 20_000, `run-length form is O(runs): ${bytes}`);
  assert.deepEqual([...KvUnifiedReceiptChain.deserialize(JSON.parse(JSON.stringify(chain.serialize()))).leaves], [...leaves]);
});

test('kv-unified settled submission ids are bounded in memory as they are on disk', () => {
  const chain = new KvUnifiedReceiptChain();
  for (let i = 0; i < 300; i++) {
    chain.begin({ submissionId: `s${i}`, requestHash: 'r', layoutHash: `l${i}`, leaves: leaves('raw:a') });
    chain.accept(`s${i}`, i, null);
  }
  assert.equal(chain.serialize().settledSubmissionIds.length, 256);
  assert.deepEqual(chain.accept('s299', 1, null), { presentationAdvanced: false, duplicate: true }, 'recent ids stay settled');
  assert.throws(() => chain.accept('s0', 1, null), /does not match the in-flight submission/, 'an evicted id is simply unknown');
});
