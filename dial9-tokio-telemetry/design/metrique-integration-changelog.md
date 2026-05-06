# Metrique integration: changelog

**This document is deleted as part of PR sign-off. Keeper docs are `metrique-integration.md` and (indirectly) `docs/entry-descriptors.md` in the metrique repo.**

This summarises what changed in the design across rounds of review and why.

## Headline change in round 3 (current)

Scoped down: the source system (typed structural extraction of `Dial9Context` via `SourceTag` and `desc.source::<Dial9>()`) moves from the in-scope v1 design to a deferred appendix on the metrique side. Dial9 reads context from `Dial9Context` fields flattened into the user's entry and marked with a `Dial9ContextField` field tag. Binary-wide "sink attached, no dial9-compatible structs in this binary" discovery also moves to deferred; first-use per-descriptor validation is the only validation path in the initial release.

Rationale: rcoh flagged the source system as "a lot of new traits" for an N=1 consumer. Offline decision was to ship the minimum scope that unblocks dial9 (descriptor + field tags + `no_write`) and re-open the source system when a second consumer (OTEL, richer dial9 integration) pushes. The scope-down is additive on both sides: when the source system reopens, dial9's context capture migrates from "flattened + tag" to "typed source extraction" without a format change or a user-facing break.

## Headline change in round 2

Dial9 stopped doing runtime schema discovery. Metrique gained a static entry-descriptor system and a field-tag system for per-sink opt-in. Dial9 became a descriptor-aware sink.

The round-1 design was functional but could not structurally handle optional-field schema explosion or unbounded `Flex` keys. It also captured caller-thread context through a sink-wrapper that made dial9 a privileged sink in the composition.

## What changed, by area

### Schema discovery

Round 1: `Dial9Stream` walked `Entry::write` on every event, hashed `(name, field_type)` pairs into a shape fingerprint, and looked up or registered a dial9 schema in a bounded LRU cache.

Round 2: metrique emits an `&'static EntryDescriptor` per macro-derived entry. `Dial9Stream` keys its schema cache on the descriptor pointer. No fingerprinting, no LRU eviction, no thrash path. Hand-written entries return `None` for the descriptor and are skipped with a rate-limited report.

Round 3: cache keys on `DescriptorId` rather than raw `&'static` pointer. Macro path still produces static descriptors with stable ids; the shift leaves room for enum-per-variant (`Arc`-backed) descriptors without breaking the cache-key contract.

### Optional fields

Round 1: each observed optional combination registered a separate schema (up to 2^K for K optionals).

Round 2+: the descriptor marks optional fields structurally (`FieldShape::Optional`). One schema per entry type.

### `Flex`

Round 1: each distinct `Flex` key registered a new schema.

Round 2+: `Flex` lowers to `FieldShape::Flex { key, value }` in the descriptor and to a new typed dynamic-map wire type in `dial9-trace-format`. One schema per `Flex`-bearing entry type.

### `Vec` / `[T]` / `&[T]`

Round 1: fingerprinted as individual field types per observed concrete element type.

Round 2+: `FieldShape::List(inner)` in the descriptor and `FieldType::List(inner)` on the wire. One schema per list-bearing entry type. `Vec<Option<T>>` supported; deeper nesting falls through to `Opaque`.

### Caller-thread context

Round 1: `TokioContextSink` wrapped the outer sink and injected an `EntryConfig` carrying the captured context. Dial9 was effectively privileged in the composition.

Round 2: context lives in a `Dial9Context` metrique field. The field's constructor captures caller-thread state. Round-2 design extracted the closed snapshot via typed `desc.source::<Dial9>(..)` through the source system.

Round 3: same `Dial9Context` field; the dial9 sink reads context by walking the descriptor for fields tagged `Dial9ContextField` (a dial9-internal field-tag marker). The typed `desc.source::<Dial9>()` extraction path is deferred with the source system.

### Per-field opt-in

Round 1: every field emitted to EMF also emitted to dial9. No granular control.

