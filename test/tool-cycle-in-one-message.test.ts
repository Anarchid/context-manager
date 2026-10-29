import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeToolPairs, type ContentBlock, type NormalizeEvent } from '@animalabs/membrane';
import { ContextManager } from '../src/context-manager.js';
import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import { KnowledgeStrategy } from '../src/strategies/knowledge.js';
import type { CompileResult, ContextEntry } from '../src/types/context.js';

const made: string[] = [];
after(() => { for (const dir of made) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

const KV = { policy: { alpha: 0.7, budgetLowRatio: 0.6, budgetHighRatio: 0.85, budgetUnderLambda: 1_000, budgetOverLambda: 4_000, cacheLambda: 1, cacheScale: 100_000, cacheReadPrice: 0.1, cacheWritePrice: 2, continuityLambda: 1, continuityScale: 100_000, continuityRecencyHalfLifeTokens: 100_000, continuityRecencyFloor: 0.2, continuityStableHalfLife: 16, continuityStableFloor: 0.25 }, tokenBucketSize: 50_000, continuityBucketSize: 50_000, fidelityBucketSize: 100_000, labelCeiling: 100_000, adoptEpsilon: 3_000, treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false, hysteresisCertificate: true };
const selects = {
  hierarchical: { adaptiveResolution: false },
  'kv-unified': { adaptiveResolution: true, foldingStrategy: 'kv-unified', kvUnified: KV },
  'flat-profile': { adaptiveResolution: true, foldingStrategy: 'flat-profile' },
  'Knowledge, hierarchical': { adaptiveResolution: false, knowledge: true },
} as const;

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const call = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'look', input: { path: `${id}.md` } } as ContentBlock);
const said = (id: string): string => `RESULT ${id}: the file says hello`;
const result = (id: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: [{ type: 'text', text: said(id) }] } as ContentBlock);

type Stored = Array<[participant: string, content: ContentBlock[]]>;

async function compileOf(select: keyof typeof selects, stored: Stored, config: Record<string, unknown> = {}): Promise<{ compiled: CompileResult; ids: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'tool-cycle-in-one-message-'));
  made.push(dir);
  const { knowledge, ...options } = { knowledge: false, ...selects[select] };
  const settings = { autoTickOnNewMessage: false, headWindowTokens: 0, recentWindowTokens: 1_000_000, ...options, ...config } as ConstructorParameters<typeof AutobiographicalStrategy>[0];
  const strategy = knowledge ? new KnowledgeStrategy(settings) : new AutobiographicalStrategy(settings);
  const manager = await ContextManager.open({ path: join(dir, 'store'), strategy });
  try {
    const ids = stored.map(([participant, content]) => manager.addMessage(participant, content));
    return { compiled: await manager.compile({ maxTokens: 200_000, reserveForResponse: 0 }), ids };
  } finally {
    await manager.close();
  }
}

// membrane 0.8.0's normalizer builds the provider's turns from these messages: it moves tool_use blocks to an
// assistant turn and tool_result blocks to a user turn (normalize-tool-pairs.ts). These cases rely on that
// re-role for a user message that holds a call. Where a call has no result it stands in for one, and a result
// with no call of its own it rewrites as text; those are the repairs counted here.
const REPAIRS = new Set<NormalizeEvent['kind']>(['synthetic_pending_result', 'orphan_tool_result_textified', 'stray_tool_result_textified']);
function sentByMembrane(compiled: CompileResult): { sent: string; repairs: NormalizeEvent[] } {
  const repairs: NormalizeEvent[] = [];
  const { messages } = normalizeToolPairs(
    compiled.messages.map((m) => ({ role: m.participant.toLowerCase() === 'user' ? 'user' : 'assistant', content: m.content })) as never,
    { onEvent: (event) => { if (REPAIRS.has(event.kind)) repairs.push(event); } },
  );
  return { sent: JSON.stringify(messages), repairs };
}

const STUB = "isn't shown in this context";

