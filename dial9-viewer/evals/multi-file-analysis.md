# Eval: Trace analysis toolkit

Measures how well an agent can discover and use the dial9 trace analysis toolkit to diagnose Tokio runtime issues.

## Prerequisites

```bash
cargo build -p dial9-viewer
./dial9-viewer/evals/generate_eval_traces.sh
rm -rf /tmp/d9-eval-traces/.d9-cache
```

## How to run

Open a fresh agent session from the repo root and paste one of the scenario prompts below. The agent should have no prior context about dial9.

### Scenario A: Single file

```
I have a Tokio application that's showing high tail latency. I've collected a runtime trace at dial9-viewer/ui/demo-trace.bin. The dial9-viewer binary is at target/debug/dial9-viewer. Help me figure out what's going on.
```

### Scenario B: Multi-file directory

```
I have a Tokio application that's showing high tail latency. I've collected trace data from a load test run in /tmp/d9-eval-traces/. The dial9-viewer binary is at target/debug/dial9-viewer. Help me figure out what's going on.
```

## Scoring rubric

| Score | Criteria |
|-------|----------|
| **Setup failure** | Couldn't find the toolkit or parse any traces |
| **Surface only** | Ran analysis and reported output without interpreting it |
| **Good diagnosis** | Identified root causes with evidence from samples/stacks |
| **Excellent** | Discovered toolkit independently, identified root causes, drilled deeper with follow-up scripts |

## What to observe

- **Discovery**: Did the agent find `dial9-viewer agents`? Or try to read binary files directly?
- **Setup**: Did it get analysis running without hand-holding?
- **Depth**: Did it use CPU/scheduling samples to explain root causes?
- **Iteration**: Did it write follow-up scripts when initial analysis raised questions?
- **Span data**: Did it look at tracing span data to understand what happened inside long polls?
- **Multi-file** (scenario B): Did it use directory mode? Did it notice cross-segment patterns?
- **Recipes**: Did it use existing recipes from the skills, or reinvent the wheel?
