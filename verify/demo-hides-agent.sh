#!/usr/bin/env bash
# A demo shows no agent entry points and no editable settings.
source "${VERIFY_LIB:-$HOME/Developer/build-pref/scripts/verify_lib.sh}"
check "demo UI test passes" node --test --test-name-pattern "agent entry points" tests/demo.test.mjs
check "Console reads the demo flag" grep -qE "useDemo|demo" app/components/postal/Modals.tsx
check "test: demo hides agent entry points" grep -q "agent entry points" tests/demo.test.mjs
done_checks
