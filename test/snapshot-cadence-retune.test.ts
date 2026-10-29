/**
 * Snapshot-cadence retune on existing stores (2026-08-01).
 *
 * Chronicle persists state registrations in state.bin, so the cadence
 * numbers in MessageStore.register only ever applied to NEW stores —
 * existing stores stayed pinned to their first-registration values
 * forever (Mythos: full_snapshot_every=10 -> a full copy of the entire
 * message history every ~500 appends; 57% of the last GB of its log).
 *
 * Contract pinned here:
 *   - ContextManager.open on a store whose messages state was registered
 *     with the OLD cadence retunes it to the current constants via
 *     chronicle's updateStateStrategy (0.3.0+).
 *   - The retune only touches scheduling: message content is unaffected.
 *   - On chronicle builds without updateStateStrategy, open still works
 *     (feature-detected; old cadence simply remains).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore } from '../src/message-store.js';
import { ContextManager } from '../src/context-manager.js';

function tmpStore(): { dir: string; store: JsStore } {
  // openOrCreate treats an existing directory as "open" (and then requires
  // a MANIFEST) — hand it a not-yet-existing subpath so it takes the
  // create branch.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-retune-')), 'store');
  const store = JsStore.openOrCreate({ path: dir });
  return { dir, store };
}

describe('snapshot cadence retune', () => {
  it('an open retunes a message slot registered under another cadence to the current one', async () => {
    const { store } = tmpStore();
    const current = MessageStore.registrationFor();
    store.registerState({ id: current.id, strategy: 'append_log', deltaSnapshotEvery: 10, fullSnapshotEvery: 10 });
    assert.strictEqual(typeof (store as unknown as { updateStateStrategy?: unknown }).updateStateStrategy, 'function', 'premise: this chronicle can retune a registration');
    const manager = await ContextManager.open({ store });
    for (let i = 0; i < 15; i++) manager.addMessage('test', [{ type: 'text', text: `m${i}` }]);
    manager.close();
    const slot = store.listStates().find((state) => state.id === current.id);
    assert.ok((slot?.opsSinceSnapshot ?? 0) >= 10, `no snapshot at 10 appends, as the registered cadence would take: ${JSON.stringify(slot)}`);
    assert.strictEqual((store.getStateJson(current.id) as unknown as unknown[]).length, 15, 'every message is kept');
    store.close();
  });

  it('register refuses a second registration of the message state rather than replacing it', () => {
    const { store } = tmpStore();
    MessageStore.register(store);
    assert.throws(() => MessageStore.register(store));
  });
});
