# Context Reference

This directory now keeps only implementation-near references that still belong
in the public `effect-utils` repo.

Cross-repo policy, requirements, and alignment specs are maintained outside
this repo. The docs here should explain package behavior, examples, and local
implementation details.

## Kept Here

- [megarepo/](./megarepo/) - VRS for the megarepo tool (`mr`): repo
  arrangement, workspace ownership, ontology, and decision records
- [Megarepo Spec](../packages/@overeng/megarepo/docs/spec.md) - package-local
  reference for commands, config, and integrations
- [dependency-materialization/](./dependency-materialization/) - local pnpm,
  projection, Nix prepared dependency, store authority, Buck2 evidence, and
  observability contracts
- [content-address/](./content-address/) - VRS for reusable
  content-addressed descriptors, stores, resolvers, and artifact URIs
- [CI Measurements](./ci-measurements.md) - measurement classes, evidence
  contracts, gate semantics, and lane cadence
- [CI Measurement Engine](./ci-measurement-engine.md) - typed engine boundary,
  commands, schemas, and adoption state
- [CI Measurement Experiments](./ci-measurement-experiments.md) - experiment
  records and rejected approaches
- [effect/](./effect/) - Effect socket examples and related package files
- [opentui/](./opentui/) - OpenTUI integration example
- [npm-release/](./npm-release/) - VRS for verifying that an npm registry
  actually serves what a release published (version, tarball digest, dist-tag)
- [otel.md](./otel.md) - OpenTelemetry notes
- [otel-scrape/](./otel-scrape/) - VRS for wrapping build/dev tools into
  OTEL spans, events, metrics, and profile links
- [oxc-config/](./oxc-config/) - OXC configuration docs
- [workarounds/](./workarounds/) - historical tool issue notes
- [workflows/](./workflows/) - local consistency/update workflow notes
- [wishlist.md](./wishlist.md)
