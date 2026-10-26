- A run of summaries that can't grow, cut off from the newest end of its
  level by a hole such as a chunk the summarizer refused, a quarantined merge
  or an operator hold, now merges in groups that leave no summary of it alone
  (#334). Seven at the default `mergeThreshold` of 6 merge as four and three.
  The first six used to merge and leave the seventh alone at its level for
  good, which could strand a summary above it too. Such a run also merges at
  two whatever else is unmerged at its level. It used to wait until
  `mergeThreshold` summaries were unmerged anywhere at the level, which above
  L2 could take a long time. As before, a run is cut off when another run of
  its level comes after it, or a held summary of its level ends after it.
- The newest run of a level, and a run waiting for a retried chunk or merge to
  fill the hole after it, now take one fewer than `mergeThreshold` where
  taking `mergeThreshold` would leave a single summary behind (seven at 6
  merge five and leave two to grow), and merge whole where one fewer would be
  a group of one (three at a threshold of 2). So a run read as one that grows
  that then doesn't, such as the newest run of a level with a summary of a
  higher level after it, leaves none or two or more of it, never one alone.
- A picker's request for a merge at L2 and up (`enqueueMergeForRange`, which
  subclasses can call) now queues the largest of the merge check's groups,
  the shorter rest of a run that grows counted as one, that holds a summary
  reaching into the requested range, and the group can reach past the range.
  So a request naming one summary's own range, as `flat-profile` and
  `oldest-first` make, queues the group that holds it (#338). It used to take
  only the summaries reaching into the range, then the first `mergeThreshold`
  of their longest run: one summary's range queued nothing, and a range over
  part of a run could leave a remainder alone.
- The L1 holdback (`l1HoldbackChunks`) now keeps back the chunks whose
  messages come last in the store, not the last chunk records. A chunk cut
  later over messages a rebuild released is a late record among older
  messages: it was held back as the newest, and with no new message, as in a
  drain, it never compressed.
- `getCompressionDebt()`'s `pendingChunks` left out the last chunk record,
  whatever `l1HoldbackChunks` was. With a holdback of 2 or more, each chunk
  kept back beyond the first counted as pending, and aged the report
  towards "degraded" while it waited for a newer chunk to close; at 0, the
  newest closed chunk, queued at close, didn't count while it waited; and a
  kept-back chunk a fold demanded, queued all the same, didn't count. It now
  leaves out the chunks the holdback keeps back, by the same ranking, unless
  a fold demanded one: those residents report fewer pending chunks at a
  holdback of 2 or more and one more at 0, and the report's state follows,
  so at 0 the newest chunk's age counts towards "degraded". A drain for
  such a resident can finish, unless a chunk is kept from compression by a
  held message or an overlap block, which counts as before; and at 0 it
  doesn't finish with that chunk uncompressed. KnowledgeStrategy, whose chunker queues every chunk at
  close, keeps nothing back, so its report counts its newest closed chunk
  while it waits.
- `drain-autobiographical` ended with an uncaught error at a tick that threw,
  such as one whose provider call failed, and printed no finish line. It now
  ends there with a finish line that says what is left and the error
  (`tickError`), and exits 1.
- A store holding a run these rules group differently, such as an interior
  pair that waited for the level-wide count, merges it at its next merge
  check, which rewrites the request once from where the merged summary
  renders, if the plan uses it. A summary already left alone stays alone
  until what stands beside it lets it merge, or a rebuild gives it
  partners. Where the old split left a summary
  beside an operator hold, the held summary could join it once the hold
  lifted; the even split leaves none, so a summary whose hold lifts there
  stays alone at its level, as `mergeHoldSummaryIds` allows. A
  `mergeThreshold` below 2 queues what it did before (#285).
- As before, a live store can still leave a summary alone by timing around a
  hole: a run merges beside a chunk that hasn't compressed yet, after a
  restart or a quarantine's clear, and is then cut off from that chunk's
  summary; or a newest run of one stands before a chunk quarantined later or
  a hold placed later. Such a summary costs its tokens until what stands
  beside it lets it merge, or a rebuild;
  `getStrandedSummaries()` lists it, and `repair-topology --mode rebuild`
  gives it partners.
