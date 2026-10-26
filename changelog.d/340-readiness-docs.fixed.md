- Docs: `ContextManager.compile()`'s doc said it may block if the strategy
  has pending work, and the docs of `ContextManager.isReady()`,
  `ReadinessState.ready` and `ContextStrategy.checkReadiness()` described
  readiness as whether `compile()` would block or could proceed. At 0.22.0
  as now, `compile()` awaits nothing: it doesn't wait for the strategy's
  background work, and compiles from what's there. The docs now say so, and
  say that readiness is only whether that work is pending. Nothing a caller
  meets at run time changes.
