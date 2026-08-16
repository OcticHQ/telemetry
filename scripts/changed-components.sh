#!/usr/bin/env bash
#
# Emit a JSON array of component names, for a GitHub Actions matrix.
#
#   changed-components.sh <base-sha>   components touched between <base-sha> and HEAD
#   changed-components.sh              every registered component
#
# The no-argument form is what ci.yml uses on main: a release should be gated
# on the whole repo being valid, not just on whatever the last push happened to
# touch.
#
# The registry is release-please-config.json. There is deliberately no second
# list to keep in sync — a component that release-please does not know about
# cannot be released, so it is not a component.
#
# Changes to shared tooling (workflows, scripts, the hook config) return every
# component: a change to _node.yml has to be validated against node/ even
# though no file under node/ moved.
#
# See handbook/adr/0002-per-sdk-versioning.md.

set -euo pipefail
cd "$(dirname "$0")/.."

# Checked explicitly. Without jq this script emits `[]` and exits 0, which CI
# reads as "nothing changed" and skips every job — a green build that checked
# nothing is worse than a red one.
command -v jq >/dev/null 2>&1 || {
  echo "::error::jq is required — see CONTRIBUTING.md" >&2
  exit 1
}

readonly CONFIG='release-please-config.json'

# Paths that affect every component, so a change to one re-checks all of them.
readonly SHARED=(
  '.github/'
  'scripts/'
  'Makefile'
  '.pre-commit-config.yaml'
  'release-please-config.json'
  '.release-please-manifest.json'
)

all_components() {
  jq -r '.packages | keys[]' "$CONFIG" | sort
}

base="${1:-}"

if [ -z "$base" ]; then
  mapfile -t components < <(all_components)
else
  mapfile -t changed < <(git diff --name-only "$base" HEAD)

  # A shared-tooling change re-checks everything.
  for file in ${changed[@]+"${changed[@]}"}; do
    for prefix in "${SHARED[@]}"; do
      case "$file" in
        "$prefix"*)
          all_components | jq -R . | jq -sc .
          exit 0
          ;;
      esac
    done
  done

  registered="$(all_components)"
  components=()
  for file in ${changed[@]+"${changed[@]}"}; do
    top="${file%%/*}"
    # Only a registered component counts. Everything else — docs/, handbook/,
    # README — changes nothing that needs building.
    grep -qxF "$top" <<<"$registered" || continue
    components+=("$top")
  done

  if [ ${#components[@]} -gt 0 ]; then
    mapfile -t components < <(printf '%s\n' "${components[@]}" | sort -u)
  fi
fi

if [ ${#components[@]} -eq 0 ]; then
  echo '[]'
else
  printf '%s\n' "${components[@]}" | jq -R . | jq -sc .
fi
