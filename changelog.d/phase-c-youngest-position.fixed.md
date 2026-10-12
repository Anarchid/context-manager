- kv-stable: the ideal cut no longer flaps a deep group at a band boundary.
  Two changes, measured together on a long-lived resident with `[fold-diff]`
  (2026-10-07..09: the group at the L2↔L3 boundary went L3→L2→L3 seven times
  in three days, each direction re-reading ~300k tokens; a fold confined to
  the seam cost ~97k) and on a carried-growth replay (1,296 base-6 leaves at
  50 raw / 100 recall, one appended leaf per turn, a summary every six, every
  frontier carried; 120 turns: no deep group is ever raised, total re-read
  20,000 vs 25,900 before; 400 turns: 13 turns change a band vs 40 before):
  - **Phase C** (spend headroom by un-folding toward the target) walks chunks
    youngest-first by **position**, whatever their level, and restarts from
    the youngest after every accepted un-fold, so the youngest group steps
    down L2→L1→raw before any older group is tried. It used to walk deepest
    level first (`for level = max..1 { youngest-first }`), which raised the
    youngest L3 group — the one right after the deep band — before any L1 at
    the seam.
  - **The ideal cut is seeded from the carried frontier**
    (`kvStableSeedFromCarried`, default `true`): phases A/B only deepen what
    is carried (same salience-then-oldest, level-by-level order) and only
    phase C un-folds. The from-scratch cut re-decided every band boundary
    from the current balance of production and growth, so a deep group was
    raised when a new mid-level summary landed and re-deepened when growth
    crossed W — and the dead-band hold could not keep it, because its
    relevance-gap check compared against that moving ideal. An inverted
    carried profile (a chunk deeper than an older unprotected chunk) is still
    lowered to the older level so the quality-gap self-heal keeps working;
    bootstrap is unchanged. `kvStableSeedFromCarried: false` restores the
    from-scratch ideal of design §13.4.
  Accept rule, group consistency, protections and the phase A/B fold order
  are unchanged. `kv-unified` is untouched.
