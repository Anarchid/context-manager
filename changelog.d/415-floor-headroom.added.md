- `RenderStats.planVsActual` gains `floorTokens`, `hardBudget` and
  `queuedReliefTokens` on adaptive compiles (#415), logged as `floor=`,
  `hardBudget=` and `queuedRelief=` on the `[plan-vs-actual]` line. The
  floor is the cheapest plan the summaries held allow, head and tail
  included, whatever the folding strategy picked; a compile refuses once its
  plan passes `hardBudget`, so `hardBudget - floorTokens` is how far the store
  is from its first refusal. `queuedReliefTokens` is what the queued L1s and
  merges are expected to take off the floor once they land; a chunk the
  compression quarantine holds, and a merge holding a source a hold or a
  merge-quarantine record keeps out, count as zero, since tick won't turn
  them into summaries.
- `OverBudgetDiagnostics` gains `floorTokens` and `queuedReliefTokens` on
  adaptive refusals, and the refusal's message ends with `floor=` and
  `queued relief=`. A floor at or under the budget means the refusal isn't
  for want of summaries, since a plan that fits exists; a floor still over
  the budget once the queued relief is taken off means draining the queue
  alone won't clear it.
