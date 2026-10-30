- `RenderStats.planVsActual` gains `floorTokens`, `hardBudget` and
  `queuedReliefTokens` on adaptive compiles (#415), logged as `floor=`,
  `hardBudget=` and `queuedRelief=` on the `[plan-vs-actual]` line. The
  floor is the cheapest plan the summaries held allow, head and tail
  included, whatever the folding strategy picked; a compile refuses once its
  plan passes `hardBudget`, and every plan does once the floor does, so
  `hardBudget - floorTokens` is how far the store is from the point where
  every compile refuses. `queuedReliefTokens` is what the queued L1s and
  merges are expected to take off the floor once they land. Work tick won't
  turn into a summary counts as zero: a chunk the compression quarantine
  holds or deferred for the host's tools, every chunk from the first a
  compression hold reaches, a merge holding a source a hold or a
  merge-quarantine record keeps out, and every merge from the first a hold
  blocks. Under `kv-unified` the floor takes that solver's own constraints,
  locks included, and is exact. The other folding strategies give pins
  precedence over locks in ways those constraints don't follow, so there the floor
  counts no lock and is a lower bound: over the budget, every compile still
  refuses; at or under it, a plan fits only where no lock holds a message
  above its cheapest form. A floor that can't be computed leaves the fields
  out and is said once per cause, and once more by each load that meets it,
  as `[autobiographical] floor not computed`.
- `OverBudgetDiagnostics` gains `floorTokens` and `queuedReliefTokens` on
  the adaptive refusals that come once the plan is made, when its floor was
  computed, and the refusal's message then names them as `floor=` and
  `queued relief=`. The refusal for a head and tail that alone exceed the
  budget comes before the plan, so it carries neither. A floor at or under
  the budget means the refusal isn't for want of summaries, since a plan
  that fits exists (outside `kv-unified`, unless a lock holds a message
  above its cheapest form); a floor still over the budget once the queued
  relief is taken off means draining the queue alone isn't expected to clear
  it, the relief being an estimate.
