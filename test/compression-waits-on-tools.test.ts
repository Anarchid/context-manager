import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { AutobiographicalProgressSnapshot } from '../src/strategies/autobiographical.js';

const STORE = './test-compression-waits-on-tools';
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };
const t = (s: string): ContentBlock => ({ type: 'text', text: s });
const words = (n: number) => 'substantive words about real happenings '.repeat(n);
const TOOLS = [{ name: 'fetch', description: 'fetch a thing', inputSchema: { type: 'object' as const } }];

function mockMembrane() {
  const calls: Array<{ tools: unknown }> = [];
  const membrane = {
    complete: async (request: { tools?: unknown }) => {
      calls.push({ tools: request.tools });
      return { stopReason: 'end_turn', content: [t(`[summary ${calls.length}] what happened, briefly`)], usage: { input_tokens: 100, output_tokens: 10 } };
    },
  };
  return { membrane, calls };
}

interface Opened {
  manager: ContextManager;
  strategy: AutobiographicalStrategy;
  calls: Array<{ tools: unknown }>;
  snapshot: () => AutobiographicalProgressSnapshot;
}

async function open(opts: { model?: string; autoTick?: boolean; keep?: boolean; mergeThreshold?: number } = {}): Promise<Opened> {
  if (!opts.keep) cleanup();
  const { membrane, calls } = mockMembrane();
  const strategy = new AutobiographicalStrategy({
    compressionModel: opts.model ?? 'test-compression-model', targetChunkTokens: 80, headWindowTokens: 0, recentWindowTokens: 0,
    hierarchical: true, mergeThreshold: opts.mergeThreshold ?? 100, autoTickOnNewMessage: opts.autoTick ?? false,
  });
  const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as never });
  return { manager, strategy, calls, snapshot: () => strategy.getProgressSnapshot() };
}

/** Eight messages of prose, a call and its result in two messages, then twenty more. */
function addToolBearing(manager: ContextManager): void {
  for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [t(`event ${i} ${words(8)}`)]);
  manager.addMessage('agent', [t(words(2)), { type: 'tool_use', id: 'call-1', name: 'fetch', input: { q: 'y' } } as ContentBlock]);
  manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-1', content: 'x'.repeat(400) } as ContentBlock]);
  for (let i = 0; i < 20; i++) manager.addMessage(i % 2 ? 'user' : 'agent', [t(`later ${i} ${words(8)}`)]);
}

function addPlain(manager: ContextManager): void {
  for (let i = 0; i < 30; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [t(`event ${i} ${words(8)}`)]);
}

/** Ticks until isReady(), as a host's maintenance loop does; fails past the bound. */
async function tickUntilReady(manager: ContextManager, bound = 200): Promise<number> {
  for (let i = 0; i < bound; i++) {
    if (manager.isReady()) return i;
    await manager.tick();
  }
  throw new Error(`still not ready after ${bound} ticks`);
}