for (const select of Object.keys(selects) as Array<keyof typeof selects>) {
  describe(`a message holding a tool call and its result, raw in a ${select} compile`, () => {
    for (const [role, participant] of [['an assistant', 'Claude'], ['a user', 'User']] as const) {
      for (const where of ['mid-conversation', 'last'] as const) {
        it(`${role} message ${where} is sent with its own result, and membrane has nothing to repair`, async () => {
          const stored: Stored = [
            ['User', [text('Please look at the file.')]],
            [participant, [text('Let me look.'), call('look-1'), result('look-1'), text('It says hello.')]],
          ];
          if (where === 'mid-conversation') {
            if (participant === 'User') stored.push(['Claude', [text('Thanks for that.')]]);
            stored.push(['User', [text('Thanks.')]], ['Claude', [text('Any time.')]]);
          }
          const { compiled, ids } = await compileOf(select, stored);
          assert.equal(compiled.messages.at(-1)!.content.some((b) => b.type === 'text' && b.text === (where === 'last' ? 'It says hello.' : 'Any time.')), true, 'the premise: the message is where the title says');
          const { sent, repairs } = sentByMembrane(compiled);
          assert.ok(sent.includes(said('look-1')), sent);
          assert.ok(!sent.includes(STUB), sent);
          assert.deepEqual(repairs, []);
          const bodies = compiled.provenance!.messages.flatMap((m) => (m.kind === 'raw' ? m.bodies : []))
            .filter((b) => b.messageId === ids[1]);
          assert.ok(bodies.length > 0 && bodies.every((b) => b.complete), JSON.stringify(bodies));
        });
      }
    }

    it("an assistant message's call that its own results don't answer is answered beside them, and the result that is there is sent", async () => {
      const { compiled } = await compileOf(select, [
        ['User', [text('Please look at both files.')]],
        ['Claude', [text('Let me look.'), call('look-1'), call('look-2'), result('look-1'), text('One says hello.')]],
        ['User', [text('Thanks.')]],
      ]);
      const { sent, repairs } = sentByMembrane(compiled);
      assert.ok(sent.includes(said('look-1')), sent);
      assert.ok(sent.includes(STUB), sent);
      assert.deepEqual(repairs, []);
    });

    it('a message holding two cycles is sent with both results, each after its own call, in order', async () => {
      const { compiled } = await compileOf(select, [
        ['User', [text('Please look at both files.')]],
        ['Claude', [text('First.'), call('look-1'), result('look-1'), text('Then.'), call('look-2'), result('look-2'), text('Both say hello.')]],
        ['User', [text('Thanks.')]],
      ]);
      assert.deepEqual(compiled.messages.map((m) => [m.participant, m.content.map((b) => b.type)]), [
        ['User', ['text']],
        ['Claude', ['text', 'tool_use']],
        ['user', ['tool_result']],
        ['Claude', ['text', 'tool_use']],
        ['user', ['tool_result']],
        ['Claude', ['text']],
        ['User', ['text']],
      ]);
      const { sent, repairs } = sentByMembrane(compiled);
      assert.ok(sent.includes(said('look-1')) && sent.indexOf(said('look-1')) < sent.indexOf(said('look-2')), sent);
      assert.ok(!sent.includes(STUB), sent);
      assert.deepEqual(repairs, []);
    });

    it("a message whose results answer none of its calls has each call answered, and membrane has nothing to repair", async () => {
      const { compiled } = await compileOf(select, [
        ['User', [text('Please look at the file.')]],
        ['Claude', [text('Let me look.'), call('look-1'), result('look-9'), text('It says hello.')]],
        ['User', [text('Thanks.')]],
      ]);
      const { sent, repairs } = sentByMembrane(compiled);
      assert.ok(sent.includes('"look-1"') && sent.includes(STUB), sent);
      assert.ok(!sent.includes('[tool call omitted]'), sent);
      assert.deepEqual(repairs, []);
    });

    it('a result that answers its call past another result in its own message is sent with it', async () => {
      for (const content of [
        [text('Let me look.'), call('look-1'), result('look-9'), text('Again.'), result('look-1'), text('It says hello.')],
        [text('Let me look.'), call('look-1'), call('look-2'), result('look-1'), text('Again.'), result('look-2'), text('Both say hello.')],
      ]) {
        const { compiled } = await compileOf(select, [
          ['User', [text('Please look at the files.')]],
          ['Claude', content],
          ['User', [text('Thanks.')]],
        ]);
        const { sent, repairs } = sentByMembrane(compiled);
        for (const id of content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []))) assert.ok(sent.includes(said(id)), sent);
        assert.ok(!sent.includes(STUB), sent);
        assert.deepEqual(repairs, []);
      }
    });

    it("under toolResultMaxLastN: 0, a message's own result is replaced with the tool's marker", async () => {
      const { compiled } = await compileOf(select, [
        ['User', [text('Please look at the file.')]],
        ['Claude', [text('Let me look.'), call('look-1'), result('look-1'), text('It says hello.')]],
        ['User', [text('Thanks.')]],
      ], { toolResultMaxLastN: 0 });
      const { sent, repairs } = sentByMembrane(compiled);
      assert.ok(sent.includes("[result of tool 'look' left out: this context shows none of its results]"), sent);
      assert.ok(!sent.includes(said('look-1')), sent);
      assert.ok(!sent.includes(STUB), sent);
      assert.deepEqual(repairs, []);
    });

    it('a call and its result stored in messages of their own are sent as stored', async () => {
      const { compiled } = await compileOf(select, [
        ['User', [text('Please look at the file.')]],
        ['Claude', [text('Let me look.'), call('look-1')]],
        ['User', [result('look-1')]],
        ['Claude', [text('It says hello.')]],
      ]);
      assert.deepEqual(compiled.messages.map((m) => [m.participant, m.content.map((b) => b.type)]), [
        ['User', ['text']],
        ['Claude', ['text', 'tool_use']],
        ['User', ['tool_result']],
        ['Claude', ['text']],
      ]);
      const { sent, repairs } = sentByMembrane(compiled);
      assert.ok(sent.includes(said('look-1')), sent);
      assert.deepEqual(repairs, []);
    });
  });
}

class Exposed extends AutobiographicalStrategy {
  repair(entries: ContextEntry[]): void {
    this.enforceToolPairing(entries);
  }
}

describe("pairing repair's look-ahead for a displaced result", () => {
  it('counts a message holding cycles as one entry, so a result five entries on still reaches its call', () => {
    const entry = (id: string, participant: string, content: ContentBlock[]): ContextEntry =>
      ({ sourceMessageId: id, participant, content } as ContextEntry);
    const entries = [
      entry('m0', 'Claude', [call('look-x')]),
      entry('m1', 'User', [text('Busy.')]),
      entry('m2', 'Claude', [call('look-a'), result('look-a'), text('a'), call('look-b'), result('look-b'), text('b'), call('look-c'), result('look-c'), text('c')]),
      entry('m3', 'User', [text('Go on.')]),
      entry('m4', 'Claude', [text('Going.')]),
      entry('m5', 'User', [text('Still busy.')]),
      entry('m6', 'User', [result('look-x')]),
    ];
    new Exposed({ autoTickOnNewMessage: false } as ConstructorParameters<typeof AutobiographicalStrategy>[0]).repair(entries);
    assert.deepEqual(entries[1]!.content, [result('look-x')], 'the real result is moved next to its call');
    assert.ok(!JSON.stringify(entries).includes(STUB), JSON.stringify(entries));
  });
});
