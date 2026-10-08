import { createHash } from 'node:crypto';
import type { ChunkId } from './folding-strategy.js';
import type { PresentedLeaf, ProviderCacheReference } from './kv-unified-policy.js';

export interface PendingPresentationSubmission {
  submissionId: string;
  requestHash: string;
  layoutHash: string;
  leaves: ReadonlyMap<ChunkId, PresentedLeaf>;
}

export interface PresentationDelta {
  leafId: ChunkId;
  value: PresentedLeaf | null;
}

export interface PresentationReceipt {
  sequence: number;
  receiptHash: string;
  parentReceiptHash: string | null;
  submissionId: string;
  requestHash: string;
  layoutHash: string;
  acceptedAt: number;
  changes: readonly PresentationDelta[];
}

export interface ReceiptChainSnapshot {
  head: PresentationReceipt | null;
  leaves: ReadonlyMap<ChunkId, PresentedLeaf>;
  cache: ProviderCacheReference | null;
  wireReceipt?: ObservedCacheWireReceipt | null;
}

export interface ObservedCacheWireReceipt {
  requestHash: string;
  acceptedAt: number;
  markers: Array<{ ordinal: number; prefixHash: string; estimatedOffset: number }>;
}

/** One run of the run-length encoded leaf table: consecutive leaves (in
 * presentation order) that share the same `PresentedLeaf`. Every chunk folded
 * under one summary shares its representative, so a 23k-leaf table from a
 * six-week session is ~170 runs (#148).
 *
 * `ids` is the run's leaf ids, gap-coded: a string is a literal id; a positive
 * integer `k` is "the previous id plus k"; a negative integer `-n` is "the next
 * n ids, each the previous plus one". Only canonical-decimal ids (no sign, no
 * leading zeros, safe-integer range) take part in the arithmetic, so the
 * exact id strings and their order survive a round trip; any other id
 * (`"007"`, `"a"`) is kept verbatim and restarts the arithmetic. */
export interface LeafRun {
  value: PresentedLeaf | null;
  ids: Array<ChunkId | number>;
}

export interface SerializedReceiptHead extends Omit<PresentationReceipt, 'changes'> {
  changeRuns: LeafRun[];
}

/** The persisted form before #148: one `[id, leaf]` pair per presented leaf,
 * so every write cost O(messages) bytes and the record log grew as
 * O(accepted calls × messages). Still accepted by `deserialize`; never
 * written. */
export interface SerializedReceiptChainV1 {
  head: PresentationReceipt | null;
  leaves: Array<[ChunkId, PresentedLeaf]>;
  cache: ProviderCacheReference | null;
  settledSubmissionIds: string[];
  wireReceipt: ObservedCacheWireReceipt | null;
}

export interface SerializedReceiptChainV2 {
  format: 2;
  head: SerializedReceiptHead | null;
  leafRuns: LeafRun[];
  cache: ProviderCacheReference | null;
  settledSubmissionIds: string[];
  wireReceipt: ObservedCacheWireReceipt | null;
}

export type SerializedReceiptChain = SerializedReceiptChainV1 | SerializedReceiptChainV2;

/** Settled submission ids are only consulted to make a late accept/fail for
 * an already-settled flight a no-op; the persisted form always carried the
 * last 256, this bounds the in-memory set the same way. */
const SETTLED_RETAINED = 256;

/** Pure single-flight receipt state machine. Persistence is layered on its
 * serializable snapshots by the strategy. Identical-layout keepalives update
 * cache state but deliberately do not advance presentation continuity. */
export class KvUnifiedReceiptChain {
  private headValue: PresentationReceipt | null;
  private leavesValue: Map<ChunkId, PresentedLeaf>;
  private cacheValue: ProviderCacheReference | null;
  private wireReceiptValue: ObservedCacheWireReceipt | null;
  private pending: PendingPresentationSubmission | null = null;
  private settled = new Set<string>();

  constructor(snapshot?: ReceiptChainSnapshot) {
    this.headValue = snapshot?.head ?? null;
    this.leavesValue = new Map(snapshot?.leaves ?? []);
    this.cacheValue = snapshot?.cache ?? null;
    this.wireReceiptValue = snapshot?.wireReceipt ?? null;
  }