describe('compression that waits on the host\'s tool definitions', () => {
  after(cleanup);

  it('waits queued while no tools are declared, and compresses once they are, with no new message', async () => {
    const { manager, calls, snapshot } = await open();
    addToolBearing(manager);
    await tickUntilReady(manager);
    const before = snapshot();
    assert.ok(before.chunksCompressed >= 1, 'premise: the chunks before the call compress with no tools');
    assert.ok(before.l1WaitingOnTools >= 2, 'premise: the chunk holding the call and a later one wait');
    assert.strictEqual(before.l1QueueLength, 0);
    assert.strictEqual(calls.length, before.chunksCompressed);

    manager.setToolDefinitions(TOOLS);
    assert.strictEqual(manager.isReady(), false, 'with tools declared, the waiting chunks are work a tick can do');
    assert.strictEqual(manager.getWaitingWork(), null);
    await tickUntilReady(manager);
    const after = snapshot();
    assert.strictEqual(after.chunksCompressed, before.chunksCompressed + before.l1WaitingOnTools);
    assert.strictEqual(after.l1WaitingOnTools, 0);
    assert.ok(calls.slice(before.chunksCompressed).every((c) => Array.isArray(c.tools) && (c.tools as unknown[]).length === TOOLS.length));
    await manager.close();
  });

  it('"nothing to do" and "waiting on tools" both read ready with no pending work, and only getWaitingWork tells them apart', async () => {
    const plain = await open();
    addPlain(plain.manager);
    await tickUntilReady(plain.manager);
    assert.strictEqual(plain.manager.isReady(), true);
    assert.strictEqual(plain.manager.getPendingWork(), null);
    assert.strictEqual(plain.manager.getWaitingWork(), null);
    await plain.manager.close();

    const waiting = await open();
    addToolBearing(waiting.manager);
    await tickUntilReady(waiting.manager);
    const n = waiting.snapshot().l1WaitingOnTools;
    assert.ok(n >= 1, 'premise: chunks wait');
    assert.strictEqual(waiting.manager.isReady(), true);
    assert.strictEqual(waiting.manager.getPendingWork(), null);
    assert.deepStrictEqual(waiting.manager.getWaitingWork(), { waitingOn: 'tools', description: `${n} chunks wait on the host's tool definitions` });
    await waiting.manager.close();
  });

  it('a loop that ticks while the snapshot\'s queue lengths are above 0 ends, and the waiting chunks are counted apart', async () => {
    const { manager, snapshot } = await open();
    addToolBearing(manager);
    let ticks = 0;
    for (let s = snapshot(); s.l1QueueLength > 0 || s.mergeQueueLength > 0; s = snapshot()) {
      if (++ticks > 200) assert.fail('the warmup-shaped loop did not end');
      await manager.tick();
    }
    assert.ok(snapshot().l1WaitingOnTools >= 2);
    await manager.close();
  });

  it('a Fable-family summarizer\'s chunks and merges wait with no call while no tools are declared, and run once they are', async () => {
    const model = 'claude-fable-5-1';
    // Phase 1, tools declared: every closed chunk compresses and merges queue, not yet run.
    const first = await open({ model, mergeThreshold: 2 });
    first.manager.setToolDefinitions(TOOLS);
    addPlain(first.manager);
    for (let i = 0; i < 200 && first.snapshot().l1QueueLength > 0; i++) await first.manager.tick();
    assert.strictEqual(first.snapshot().l1QueueLength, 0, 'premise: the chunks compressed');
    assert.ok(first.snapshot().mergeQueueLength > 0, 'premise: a merge is queued');
    await first.manager.close();

    // Phase 2, reopened with no tools declared, as after a restart.
    const second = await open({ model, mergeThreshold: 2, keep: true });
    second.manager.addMessage('user', [t(`one more ${words(8)}`)]);
    await tickUntilReady(second.manager);
    const waiting = second.snapshot();
    assert.ok(waiting.mergesWaitingOnTools > 0, 'premise: the merge survived the reopen');
    assert.strictEqual(waiting.mergeQueueLength, 0);
    assert.strictEqual(second.calls.length, 0, 'no summarizer call before the host declares tools');
    assert.strictEqual(second.manager.getWaitingWork()?.waitingOn, 'tools');

    second.manager.setToolDefinitions(TOOLS);
    await tickUntilReady(second.manager);
    assert.ok(second.calls.length > 0, 'the merges run once tools are declared');
    assert.ok(second.calls.every((c) => Array.isArray(c.tools) && (c.tools as unknown[]).length === TOOLS.length));
    assert.strictEqual(second.snapshot().mergesWaitingOnTools, 0);
    await second.manager.close();
  });

  it('a chunk whose request carries no tool block, its call\'s partner being in another chunk, compresses with no tools', async () => {
    const { manager, strategy, snapshot } = await open();
    for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [t(`event ${i} ${words(8)}`)]);
    manager.addMessage('agent', [t(words(20)), { type: 'tool_use', id: 'call-2', name: 'fetch', input: { q: 'z' } } as ContentBlock]);
    manager.addMessage('user', [t(`meanwhile ${words(20)}`)]);
    manager.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-2', content: 'short result' } as ContentBlock]);
    for (let i = 0; i < 20; i++) manager.addMessage(i % 2 ? 'user' : 'agent', [t(`later ${i} ${words(8)}`)]);
    const chunks = (strategy as unknown as { chunks: Array<{ messages: Array<{ content: ContentBlock[] }> }> }).chunks;
    const holds = (type: string) => chunks.findIndex((c) => c.messages.some((m) => m.content.some((b) => b.type === type)));
    assert.ok(holds('tool_use') >= 0 && holds('tool_result') === holds('tool_use') + 1, `premise: the call ends one chunk and its result starts the next (${holds('tool_use')}, ${holds('tool_result')})`);
    await tickUntilReady(manager);
    assert.ok(snapshot().chunksCompressed > holds('tool_result'), 'both chunks compressed with no tools declared');
    await manager.close();
  });

  it('an auto-tick drain stops when only waiting work is left', async () => {
    const { manager, strategy } = await open({ autoTick: true });
    let ticks = 0;
    const tick = strategy.tick.bind(strategy);
    strategy.tick = (ctx) => { ticks++; return tick(ctx); };
    try {
      addToolBearing(manager);
      const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
      let seen = -1;
      for (let i = 0; i < 40 && seen !== ticks; i++) { seen = ticks; await settle(); }
      assert.strictEqual(seen, ticks, 'the drain settled');
      await settle();
      assert.strictEqual(ticks, seen, 'no tick after the drain settled');
      assert.strictEqual(manager.getWaitingWork()?.waitingOn, 'tools', 'premise: the work left waits on tools');
    } finally {
      await manager.close();
    }
  });

  it('a rebuild judges waiting chunks again: once a pin no longer keeps a call raw, they compress with no tools', async () => {
    // Phase 1, tools declared: the call's chunk compresses, then a pin keeps the call and its result raw.
    const first = await open();
    first.manager.setToolDefinitions(TOOLS);
    addToolBearing(first.manager);
    await tickUntilReady(first.manager);
    const ids = first.manager.getAllMessages().map((m) => m.id);
    const call = first.manager.getAllMessages().findIndex((m) => m.content.some((b) => b.type === 'tool_use'));
    const pin = first.manager.pinRange(ids[call]!, ids[call + 1]!);
    for (let i = 0; i < 12; i++) first.manager.addMessage(i % 2 ? 'user' : 'agent', [t(`after the pin ${i} ${words(8)}`)]);
    await first.manager.close();

    // Phase 2, reopened with no tools: the chunks after the pin carry the pinned call raw and wait.
    const second = await open({ keep: true });
    await tickUntilReady(second.manager);
    assert.ok(second.snapshot().l1WaitingOnTools >= 1, 'premise: a chunk after the pin waits on tools');
    second.manager.unpin(pin);
    second.manager.addMessage('user', [t(`a new message ${words(8)}`)]);
    await tickUntilReady(second.manager);
    assert.strictEqual(second.snapshot().l1WaitingOnTools, 0);
    await second.manager.close();
  });
});
