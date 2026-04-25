#!/usr/bin/env bash
set -e

# Generate a LARGE multi-segment trace dataset for stress testing.
# Produces few large files (~22-35MB compressed each).
#
# Usage:
#   ./generate_eval_traces_large.sh [--output DIR] [--aws-profile PROFILE]
#
# Default output: /tmp/d9-eval-traces-large/

OUTPUT="/tmp/d9-eval-traces-large"
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
# Run with default file size (100MB) to produce few large files.
# We avoid --demo because it overrides trace-max-file-size.
cargo run --release -p metrics-service --bin metrics-service -- \
    --trace-path "$TRACE_PATH" \
    --trace-max-total-size 10737418240 \
    --run-duration 60 \
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
