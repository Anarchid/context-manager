- A store with no calibration record starts from a provisional 1, as a
  discard's restart does (#328): its first sample inside the calibration
  band sets the multiplier, declared or not, instead of stepping a fifth of
  the way per sample (nine applied changes, each a reprice of every message
  and summary, to reach a true 1.4). Until that sample, render stats report
  `calibration.provisional: true`. A record from a newer pricing epoch, or a
  read of the record that throws, still loads a learned 1.
