#!/usr/bin/env bash
set -e

# Generate a multi-segment trace dataset for eval testing.
# Runs the metrics-service demo with a small rotation size to produce many files.
#
# Usage:
#   ./generate_eval_traces.sh [--output DIR] [--aws-profile PROFILE]
#
# Default output: /tmp/d9-eval-traces/

OUTPUT="/tmp/d9-eval-traces"
FLAG_PROFILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --output=*) OUTPUT="${1#*=}"; shift ;;
        --output) OUTPUT="$2"; shift 2 ;;
        --aws-profile=*) FLAG_PROFILE="${1#*=}"; shift ;;
        --aws-profile) FLAG_PROFILE="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [ -n "$FLAG_PROFILE" ]; then
    export AWS_PROFILE="$FLAG_PROFILE"
elif [ -z "$AWS_PROFILE" ]; then
    echo "Error: No AWS profile specified." >&2
    echo "Either pass --aws-profile=<profile> or set the AWS_PROFILE environment variable." >&2
    exit 1
fi

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "Building metrics-service (release)..."
cargo build --release -p metrics-service

rm -rf "$OUTPUT"
mkdir -p "$OUTPUT"

TRACE_PATH="$OUTPUT/trace.bin"

echo "Recording multi-segment trace..."
# Run a workload with 2MB rotation to produce many small files matching
# real production sizes (~376 KiB compressed, ~5 MiB raw per file).
# 120s produces ~400-500 files, matching the smallest real load test run.
# We avoid --demo because it overrides trace-max-file-size.
cargo run --release -p metrics-service --bin metrics-service -- \
    --trace-path "$TRACE_PATH" \
    --trace-max-file-size 2000000 \
    --trace-max-total-size 1073741824 \
    --run-duration 240 \
    --worker-threads 4

FILE_COUNT=$(ls -1 "$OUTPUT"/trace.*.bin.gz 2>/dev/null | wc -l)
TOTAL_SIZE=$(du -sh "$OUTPUT" | cut -f1)

echo ""
echo "Generated $FILE_COUNT trace segments in $OUTPUT ($TOTAL_SIZE)"
echo ""
ls -lhS "$OUTPUT"/trace.*.bin.gz | head -5
if [ "$FILE_COUNT" -gt 5 ]; then
    echo "  ... and $((FILE_COUNT - 5)) more"
fi
echo ""
echo "To run the eval, point an agent at:"
echo "  dial9-viewer/evals/multi-file-analysis.md"
echo "  with traces at: $OUTPUT"
