- A store with no calibration record, or a record with no finite
  multiplier, starts from a provisional 1, as a discard's restart does
  (#328). Its first sample inside the calibration band sets the multiplier,
  declared or not: one sample, without the two-sample hold. Learned, a 1
  stepped a fifth of the way per undeclared sample (nine applied changes,
  each a reprice of every message and summary, to reach a true 1.4), and
  took two declared samples, the first held. Until that
  sample, render stats report `calibration.provisional: true`. A record
  from a newer pricing epoch, or a read of the record that throws, still
  loads 1 as before, not provisional.
