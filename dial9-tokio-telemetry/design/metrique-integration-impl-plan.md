# Metrique integration: implementation plan

**This document is deleted as part of PR sign-off. It captures what the implementation work looks like, in what order, in which files, and which design decisions each piece depends on.**

Status: as of this PR, nothing here is implemented. The dial9 work depends on [metrique#282](https://github.com/awslabs/metrique/pull/282). This plan exists so reviewers can evaluate whether the scope and sequencing are sound.

## Sequencing

Three tracks with explicit dependencies. Tracks run in parallel where the graph permits.

### Track A: metrique descriptor + field tag system

Prerequisite for Tracks B and C. Tracked separately in the metrique repo; see `metrique/docs/entry-descriptors-impl-plan.md` for the full sub-track breakdown (M-A descriptor + field tag types, M-B `Entry::descriptor()`, M-C macro + descriptor emission).

Dial9 pins to a metrique release that has M-A, M-B, and M-C shipped. Nothing in the current dial9 scope depends on a source system, `SourceTag` trait, or `register_descriptor` hook; those stay deferred in metrique.

### Track B: dial9 trace-format additions

Depends on nothing in Track A. Can start as soon as this design is approved.

- B1. Reserve a new top-level frame tag for schema annotations (e.g. `TAG_SCHEMA_ANNOTATIONS = 0x07`). No format version bump: old decoders halt on unknown tags, which matches our forward-compat posture. Ties to: dial9 keeper's "Trace format additions" section and review's Feasibility checks.
- B2. Add schema-level annotations: `FieldAnnotation { field_index, key, value }`, new annotation section in the schema frame, encoder/decoder support. Ties to: dial9 keeper's "Units" section.
- B3. Add typed list and map `FieldType` support. Two new variants: `List(FieldType)` and `Map { key: FieldType, value: FieldType }`, decoded by walking elements using the schema-bound types. Recursion is forbidden: neither `List` nor `Map` is valid as an element, `key`, or `value`. Encoder does not write per-element type tags; schema is the single source of truth. Covers metrique `Vec<T>` / `[T]` and `Flex<(String, T)>` in one variant each. Ties to: dial9 keeper's "Flex" and "Trace format additions → Typed lists and maps" sections.
- B4. Update decoder / `FieldValue` / `FieldValueRef` for the new variants.
- B5. Update the dial9 viewer to render annotations and typed lists/maps sensibly.
- B6. Regenerate the demo trace once the format is settled.

Parallelism within Track B: B1-B4 proceed together; B5-B6 come after B1-B4 stabilise.

### Track C: dial9 sink implementation

Depends on Track A (released metrique) and Track B (released trace-format).

- C1. `src/metrique/tags.rs`: `pub struct Dial9ContextField;`, `pub struct InTrace;`, `pub struct InternString;`. These are opaque marker types used for field tagging; no traits implemented beyond what metrique requires. Ties to: dial9 keeper's "User-facing API" and "Components → Dial9Context" sections.
- C2. `src/metrique/context.rs`: `Dial9Context` metrique struct with three fields (worker_id, task_id, monotonic_ns), each tagged `#[metrics(field_tag(Dial9ContextField))]`. `capture()` reads worker/task/monotonic. No `source(...)` attribute; users flatten this struct into their entry. Ties to: dial9 keeper's "Components → `Dial9Context`" section; review's "Context capture via a flattened metrique field" section.
- C3. `src/metrique/schema.rs`: build a `SchemaEntry` (with annotations) from an `EntryDescriptor`. Compute two index sets per descriptor: context-field indices (fields tagged `Dial9ContextField`) and payload-field indices (fields tagged `InTrace`). Cache keyed on `DescriptorId`. Ties to: dial9 keeper's "Components → Schema handling" section.
- C4. `src/metrique/writer.rs`: `Dial9EntryWriter` adapter walking `Entry::write` callbacks. Uses the cached index sets to route each `(name, value)` callback to either the event header (context), the payload encoder (InTrace with `FieldShape` dispatch), or skip. `InternString`-tagged fields have their string data routed through the dial9 string pool. Ties to: dial9 keeper's architecture diagram "inside Dial9Stream" block.
- C5. `src/metrique/stream.rs`: `Dial9Stream` implements `EntryIoStream::next`. Descriptor-aware fast paths; per-descriptor first-use validation; hand-written-entry skip with rate-limited log. Ties to: dial9 keeper's "Validation → First-use" section.
- C6. `src/metrique/builder.rs` + `src/metrique/mod.rs`: the three composition paths (global `attach_to_stream_with_dial9`, builder `metrique_sink`, manual `tee(emf, Dial9Stream::new(...))`). The manual path does not wrap the outer sink; caller-thread context capture is entirely in `Dial9Context`. Ties to: dial9 keeper's "User-facing API → Sink construction" section.
- C7. Documentation: dial9 README section on the new API shape, `Dial9Context` usage, and the flatten+skip pattern for integrating into a user struct.

Parallelism within Track C: C1-C5 can start concurrently once Track A is released. C6 depends on C1 and C5. C7 lags everything else.

There is no `.startup_discovery(..)` builder toggle, no `linkme` dependency, and no `register_descriptor` hook in this round. If metrique's deferred source system ships later, dial9 gains a binary-wide startup discovery path as an additive change.

### Testing (Track D)

Tests are authored alongside the code in each track.

- D1. Trace-format unit tests for schema annotations and typed lists/maps. Include a "silent truncation" test: an old-style decoder reading a trace with a new top-level tag returns cleanly at end-of-stream, without error. In Track B.
- D2. Descriptor round-trip: a user-space struct with optionals, `Flex`, lists, units, and tags (including `Dial9ContextField` and `InTrace`); assert the sink computes the expected context-field and payload-field index sets.
- D3. Caller-thread context extraction: caller captures `Dial9Context`, the entry flows through `BackgroundQueue`, flush-thread event header carries the captured worker/task/monotonic.
- D4. Heterogeneous queue: a `BoxEntrySink<BoxEntry>` with multiple struct types, each gets one schema and its own cached context/payload index sets.
- D5. First-use validation: descriptors that violate each check (`InTrace` on `Opaque`, `InternString` on non-string, `InTrace` fields with no `Dial9ContextField` context fields) trigger the documented diagnostic. Debug panics; release error/warn logs.
- D6. Hand-written entry observed in the event path triggers a rate-limited `tracing::warn!` once per distinct type id.
- D7. Panic isolation: a `Value::write` that panics drops the offending event without poisoning the flush thread.
- D8. End-to-end example in `examples/` producing a viewable trace with both runtime and metrique events. Last gate.

## Validation failure policy

- First-use descriptor-local checks for clearly-wrong descriptors (`InternString` on non-string, `Opaque` in `InTrace`): `debug_assert!` panic in debug, rate-limited `tracing::error!` in release.
- First-use descriptor-local checks for soft misconfigurations (`InTrace` fields with no `Dial9ContextField` context fields): rate-limited `tracing::warn!` keyed per descriptor in all builds. The event still encodes with UNKNOWN worker and a flush-thread timestamp.
- Hand-written entries observed in the event path: rate-limited `tracing::warn!` once per distinct type id.
- Panic inside `Value::write`: caught per entry, rate-limited `tracing::warn!`, flush-thread state preserved.

## Public APIs at the boundary

The shape reviewers are agreeing to. Exact signatures may shift during implementation.

### In metrique

```rust
// Descriptor types (see metrique/docs/entry-descriptors.md)
pub struct EntryDescriptor { /* private fields */ }
impl EntryDescriptor {
    pub fn name(&self) -> Option<&'static str>;
    pub fn fields(&self) -> &'static [FieldDescriptor];
}

pub struct FieldDescriptor { /* private fields */ }
impl FieldDescriptor {
    pub fn name(&self) -> &'static str;
    pub fn tags(&self) -> &'static [ResolvedFieldTag];
    pub fn shape(&self) -> FieldShape;
    pub fn unit(&self) -> Option<Unit>;
}

pub enum FieldShape { /* ... */ }
pub enum KnownShape { /* ... */ }
pub enum StringShape { /* ... */ }

pub struct DescriptorRef(/* private */);
impl DescriptorRef {
    pub fn as_ref(&self) -> &EntryDescriptor;
    pub fn id(&self) -> DescriptorId;
}

#[derive(Copy, Clone, PartialEq, Eq, Hash)]
pub struct DescriptorId(/* opaque */);

// Entry trait gains a defaulted method:
pub trait Entry {
    // existing methods ...
    fn descriptor(&self) -> Option<DescriptorRef> { None }
}

// Macro attributes
#[metrics(default_field_tag(T))]
#[metrics(default_field_tag(skip(T)))]
#[metrics(field_tag(T))]
#[metrics(field_tag(skip(T)))]
#[metrics(no_write)]
```

### In dial9

```rust
pub struct Dial9ContextField;
pub struct InTrace;
pub struct InternString;

#[metrics]
#[derive(Default)]
pub struct Dial9Context {
    #[metrics(field_tag(Dial9ContextField))]
    worker_id: WorkerId,
    #[metrics(field_tag(Dial9ContextField))]
    task_id: Option<TaskId>,
    #[metrics(field_tag(Dial9ContextField))]
    monotonic_ns: u64,
}

impl Dial9Context {
    pub fn capture() -> Self;
}

pub struct Dial9Stream { /* ... */ }
impl Dial9Stream {
    pub fn new(handle: &TelemetryHandle) -> Self;
}

pub fn metrique_sink(
    inner: impl EntryIoStream,
    handle: &TelemetryHandle,
) -> MetriqueSinkBuilder;

pub trait AttachDial9Ext {
    fn attach_to_stream_with_dial9(
        stream: impl EntryIoStream,
        handle: &TelemetryHandle,
    ) -> AttachHandle;
}
```

## Risks and mitigations

- **Metrique PR scope.** The descriptor work is non-trivial even after the round-3 scope-down. Mitigation: the metrique design doc is explicit about what is in scope; metrique reviewers can veto pieces before dial9 starts consuming. Dial9 side can be scoped down further if metrique ships a narrower initial API.
- **Format forward compatibility.** Additive extensions only; no format version bump. Old decoders halt at unknown tags, which means old viewers reading new traces will silently truncate at the first extension point. Mitigation: the viewer lives in-repo and updates with the format; users producing new traces update both together. Acceptable because the format is not widely distributed.
- **Caller-thread cost regression.** `Dial9Context::capture()` does a few thread-local reads plus `clock_monotonic_ns()`. Small fixed cost per entry; we will benchmark during implementation to confirm no measurable regression versus baseline metrique.
- **Validation sharpness without binary-wide discovery.** "Sink attached, no dial9-compatible structs in this binary" is not detected at startup in this round. Mitigation: first-use diagnostics fire when the first event flows; users notice during integration testing. When metrique's source system reopens, this check becomes available additively.
- **Context-field discovery by tag walking.** The sink walks the descriptor on first-use to find `Dial9ContextField`-tagged fields, then caches the index set. Tag-based discovery is slightly fuzzier than typed extraction (a future rename of `Dial9ContextField` would need a coordinated metrique+dial9 upgrade). Mitigation: tag is internal to dial9 and not user-facing; any evolution can happen inside the dial9 crate.
