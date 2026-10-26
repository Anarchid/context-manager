- **Callers that construct a `Membrane` and pass it to context-manager:**
  context-manager now depends on `@animalabs/membrane` `^0.8.0` (was
  `^0.7.1`). If your own membrane stays on 0.7, npm installs a second copy
  for context-manager, and TypeScript refuses your `Membrane` where
  context-manager takes one ("Property 'abortOutcome' is missing …",
  TS2741). JavaScript isn't refused, but every call context-manager makes
  then hands context-manager's own membrane 0.8 formatter to your 0.7
  `Membrane`, a mix this release's tests don't cover.
  - **Migration:** take `@animalabs/membrane` `^0.8.0` alongside this
    release, so context-manager shares your copy. agent-framework passes
    its own `Membrane` to context-manager, so a host using agent-framework
    takes this release together with an agent-framework that depends on
    membrane `^0.8.0`.
  - **Unchanged:** context-manager's own code. This change moves only its
    membrane range.
