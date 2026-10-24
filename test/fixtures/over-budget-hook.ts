/**
 * Records what each refusal through `AutobiographicalStrategy`'s protected
 * `overBudgetError` hook was given, so a test can check that an override of
 * the hook still gets a library stage's words as `stage`, as it did before
 * `stageId`. Importing this wraps the hook for the importing test file.
 */
import assert from 'node:assert/strict';
import { AutobiographicalStrategy, OverBudgetError } from '../../src/index.js';

type HookOptions = { stage?: string; stageId?: string };

const given = new WeakMap<OverBudgetError, HookOptions>();
const proto = AutobiographicalStrategy.prototype as unknown as {
  overBudgetError(budget: unknown, opts: HookOptions): OverBudgetError;
};
const original = proto.overBudgetError;
proto.overBudgetError = function (this: unknown, budget: unknown, opts: HookOptions): OverBudgetError {
  const error = original.call(this, budget, opts);
  given.set(error, { stage: opts.stage, stageId: opts.stageId });
  return error;
};

/**
 * `error` is an `OverBudgetError` naming `stageId`. A refusal of
 * `AutobiographicalStrategy`'s (any but passthrough's and windowed
 * passthrough's) came through the hook, which was given that id and the
 * words that open its message, or, for the picker's own refusal, neither, as
 * before.
 */
export function assertStage(error: unknown, stageId: string): void {
  assert.ok(error instanceof OverBudgetError, String(error));
  assert.equal(error.stageId, stageId);
  const hook = given.get(error);
  if (stageId.startsWith('windowed-') || stageId.startsWith('passthrough-')) return;
  assert.ok(hook !== undefined, `${stageId}: the refusal came through the hook`);
  if (stageId === 'picker-exhausted') {
    assert.deepEqual(hook, { stage: undefined, stageId: undefined }, 'the picker\'s refusal gives the hook no stage');
    return;
  }
  assert.equal(hook.stageId, stageId);
  assert.ok(
    typeof hook.stage === 'string' && error.message.startsWith(`${hook.stage} but `),
    `the hook was given the words that open the message: ${String(hook.stage)} / ${error.message.slice(0, 80)}`,
  );
}
