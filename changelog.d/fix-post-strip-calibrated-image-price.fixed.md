- Post-strip token estimates now subtract a stripped image at the store's
  calibrated price. `MessageStore.estimateTokens` prices every block as
  `round(raw × calibration)`, but `postStripEstimates` took the uncalibrated
  `tokenEstimate ?? 1600` (minus the placeholder) back off. With the
  calibration multiplier below ~0.995, an image-only message whose image had
  aged out of the live window came out NEGATIVE (e.g. 0.925: 1480 − 1591 =
  −111), and kv-unified's canonical-forest check rejected every compile with
  `chunk <id> has invalid raw cost -…` — a hard-down that could not heal,
  since calibration only updates after a successful call. Above 1.0 the same
  mismatch over-counted each stripped image (≈ 450 tokens at 1.28). Each
  per-message estimate is also clamped at zero.
