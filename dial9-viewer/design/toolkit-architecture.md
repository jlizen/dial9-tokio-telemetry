# dial9-viewer design

## Overview

`dial9-viewer` is a trace viewer and analysis toolkit for dial9 runtime traces. It has two modes:

- **Web UI**: Rust HTTP server that fetches traces from S3, serves the viewer HTML/JS, and provides search/browse APIs.
- **Agent toolkit**: JS scripts (`analyze.js`, `trace_parser.js`, `trace_analysis.js`) that parse and analyze traces programmatically. Distributed via `dial9-viewer agents toolkit <dir>`.

## Agent skills (steering)

The viewer bundles markdown "skills" that teach AI agents how to use the toolkit. These are compiled into the binary at build time by `build.rs`:

- `skills/header.md` → `HEADER` constant (printed by `dial9-viewer agents`)
- `skills/*.md` (except header) → `SKILL_FILES` array (printed by `dial9-viewer agents skill <name>`)
- `toolkit/*` (symlinks to `skills/` and `ui/`) → `TOOLKIT_FILES` array (written by `dial9-viewer agents toolkit <dir>`)

The header is the entry point. An agent runs `dial9-viewer agents`, reads the header, discovers available skill segments and the toolkit command, then copies the toolkit and starts analyzing.

Non-`.md` files in `skills/` (like `analyze.js`, `analyze_worker.js`) are not served as skills but are included in the toolkit via symlinks in `toolkit/`.

## Agent toolkit architecture

### Single file

`parseTrace(buffer)` decodes the binary trace format (via `decode.js`, a WASM-based decoder) and returns a `ParsedTrace` with events, CPU samples, symbol tables, and task lifecycle data. Analysis functions in `trace_analysis.js` derive higher-level structures (worker spans, scheduling delays, task timelines) from the parsed trace.

### Directory (multi-file)

`parseTrace(directoryPath)` processes all `.bin`/`.bin.gz` files in parallel:

1. Spawns one `analyze_worker.js` subprocess per file (concurrency capped at CPU count)
2. Each worker: parses the trace, runs the full analysis pipeline, writes results to `.d9-cache/`
3. Main process reads cached results and yields `{file, analysis}` objects

Warm runs skip the subprocess and read cached results directly.

### Cache format

`.d9-cache/<filename>.json` contains NDJSON (one JSON record per line):

| Tag | Content |
|-----|---------|
| `m` | Metadata: workerIds, duration, event counts, Maps as `[k,v]` arrays |
| `w` | Per-worker spans: polls, parks, actives (one line per worker) |
| `q` | Queue samples |
| `wt`/`ww` | Wakes by task / by worker |
| `tt` | Task timeline |
| `sd` | Scheduling delay (one line per delay) |
| `cg`/`sg` | CPU / scheduling sample group (one line per group) |
| `sp` | Span data |

NDJSON is used so that no single line exceeds V8's string size limit, regardless of trace size. The reader splits a Buffer on newlines and parses each line independently.

Cache invalidation is mtime-based. `--force` bypasses the cache.
