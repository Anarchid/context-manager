- **Hosts on membrane 0.9.0:** context-manager asked for
  `@animalabs/membrane` `^0.8.0` and now accepts `^0.8.0 || ^0.9.0`, so npm
  installs one copy, shared with context-manager, for a host on either
  version. Before, a host on 0.9.0 got a second membrane installed for
  context-manager: TypeScript refused the host's `Membrane` where
  context-manager takes one ("Type 'import("…/membrane").Membrane' is not
  assignable to type 'import("…/membrane").Membrane'", TS2322). A host on
  0.8 changes nothing. For a host with no membrane dependency of its own,
  the range now admits 0.9.0, npm's `latest`, as well as 0.8.
  - **Unchanged:** context-manager's own code, which uses nothing membrane
    0.9.0 adds. For the requests compared, through the Anthropic,
    OpenRouter and an OpenAI-compatible adapter, with a system prompt, an
    image, a tool call and its result and a cache breakpoint, and with
    thinking, by `complete()`, `stream()` and `streamYielding()`, membrane
    0.9.0 sent the same method, path, body and headers as 0.8.0 in all 36
    cases, leaving out `host`, `content-length`, `connection` and the SDK's
    retry-count and timeout headers.
  - The lockfile now installs 0.9.0, so this release's tests run on it; the
    same code ran on 0.8.0 before this change. membrane 0.9.0's own changes
    reach context-manager's calls when the host's `Membrane` is 0.9;
    membrane's changelog for 0.9.0 says what they are.
