#!/bin/sh
set -eu
# Branch and MR gates never authenticate or write to the registry.
if [ -z "${CI_COMMIT_TAG:-}" ] || [ "${CI_PIPELINE_SOURCE:-}" = "merge_request_event" ]; then
  exit 0
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$script_dir/publish-release.mjs" --candidate
