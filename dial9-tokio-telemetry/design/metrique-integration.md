# Metrique integration

Dial9 is a peer metrique sink. Users configure dial9 alongside their existing EMF/JSON metrique pipeline; every metrique entry that flows through the configured sink is also recorded into the dial9 trace. A single trace file carries both tokio runtime telemetry and per-request application metrics.

The sink reads metrique's entry descriptor for each entry to learn its structural shape (fields, optionality, Flex, units), extracts caller-thread context via metrique's source system, and encodes the user-selected subset of fields into the dial9 trace. Nothing about the integration requires a dial9-specific metrique macro or dial9-specific newtype wrappers on fields.

This design depends on the entry descriptor system in metrique (see `docs/entry-descriptors.md` in the metrique repo; tracked under [metrique PR TBD](https://github.com/awslabs/metrique/pulls)). The dial9 side is a descriptor-aware sink; the metrique side is where descriptors, sources, and field tags are defined.

## User-facing API

### Opt-in on the entry

```rust
use dial9::{Dial9, Dial9Context, InTrace, InternString};

#[metrics(default_field_tag(InTrace))]
struct RequestMetrics {
    #[metrics(no_emit)]
    dial9: Dial9Context,

    #[metrics(field_tag(InternString))]
    route: String,

    operation: &'static str,
    request_id: String,

    #[metrics(field_tag(skip(InTrace)))]
    debug_blob: String,
}
```

What this means:

- `Dial9Context` is a dial9-provided metrique field type. Its constructor captures caller-thread context (worker id, task id, start monotonic timestamp). It is declared `#[metrics(source(Dial9))]` in the dial9 crate, so the sink can extract a snapshot from the closed entry.
- `no_emit` retains `Dial9Context` on the closed entry so the sink can read it, but does not emit its fields through `Entry::write`. `Dial9Context` itself carries `default_field_tag(skip(InTrace))` in its own definition, so if a user opts for `flatten` instead, its fields do not accidentally get pulled into the dial9 payload by the parent's `InTrace` default.
- `InTrace` marks fields that should appear in the dial9 trace payload. `skip(InTrace)` at the struct level inverts the default.
- `InternString` tells the sink to route string data in this field through dial9's string pool.

### Sink construction

```rust
use dial9::AttachDial9Ext;
use metrique::ServiceMetrics;

let _handle = ServiceMetrics::attach_to_stream_with_dial9(
    emf_stream,
    &telemetry_handle,
);
```

The builder and manual composition paths are unchanged from the original design. `metrique_sink(emf_stream, &telemetry_handle).build()` returns a standalone sink; `tee(emf_stream, Dial9Stream::new(&telemetry_handle))` is the primitive composition for users who want to wire their own.

### Flatten as an alternative for `Dial9Context`

If the user wants dial9 context visible in normal (non-dial9) emissions too:

```rust
#[metrics(default_field_tag(InTrace))]
struct RequestMetrics {
    #[metrics(flatten)]
    dial9: Dial9Context,
    // ...
}
```

Because `Dial9Context` itself declares `default_field_tag(skip(InTrace))`, its fields are not tagged `InTrace` by parent-default inheritance. They still carry structural source data via `Source<Dial9>`.

## Architecture

```text
┌────────────────────────────────────────────────────────────────┐
│ COMPILE TIME: metrique macro                                   │
│                                                                │
│ Sink-side (in dial9 crate):                                    │
│   #[metrics(source(Dial9))]                                    │
│   #[metrics(default_field_tag(skip(InTrace)))]                 │
│   pub struct Dial9Context { /* worker/task/monotonic */ }      │
│                                                                │
│ User-side:                                                     │
│   #[metrics(default_field_tag(InTrace))]                       │
│   struct RequestMetrics {                                      │
│       #[metrics(no_emit)]      dial9: Dial9Context,            │
│       #[metrics(field_tag(InternString))] route: String,       │
│       ...                                                      │
│   }                                                            │
│                                                                │
│ Macro emits:                                                   │
│   impl Entry for ClosedRequestMetrics (as today)               │
│   static EntryDescriptor (fields, tags, units, sources)        │
│   impl Source<Dial9> for ClosedRequestMetrics (via dial9 field)│
│   descriptor() hook on the erased entry vtable                 │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ CALLER THREAD: request path                                    │
│                                                                │
│ let m = RequestMetrics { dial9: Dial9Context::capture(), ... };│
│   Dial9Context::capture() reads:                               │
│     tokio worker id, task id, monotonic clock                  │
│   other fields populated normally                              │
│                                                                │
│ Caller-thread overhead: a few TL reads + clock_monotonic_ns()  │
│ per entry. No allocations beyond what metrique already does.   │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ CALLER THREAD: append-on-drop / close                          │
│                                                                │
│ All CloseValue runs (Timer, Duration, Option, ...).            │
│ Dial9Context closes to ClosedDial9Context, retained on the     │
│ closed entry because of no_emit.                               │
│                                                                │
│ Entry is pushed to BackgroundQueue as BoxEntry.                │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ FLUSH THREAD: BackgroundQueue / tee                            │
│                                                                │
│ Each entry is delivered to every registered sink:              │
│                                                                │
│   ├── EMF sink: calls Entry::write as today.                   │
│   │             Does not call descriptor().                    │
│   │                                                            │
│   └── Dial9Stream (descriptor-aware):                          │
│         desc = entry.descriptor()                              │
│           None    -> skip (hand-written entry, report once)    │
│           Some(d) -> continue                                  │
│                                                                │
│         fast path checks:                                      │
│           d has no InTrace fields and no Dial9 source? drop.   │
│           d has InTrace fields but no Dial9 source? report.    │
│                                                                │
│         schema = schema_cache.entry(d).or_insert_with(|| {     │
│             build_schema_from_descriptor(d)                    │
│         });                                                    │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ FLUSH THREAD: inside Dial9Stream, per entry                    │
│                                                                │
│ ctx = d.source::<Dial9>(entry.inner_any())                     │
│ encoder.start_event(                                           │
│     timestamp = ctx.start_monotonic_ns,                        │
│     worker    = ctx.worker_id,                                 │
│     task      = ctx.task_id,                                   │
│     schema,                                                    │
│ )                                                              │
│                                                                │
│ entry.write(Dial9EntryWriter {                                 │
│     descriptor: d,                                             │
│     schema,                                                    │
│     encoder,                                                   │
│ }):                                                            │
│                                                                │
│   walk Entry::write in descriptor order. For each (name,       │
│   value), consult the descriptor:                              │
│                                                                │
│     InTrace absent?                                            │
│       -> skip                                                  │
│                                                                │
│     InTrace present?                                           │
│       -> encode according to FieldShape:                       │
│            Known   : encode scalar                             │
│            Optional: encode presence byte + inner              │
│            Flex    : encode map<key, value>                    │
│            Opaque  : report + skip (sink-side validation)      │
│                                                                │
│     InternString present and field carries string data?        │
│       -> route through encoder.intern_string(..)               │
│                                                                │
│ encoder.end_event()                                            │
└────────────────────────────────────────────────────────────────┘
```

Work on the caller thread is bounded to constructing `Dial9Context` and wrapping the entry for the queue. All encoding happens on the flush thread. Entries that have no dial9 content pay essentially nothing.

## Components

### `Dial9Context` (metrique field type)

Regular metrique struct defined in the dial9 crate:

```rust
#[metrics(source(Dial9))]
#[metrics(default_field_tag(skip(InTrace)))]
pub struct Dial9Context { /* private */ }

impl Dial9Context {
    pub fn capture() -> Self { /* read worker/task/monotonic */ }
}
```

Construction reads the tokio runtime thread-locals and the monotonic clock. The closed form (`ClosedDial9Context`) is the snapshot the sink extracts through `Source<Dial9>`.

If the constructor runs on a thread that is not owned by a dial9 runtime, `Dial9Context::capture()` records the best available data (`WorkerId::UNKNOWN`, no task id) and the sink proceeds normally; a rate-limited `tracing::warn!` flags the missing context. Entries still flow.

### `Dial9Stream`

`EntryIoStream` implementor. Constructed with a `TelemetryHandle`. Runs on whatever thread metrique's pipeline calls `next` on; for the global and builder paths, that is the `BackgroundQueue` flush thread.

Per entry:

1. If the handle is inert: return `Ok(())` immediately; entries still reach EMF through the tee.
2. Look up `entry.descriptor()`. `None` is reported once and skipped.
3. Look up the entry's `Source<Dial9>` snapshot. Missing source with present `InTrace` fields is reported and the entry is skipped.
4. Ensure a schema is registered for this descriptor (see "Schema handling" below).
5. Start an event on the encoder using the snapshot timestamp.
6. Walk `Entry::write` with a `Dial9EntryWriter` that uses the descriptor to filter by `InTrace`, route `InternString` fields through the string pool, and encode each value according to its `FieldShape`.
7. End the event.

A `catch_unwind(AssertUnwindSafe(..))` guard around the `Entry::write` walk drops offending events (rate-limited log) without poisoning the flush thread's state.

### Schema handling

Dial9 registers one schema per distinct `EntryDescriptor`. The descriptor is `'static`, so the cache key is a pointer comparison. One registration per descriptor, regardless of which optional fields happen to be present or which Flex keys appear.

Optional fields use dial9's existing optional wire encoding (high-bit optional variants on `FieldType`). Flex maps use dial9's new typed-map wire support (see "Trace format additions").

No shape fingerprinting on the hot path. No LRU eviction. The cache is bounded by the number of distinct descriptors the process instantiates, which is a compile-time property.

### Units

`FieldDescriptor::unit: Option<Unit>` reaches the sink through the descriptor. Dial9 emits units as schema-level annotations, not field-name suffixes and not wire-type variants. The annotation key is `"metrique.unit"`; the value is the unit's string representation, including `Unit::Custom("...")` cases. Fields with no unit pay no annotation bytes.

For Flex fields, the unit applies to the map values, not the keys.

### Observability

- Periodic `tracing::debug!` reporting schema cache size and cumulative counters (registrations, events emitted, entries skipped for `None` descriptor, entries skipped for missing source).
- Rate-limited `tracing::warn!` on each distinct "no Dial9 source but InTrace fields present" report (per descriptor, not per event) and on each distinct hand-written entry seen.

## Trace format additions

Two additions to `dial9-trace-format` enable the integration without per-sink extensions:

### Schema-level annotations

A new annotation section on `SchemaEntry` that carries repeated `(field_index, key, value)` tuples. Used for units today, usable for future display hints, semantic-convention labels, aggregation hints, and privacy labels without further format changes.

Units encode as `("metrique.unit", "microseconds")` on the annotated field. Fields without annotations cost nothing.

### Typed dynamic maps

A new `FieldType` family (`StringMap<V>` for fixed-schema keys-as-strings; `PooledStringMap<V>` when keys are interned) that lets dial9 represent a metrique `Flex<(String, T)>` as a single schema field carrying a map at encode time, instead of one schema per runtime key.

Wire layout is conventional (`<count> <repeated key value>`), using existing scalar encodings for `V` and the existing pooled-string encoding for keys when interned. The value type is fixed at schema time; if metrique later adds heterogeneous Flex values, the schema representation will need a tagged-value variant. That is out of scope for this integration.

## Error handling and resilience

- **Hand-written entries**: `descriptor()` is `None`. Dial9 reports once per distinct type id observed (via `inner_any().type_id()`) and skips. A future extension can let hand-written entries opt in.
- **Entries with `InTrace` fields but no `Dial9` source**: reported once per descriptor; entries are skipped. This is a user configuration error; the sink surfaces it rather than encoding partial events.
- **Entries with `FieldShape::Opaque` selected for `InTrace`**: reported once per `(descriptor, field)` pair; the field is skipped on the wire. The rest of the entry still encodes.
- **Inert telemetry handle**: `Dial9Stream` returns `Ok(())` immediately. Entries still reach EMF.
- **Caller thread not owned by a dial9 runtime**: `Dial9Context::capture()` records best-effort values and the entry encodes normally.
- **Panic inside `Value::write`**: caught per entry; the offending event is dropped with a rate-limited log. The flush thread's encoder state stays valid.

## Validation

Validation of entry-to-sink compatibility runs in two places. Both rest on the metrique descriptor system described in `docs/entry-descriptors.md` in the metrique repo.

### Compile-time

The metrique macro catches generic structural errors for everyone: duplicate source tags, conflicting `field_tag` + `field_tag(skip)`, conflicting struct-level defaults. Those diagnostics fire regardless of what tags are in play.

Dial9-specific compile-time diagnostics are produced by a helper macro shipped in the dial9 crate. Users opt in by invoking it alongside their metrique-derived struct:

```rust
// Optional, same module as the #[metrics(..)] attribute.
dial9::assert_dial9_compatible!(RequestMetrics);
```

The helper inspects the macro-generated descriptor at const-eval time and emits compile errors for dial9-specific mistakes:

- One or more fields tagged `InTrace` but the entry declares no `Dial9` source.
- A field tagged `InternString` whose closed shape is not a string type or a Flex with a string-capable position.
- A field tagged `InTrace` whose closed shape is `FieldShape::Opaque` (the sink has no way to encode it).
- A source tagged `Dial9` but no fields tagged `InTrace` (mildly suspect; warning, not error).

We keep these checks in a helper macro rather than hardcoding them into metrique because metrique does not need to know about dial9 specifically. The helper is strictly opt-in; users who do not invoke it still get the runtime diagnostics below.

### Runtime

The first time `Dial9Stream` sees a descriptor, it performs the same checks as the helper macro and caches the verdict. The cache is keyed on the `&'static EntryDescriptor` pointer, so subsequent entries of the same type pay nothing.

Failure modes:

| Condition | Behaviour |
| --- | --- |
| `descriptor() == None` (hand-written entry) | rate-limited warn once per observed concrete type; entry dropped from dial9 path; EMF unaffected |
| Descriptor has `InTrace` fields but no `Dial9` source | rate-limited warn once per descriptor; entries of this type dropped from dial9 path |
| Descriptor has `InternString` on a non-string-capable shape | rate-limited warn once per descriptor + field; the offending field is skipped on the wire; rest of entry encodes |
| `FieldShape::Opaque` field tagged `InTrace` | rate-limited warn once per descriptor + field; the offending field is skipped on the wire; rest of entry encodes |
| Inert `TelemetryHandle` | `Ok(())` fast path; no work; entries still reach EMF |
| Panic inside `Value::write` | event dropped; rate-limited warn; flush-thread state preserved |

None of these failure modes crash the sink or stop the pipeline. Every diagnostic is rate-limited `tracing::warn!` with enough context (entry type name when available; descriptor pointer as a fallback) to trace back to the offending struct.

Periodic `tracing::debug!` reports aggregate counters: descriptors seen, descriptors skipped, events emitted, fields skipped. Off at `info` by default.

## Future evolution

- Hand-written `Entry` impls opting into descriptors (once metrique ships `DescribeEntry`) so they participate in dial9 without derive sugar.
- Per-sink compile-time wire plans, once metrique can emit them, to replace the flush-thread `Entry::write` walk with a direct encode.
- More schema annotations: display hints, aggregation hints, privacy labels. Same mechanism as units.
- Heterogeneous Flex values once metrique carries a tagged runtime value model for them.
