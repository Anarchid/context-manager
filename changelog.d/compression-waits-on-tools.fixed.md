- `AutobiographicalStrategy` no longer loses a chunk whose compression it
  defers because the host hasn't declared its tool definitions. The chunk
  stays queued, waiting on them, and ticks after the host declares them
  compress it, where before it waited for the next rebuild of the chunks (a
  new message, or a compile). Every later chunk that defers behind it waits
  the same way.
- While only such waiting work is left, `isReady()` is true, so a loop that
  ticks until ready ends, and `getPendingWork()` is `null` as before. The new
  `ContextManager.getWaitingWork()` names the wait, with `waitingOn: 'tools'`
  and a description such as "4 chunks wait on the host's tool definitions";
  it is `null` when nothing waits. Once the host declares tools, `isReady()`
  is false until the work is done.
- `getProgressSnapshot()`'s `l1QueueLength` and `mergeQueueLength` count only
  what a tick can take now. The new `l1WaitingOnTools` and
  `mergesWaitingOnTools` count the work waiting on tools, so a loop that
  ticks while the queue lengths are above 0 ends as before.
- On a Fable- or Mythos-family compression model with no tools declared, a
  merge now waits for the host's tools as a chunk already did, rather than
  going out without them.