  static deserialize(value: SerializedReceiptChain): KvUnifiedReceiptChain {
    const chain =
      isSerializedV2(value)
        ? new KvUnifiedReceiptChain({
            head: value.head ? deserializeHead(value.head) : null,
            leaves: decodeLeafTable(value.leafRuns),
            cache: value.cache,
            wireReceipt: value.wireReceipt,
          })
        : new KvUnifiedReceiptChain({
            head: value.head,
            leaves: new Map(value.leaves),
            cache: value.cache,
            wireReceipt: value.wireReceipt,
          });
    chain.settled = new Set((value.settledSubmissionIds ?? []).slice(-SETTLED_RETAINED));
    return chain;
  }

  get head(): PresentationReceipt | null { return this.headValue; }
  get leaves(): ReadonlyMap<ChunkId, PresentedLeaf> { return this.leavesValue; }
  get cache(): ProviderCacheReference | null { return this.cacheValue; }
  get wireReceipt(): ObservedCacheWireReceipt | null { return this.wireReceiptValue; }
  get inFlightSubmissionId(): string | null { return this.pending?.submissionId ?? null; }

  /** Bind a new provider submission. An unsettled earlier flight is
   * superseded, not defended: the caller composes a new request only after
   * the previous one is dead (transport error before any usage event, a
   * provider or framework retry, a restart), and `accept` requires the
   * matching in-flight id, so nothing could ever settle it. Throwing here
   * turned every such transient into a second, self-inflicted failure of the
   * retry ("… is still in flight", devops agent 2026-09-16). The superseded
   * id is returned so the strategy can log it; a late accept/fail for it is a
   * duplicate no-op, never a state change. */
  begin(submission: PendingPresentationSubmission): { superseded: string | null } {
    if (!submission.submissionId) throw new Error('kv-unified submissionId must be non-empty');
    let superseded: string | null = null;
    if (this.pending) {
      superseded = this.pending.submissionId;
      this.markSettled(superseded);
      this.pending = null;
    }
    this.pending = { ...submission, leaves: new Map(submission.leaves) };
    return { superseded };
  }

  accept(
    submissionId: string,
    acceptedAt: number,
    cache: ProviderCacheReference | null,
    wireReceipt?: Omit<ObservedCacheWireReceipt, 'acceptedAt'>,
  ): { presentationAdvanced: boolean; duplicate: boolean } {
    if (this.settled.has(submissionId)) return { presentationAdvanced: false, duplicate: true };
    const pending = this.requirePending(submissionId);
    this.pending = null;
    this.markSettled(submissionId);
    this.cacheValue = cache;
    if (wireReceipt) this.wireReceiptValue = { ...wireReceipt, acceptedAt };
    if (this.headValue?.layoutHash === pending.layoutHash) {
      return { presentationAdvanced: false, duplicate: false };
    }
    const changes = diffLeaves(this.leavesValue, pending.leaves);
    const sequence = (this.headValue?.sequence ?? 0) + 1;
    const parentReceiptHash = this.headValue?.receiptHash ?? null;
    const receiptPayload = {
      sequence,
      parentReceiptHash,
      submissionId,
      requestHash: pending.requestHash,
      layoutHash: pending.layoutHash,
      acceptedAt,
      changes,
    };
    const receiptHash = createHash('sha256').update(JSON.stringify(receiptPayload)).digest('hex');
    this.headValue = { ...receiptPayload, receiptHash };
    this.leavesValue = new Map(pending.leaves);
    return { presentationAdvanced: true, duplicate: false };
  }

  fail(submissionId: string): void {
    if (this.settled.has(submissionId)) return;
    this.requirePending(submissionId);
    this.pending = null;
    this.markSettled(submissionId);
  }

  snapshot(): ReceiptChainSnapshot {
    return {
      head: this.headValue,
      leaves: new Map(this.leavesValue),
      cache: this.cacheValue,
      wireReceipt: this.wireReceiptValue,
    };
  }

  serialize(): SerializedReceiptChainV2 {
    return {
      format: 2,
      head: this.headValue ? serializeHead(this.headValue) : null,
      leafRuns: encodeLeafRuns(this.leavesValue),
      cache: this.cacheValue,
      settledSubmissionIds: [...this.settled].slice(-SETTLED_RETAINED),
      wireReceipt: this.wireReceiptValue,
    };
  }

  private markSettled(submissionId: string): void {
    this.settled.add(submissionId);
    if (this.settled.size > SETTLED_RETAINED) {
      // Insertion order: the first key is the oldest settled id.
      for (const oldest of this.settled) {
        this.settled.delete(oldest);
        break;
      }
    }
  }