Round 2+: dial9 defines `InTrace` as a field tag. Users opt fields in with `default_field_tag(InTrace)` at the struct level, or with `field_tag(InTrace)` at the field level, and opt out with the matching `skip(...)` form.

### String interning

Round 1: dial9 did not expose string interning to the metrique path.

Round 2+: `InternString` is a separate field tag. It is orthogonal to `InTrace`.

### Units

Round 1: units were stamped into field names (`latency_Microseconds`).

Round 2+: units stay first-class in the descriptor (`Option<Unit>` per field). Dial9 emits them as schema-level annotations. Fields with no unit cost zero bytes. This generalises to other per-field metadata (display hints, privacy, semantic conventions) without further format churn.

### Heterogeneous queues / `BoxEntry` erasure

Round 1: `TraceEvent`-ness could not survive `BoxEntry` erasure, which forced the design away from a compile-time path.

Round 2+: descriptor lookup goes through `Entry::descriptor()` as a defaulted method. `BoxEntry` forwards through its dyn-trait object. Descriptor-unaware sinks never call the method and pay nothing.

Round 3: the method lives on the existing `Entry` trait rather than on a separate `ErasedEntry` concept, per rcoh's review. Simpler.

### Startup-time discovery

Round 2: dial9 registered every descriptor declaring `source(Dial9)` via metrique's `SourceTag::register_descriptor` hook (backed by `linkme` internally). Empty registry at sink construction fired a warn.

Round 3: removed with the source system. No `linkme` dependency, no pre-main registration, no `.startup_discovery(false)` builder toggle. First-use per-descriptor validation is the only validation path.

### Validation

Round 1: no dial9-specific validation story.

Round 2: three-tier validation (compile-time intrinsic, startup-time empty-registry, first-use per-descriptor structural).

Round 3: two-tier (compile-time intrinsic, first-use per-descriptor). The startup-time tier is deferred with the source system. Diagnostics for soft misconfigurations (e.g. `InTrace` fields present with no `Dial9ContextField` fields) become rate-limited warns on the event path rather than startup panics.

### User API (sink composition)

Mostly unchanged across all rounds. Global (`attach_to_stream_with_dial9`), builder (`metrique_sink(...)`), and manual (`tee(emf, Dial9Stream::new(...))`) paths stay. The manual path no longer requires `TokioContextSink`.

### User API (entry definition)

New from round 2: `#[metrics(default_field_tag(...))]`, `#[metrics(field_tag(...))]`, `#[metrics(no_write)]`. `skip(T)` is an argument form of the tag attributes. These are general metrique features, not dial9-specific.

Dropped in round 3 (moved to deferred): `#[metrics(source(...))]`. Users writing dial9-bearing entries in round 3 attach `Dial9Context` via `#[metrics(flatten, field_tag(skip(InTrace)))]` rather than `#[metrics(source(Dial9))]`.

Round-1 entries are unchanged but do not produce dial9 traces. Users opt in by adding the tags and the `Dial9Context` field.

## Dependency on metrique

Round 3 depends on a metrique PR that adds the descriptor system (`EntryDescriptor`, `FieldDescriptor`, `FieldShape`, `DescriptorRef`, `DescriptorId`, `Entry::descriptor()`), field-tag attributes, and `no_write`. The dial9 PR cannot merge before the metrique PR lands on a released version.

Linked references:

