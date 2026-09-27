.PHONY: test test-visible test-alt verify clean

test:
	node tests/runner.mjs src/index.js

test-visible:
	node tests/run_scenarios.js

test-alt:
	node tests/runner.mjs src/codec-alt.js

verify:
	@echo "Running complete 375-scenario verification pipeline..."
	@node tests/runner.mjs src/index.js > /tmp/runner-report.json
	@VERIFIER_REPORT=/tmp/runner-report.json pytest tests/test_state.py -v
	@rm -f /tmp/runner-report.json

clean:
	rm -rf __pycache__ tests/__pycache__ .pytest_cache
