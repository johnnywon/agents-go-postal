#!/usr/bin/env bash
# The console overview has no helper sentences.
source "${VERIFY_LIB:-$HOME/Developer/build-pref/scripts/verify_lib.sh}"
file_lacks app/components/postal/OverviewTab.tsx "Limits are set in Limits"
file_lacks app/components/postal/OverviewTab.tsx "the full record is in Activity"
file_lacks app/components/postal/OverviewTab.tsx "Sends per address against the limits."
done_checks