- metrique entry-descriptor design: `docs/entry-descriptors.md` (added in [awslabs/metrique#282](https://github.com/awslabs/metrique/pull/282))
- metrique PR: [awslabs/metrique#282](https://github.com/awslabs/metrique/pull/282)

## Requirements: what changed

Round 1 targeted requirements stayed through rounds 2 and 3. Round 2 added explicit requirements that round 1 did not fully meet:

- Per-field opt-in at struct and field granularity.
- Optional-field schema stability (one schema regardless of optional combinations).
- `Flex` schema stability (one schema regardless of runtime keys).
- First-class units on the wire without field-name mangling.
- Entry-owned context capture, with dial9 as a peer sink.

Round 3 did not drop any requirements; it narrowed the mechanism used to satisfy entry-owned context capture (flatten+tag instead of typed source extraction).

## Alternatives that stayed rejected

- Compile-time `#[derive(TraceEvent)]` on metrique structs: rejected for the same reasons (`BoxEntry` erasure, plus the blanket/no-blanket dilemma on `TraceField` where either outcome is worse than reading a descriptor).
- Dial9 as a pure `Format`: rejected (capture timing).
- Wrapping metrique composition primitives: rejected (fragments ecosystem).
- Separate dial9-owned background thread: rejected (duplicates `BackgroundQueue`).
- Programmatic stats handle: still deferred.

## Alternatives that became the new baseline

- Static entry descriptor with explicit `FieldShape::Optional` / `Flex` / `List` entries (new in round 2, cleaned in round 3).
- Per-descriptor first-use validation (round 2, simplified further in round 3).
- `InTrace`/`InternString` field tags (new in round 2).
- `Dial9ContextField` tag + flatten for context capture (new in round 3, replacing round-2's typed source extraction).

## Open questions flagged in round-1 review, resolved

- Russell: "does this handle optional fields?" → yes, structurally, via `FieldShape::Optional`.
- Russell: "what we really want is 'tell me all the fields you can possibly produce'" → that is exactly what the descriptor does.
- Russell: "we may want an opt-in flag to make fields part of the dial9 record" → `InTrace` field tag.
- Russell: "we need to ensure there is a reasonable way to record context when the event starts" → `Dial9Context` field, flattened into the user entry.
- Russell: "we need to consider units" → schema-level annotation, no per-event overhead.
- Russell: "add a flag to `Flex` so callers know it's flexing" → `FieldShape::Flex` in the descriptor; typed dynamic map on the wire.
- Jess: "ok with runtime interpretation and heavier encoding on the runtime thread if we can meet the requirements?" → Round 2 moves the heavy lifting to metrique-compile-time descriptors; flush-thread work shrinks compared to round 1. Round 3 keeps the same.

## Open questions flagged in round-2 review, resolved

- Russell: "a lot of new traits ... go as simple as possible then expand when N=2 (otel?)" → Round 3 scope-down. `SourceTag`, `register_descriptor`, `desc.source::<C>()`, `linkme`-backed registration all move to deferred.
- Russell: "EntryDescriptor should probably include some concept of a canonical name" → added as `EntryDescriptor::name() -> Option<&'static str>`.
- Russell: "descriptor is on the `Entry` value itself right? consider relaxing the `'static` in favor of making it cheap-to-clone" → `DescriptorRef::Static | Shared(Arc)` with `DescriptorId` for cache keys. Macro path stays free; `Arc` path available for future enum-per-variant.
- Russell: "hm... why not add Descriptor onto the trait with a default `None` impl?" → `Entry::descriptor()` is the canonical path now. The separate `ErasedEntry` concept is dropped.
- Russell: "not really in practice ... best way around this is accessor methods like `.as_str()`" → descriptor structs have private fields with accessor methods (`.name()`, `.fields()`, etc.). `#[non_exhaustive]` stays on the enums.
- Russell: on lazy registration and `linkme` concerns → moot with the scope-down; no `linkme` dependency in round 3.
- Russell on Histogram/distribution: "simply omitting this is fine" → distribution-typed fields fall through to `FieldShape::Opaque` with a diagnostic. Deferred with the `DescribeValue` extension.
- Russell on annotations for `dial9.kpi`, `dial9.span.start`, etc. → same schema-annotation mechanism as units supports these; noted in future evolution.
- Glossary + English annotations on at-a-glance example → added in the metrique keeper.

yulnr's viewer-level questions (end timestamps, nesting two metrique events on one task) are deferred to the implementation PRs when there is something concrete to render; they do not change the design.
