- `reportRealInputTokens(realTotal, overhead?)` takes what the request sent
  besides the window, `{ system, tools }` (`RequestOverhead`), and prices it
  into the estimate the provider's total is compared with (#323). The
  provider counts the system prompt and the tool schemas and the compile
  estimate doesn't, so a tool-heavy agent's multiplier learned its schemas
  as a per-token rate and folded history the budget had room for, or sat at
  1.00 rejecting every sample as out of band. A caller that passes nothing
  gets the old comparison, plus the compile's message-position injections
  (below).
- With the overhead declared, three out-of-band calibration samples in a row
  whose implied multipliers agree within 10% of the first are learned,
  outright, at the clamp edge, instead of being rejected for good. At 1.00
  the ratio and the implied multiplier are the same number, so a store whose
  true ratio was past 1.8, where every pricing-epoch discard restarts, could
  never learn. Undeclared samples are rejected as before, and the rejection
  line says the caller may be leaving out the system prompt and tools it
  sends.
- The sample also counts the compile's message-position injections
  (`beforeUser` and `afterUser`), which the request carries and the window
  estimate doesn't: `ContextManager.compile` passes their content to the
  select as `SelectOptions.messageInjections`, and the select prices it with
  the window. Left out, an agent whose injections are large beside its window
  learned them as a per-token rate, or, with the overhead declared, at the
  clamp.
- **Host operators:** a multiplier learned before the caller declared its
  overhead holds that overhead. Inside the calibration band, the first two
  samples that declare it replace the multiplier with their mean when they
  agree within 10%, and the EMA steps as before when they don't; either way
  the record then carries `declaredOverhead: true`, so later declared
  samples step by the EMA. (Out of the band, the three-sample run above
  applies.) The first of the two is held in memory, so a restart between
  them costs one more sample. An undeclared sample that moves the multiplier
  writes the record without the flag. A store whose multiplier puts every
  compile over budget gets no sample to move it, as before: to unwedge it,
  seed the record as provisional on the stopped store, and the refused
  compile drops it to 1: `setStateJson('<ns>/autobio:calibration',
  { multiplier, at, pricing: <current epoch>, provisional: true })`.
  `RequestOverhead` is exported from the package.