  private requirePending(submissionId: string): PendingPresentationSubmission {
    if (!this.pending || this.pending.submissionId !== submissionId) {
      throw new Error(`kv-unified callback ${submissionId} does not match the in-flight submission`);
    }
    return this.pending;
  }
}

function diffLeaves(
  previous: ReadonlyMap<ChunkId, PresentedLeaf>,
  next: ReadonlyMap<ChunkId, PresentedLeaf>,
): PresentationDelta[] {
  const ids = new Set([...previous.keys(), ...next.keys()]);
  const changes: PresentationDelta[] = [];
  for (const leafId of [...ids].sort()) {
    const before = previous.get(leafId);
    const after = next.get(leafId);
    if (sameLeaf(before, after)) continue;
    changes.push({ leafId, value: after ?? null });
  }
  return changes;
}

function sameLeaf(a: PresentedLeaf | undefined, b: PresentedLeaf | undefined): boolean {
  return a?.repHash === b?.repHash && a?.level === b?.level && a?.lastChangedSeq === b?.lastChangedSeq;
}

function isSerializedV2(value: SerializedReceiptChain): value is SerializedReceiptChainV2 {
  return 'format' in value && value.format === 2;
}

function sameRunValue(a: PresentedLeaf | null, b: PresentedLeaf | null): boolean {
  if (a === null || b === null) return a === b;
  return sameLeaf(a, b);
}

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,14})$/;

/** The integer an id stands for when it is written as a canonical decimal
 * (no sign, no leading zeros, within the safe-integer range), else null. Only
 * such ids may join a range: `String(n)` must give back the exact id. */
function canonicalDecimal(id: ChunkId): number | null {
  return CANONICAL_DECIMAL.test(id) ? Number(id) : null;
}

/** Run-length encode `[id, value]` entries in the given order. See `LeafRun`. */
export function encodeLeafRuns(
  entries: Iterable<readonly [ChunkId, PresentedLeaf | null]>,
): LeafRun[] {
  const runs: LeafRun[] = [];
  let run: LeafRun | null = null;
  // The integer the previous id in `run` stands for, when it had one.
  let prev: number | null = null;
  for (const [id, value] of entries) {
    if (!run || !sameRunValue(run.value, value)) {
      run = { value, ids: [] };
      runs.push(run);
      prev = null;
    }
    const n = canonicalDecimal(id);
    const gap = n !== null && prev !== null ? n - prev : 0;
    if (gap === 1) {
      const last = run.ids[run.ids.length - 1];
      if (typeof last === 'number' && last < 0) run.ids[run.ids.length - 1] = last - 1;
      else run.ids.push(-1);
    } else if (gap > 1) {
      run.ids.push(gap);
    } else {
      // Non-canonical, first in the run, or out of order: literal.
      run.ids.push(id);
    }
    prev = n;
  }
  return runs;
}

/** Inverse of `encodeLeafRuns`: the entries in their original order. */
export function decodeLeafRuns(runs: readonly LeafRun[]): Array<[ChunkId, PresentedLeaf | null]> {
  const out: Array<[ChunkId, PresentedLeaf | null]> = [];
  for (const run of runs) {
    let prev: number | null = null;
    for (const entry of run.ids) {
      if (typeof entry === 'string') {
        out.push([entry, run.value]);
        prev = canonicalDecimal(entry);
        continue;
      }
      if (prev === null || !Number.isInteger(entry) || entry === 0) {
        throw new Error(`kv-unified receipt: malformed gap-coded leaf id ${String(entry)}`);
      }
      if (entry > 0) {
        prev += entry;
        out.push([String(prev), run.value]);
      } else {
        for (let k = 0; k < -entry; k++) {
          prev += 1;
          out.push([String(prev), run.value]);
        }
      }
    }
  }
  return out;
}

function decodeLeafTable(runs: readonly LeafRun[]): Map<ChunkId, PresentedLeaf> {
  const leaves = new Map<ChunkId, PresentedLeaf>();
  for (const [id, value] of decodeLeafRuns(runs)) {
    if (value) leaves.set(id, value);
  }
  return leaves;
}

function serializeHead(head: PresentationReceipt): SerializedReceiptHead {
  const { changes, ...rest } = head;
  return { ...rest, changeRuns: encodeLeafRuns(changes.map((c) => [c.leafId, c.value] as const)) };
}

function deserializeHead(head: SerializedReceiptHead): PresentationReceipt {
  const { changeRuns, ...rest } = head;
  return { ...rest, changes: decodeLeafRuns(changeRuns).map(([leafId, value]) => ({ leafId, value })) };
}
