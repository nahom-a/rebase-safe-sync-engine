#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CODEC_PATH="${1:-$REPO_DIR/src/index.js}"
REPORT_FILE="$(mktemp /tmp/codec-report-XXXXXX.json)"

echo "=== Running Rebase-Safe Codec Verification Suite ==="
echo "Target Codec: $CODEC_PATH"
echo ""

node "$SCRIPT_DIR/runner.mjs" "$CODEC_PATH" > "$REPORT_FILE"

echo "=== Executing 19 Pytest Validation Gates ==="
VERIFIER_REPORT="$REPORT_FILE" pytest "$SCRIPT_DIR/test_state.py" -v

rm -f "$REPORT_FILE"
echo ""
echo "=== All Tests Passed Successfully! ==="
