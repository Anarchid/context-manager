- `AutobiographicalStrategy` no longer loses a chunk whose compression it
  defers because the host hasn't declared its tool definitions. The chunk
  stays queued where it was, waiting on them, and ticks after the host
  declares them compress the waiting chunks in order, where before they
  waited for the next rebuild of the chunks (a new message, or a compile).
  Every later chunk whose request replays the deferred one waits the same way.
- Once ticks have judged the queued work since the last rebuild and found
  that only such waiting work is left, `isReady()` is true, so a loop that
  ticks until ready ends, and `getPendingWork()` is `null` as before. The new
  `ContextManager.getWaitingWork()` names the wait, with `waitingOn: 'tools'`
  and a description such as "4 chunks wait on the host's tool definitions";
  it is `null` when nothing waits. Once the host declares tools, `isReady()`
  is false until the work is done.
- `getProgressSnapshot()`'s `l1QueueLength` and `mergeQueueLength` leave out
  work waiting on tools, which the new `l1WaitingOnTools` and
  `mergesWaitingOnTools` count, so a loop that ticks while the queue lengths
  are above 0 ends once only waiting work is left.
- On a Fable- or Mythos-family compression model with no tools declared, a
  merge now waits for the host's tools as a chunk already did, rather than
  going out without them, and reads as waiting once a tick has asked about
  it. A merge that makes no call (a missing or parented source, one a summary
  hold or quarantine record keeps, a crossed merge) is still dropped, by a
  loop that ticks until ready too. Chunks the speculative cap holds behind a
  waiting merge count as waiting too.
- `KnowledgeStrategy`'s rebuild now supersedes a compression attempt in
  flight, as `AutobiographicalStrategy`'s does: a chunk the rebuild withdrew
  is not put back.
- `scripts/drain-autobiographical.ts` no longer reports a store drained while
  work waits on tools: it stops with `stopped: "waiting-on-tools"` and says to
  run it again with `--tools-log`. `scripts/migrate-llr.ts` prints what still
  waits after its drain.
