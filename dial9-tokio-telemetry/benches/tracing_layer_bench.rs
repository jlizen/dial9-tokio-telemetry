//! Micro-benchmark for the tracing layer's per-span overhead.
//!
//! Measures the cost of entering and exiting instrumented spans at various
//! nesting depths, with the Dial9TokioLayer installed and recording into
//! a real trace buffer.
//!
//! Usage:
//!   cargo bench --bench tracing_layer_bench --features tracing-layer

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use dial9_tokio_telemetry::telemetry::{NullWriter, TracedRuntime};
use dial9_tokio_telemetry::tracing_layer::Dial9TokioLayer;
use tracing_subscriber::prelude::*;

fn bench_span_overhead(c: &mut Criterion) {
    let mut group = c.benchmark_group("span_overhead");

    // Build a traced runtime (NullWriter so we measure encode, not I/O)
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.worker_threads(2).enable_all();
    let (runtime, _guard) = TracedRuntime::builder()
        .build_and_start(builder, NullWriter)
        .unwrap();

    let subscriber = tracing_subscriber::registry().with(Dial9TokioLayer::new());
    tracing::subscriber::set_global_default(subscriber).ok();

    for depth in [1, 3, 5] {
        group.bench_with_input(BenchmarkId::new("depth", depth), &depth, |b, &depth| {
            b.iter(|| {
                runtime.block_on(async {
                    nested_spans(depth);
                });
            });
        });
    }

    // Span with fields
    group.bench_function("with_fields", |b| {
        b.iter(|| {
            runtime.block_on(async {
                let span = tracing::info_span!(
                    "fielded",
                    user_id = 42,
                    method = "GET",
                    path = "/api/v1/users"
                );
                let _enter = span.enter();
            });
        });
    });

    // Baseline: no tracing layer, just the runtime overhead
    group.bench_function("no_layer_baseline", |b| {
        b.iter(|| {
            runtime.block_on(async {
                std::hint::black_box(42);
            });
        });
    });

    group.finish();
    drop(runtime);
}

fn nested_spans(depth: usize) {
    if depth == 0 {
        return;
    }
    let span = tracing::info_span!("nested", level = depth);
    let _enter = span.enter();
    nested_spans(depth - 1);
}

criterion_group!(benches, bench_span_overhead);
criterion_main!(benches);
