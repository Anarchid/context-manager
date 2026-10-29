- `AutobiographicalStrategy` no longer loses a chunk whose compression it
  defers because the host hasn't declared its tool definitions. The chunk
  stays queued where it was, waiting on them, and ticks after the host
  declares them compress the waiting chunks in order, where before they
  waited for the next rebuild of the chunks (a new message, or a compile).
  Every later chunk whose request replays the deferred one waits the same way.
- Once ticks have found that only such waiting work is left, `isReady()` is
  true, so a loop that ticks until ready ends, and `getPendingWork()` is
  `null` as before. The new `ContextManager.getWaitingWork()` names the wait,
  with `waitingOn: 'tools'` and a description such as "4 chunks wait on the
  host's tool definitions"; it is `null` when nothing waits. Once the host
  declares tools, `isReady()` is false until the work is done.
- `getProgressSnapshot()`'s `l1QueueLength` and `mergeQueueLength` leave out
  work waiting on tools, which the new `l1WaitingOnTools` and
  `mergesWaitingOnTools` count, so a loop that ticks while the queue lengths
  are above 0 ends as before.
- On a Fable- or Mythos-family compression model with no tools declared, a
  merge now waits for the host's tools as a chunk already did, rather than
  going out without them; a merge that makes no call (a missing, parented,
  held or crossed source) is still dropped. Chunks the speculative cap holds
  behind such a merge count as waiting too.
