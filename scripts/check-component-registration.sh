#!/usr/bin/env bash
#
# Every component must agree in three places: the release-please config, the
# release-please manifest, and the filesystem.
#
# The failure mode is silent. An unregistered directory is simply never
# released and nothing anywhere says so — you find out when a consumer asks why
# there is no tag. A registered directory that does not exist is worse: the
# release job fails after the checks have already gone green.
#
# See handbook/adr/0002-per-sdk-versioning.md.

set -euo pipefail
cd "$(dirname "$0")/.."

command -v jq >/dev/null 2>&1 || {
  echo "::error::jq is required — see CONTRIBUTING.md" >&2
  exit 1
}

readonly CONFIG='release-please-config.json'
readonly MANIFEST='.release-please-manifest.json'

status=0

for file in "$CONFIG" "$MANIFEST"; do
  if ! jq -e . "$file" >/dev/null 2>&1; then
    echo "::error file=$file::not valid JSON"
    exit 1
  fi
done

mapfile -t configured < <(jq -r '.packages | keys[]' "$CONFIG")
mapfile -t manifested < <(jq -r 'keys[]' "$MANIFEST")

# ── config → manifest, and config → filesystem ──
for component in "${configured[@]}"; do
  if ! printf '%s\n' "${manifested[@]}" | grep -qxF "$component"; then
    echo "::error file=$MANIFEST::\"$component\" is in $CONFIG but not here — release-please will refuse to run"
    status=1
  fi

  if [ ! -d "$component" ]; then
    echo "::error file=$CONFIG::\"$component\" is registered but the directory does not exist"
    status=1
    continue
  fi

  # Each release-type keeps its version in a different file. Missing it means
  # release-please has nothing to bump.
  release_type="$(jq -r --arg c "$component" '.packages[$c]["release-type"] // ""' "$CONFIG")"
  case "$release_type" in
    node)
      if [ ! -f "$component/package.json" ]; then
        echo "::error::$component is release-type node but has no package.json"
        status=1
      else
        declared="$(jq -r '.name // ""' "$component/package.json")"
        expected="$(jq -r --arg c "$component" '.packages[$c]["package-name"] // ""' "$CONFIG")"
        if [ -n "$expected" ] && [ "$declared" != "$expected" ]; then
          echo "::error file=$component/package.json::name is \"$declared\" but $CONFIG says \"$expected\""
          status=1
        fi
      fi
      ;;
    python)
      if [ ! -f "$component/pyproject.toml" ]; then
        echo "::error::$component is release-type python but has no pyproject.toml"
        status=1
      else
        # No jq for TOML. `name` is unique enough in a pyproject that the first
        # one is the [project] table's, and a second would be a key we do not
        # set — so grep reads it rather than a dependency on a TOML parser.
        declared="$(sed -n 's/^name = "\(.*\)"$/\1/p' "$component/pyproject.toml" | head -n 1)"
        expected="$(jq -r --arg c "$component" '.packages[$c]["package-name"] // ""' "$CONFIG")"
        if [ -n "$expected" ] && [ "$declared" != "$expected" ]; then
          echo "::error file=$component/pyproject.toml::name is \"$declared\" but $CONFIG says \"$expected\""
          status=1
        fi
      fi
      ;;
    simple)
      if [ ! -f "$component/version.txt" ]; then
        echo "::error::$component is release-type simple but has no version.txt — release-please writes the version there"
        status=1
      fi
      ;;
    '')
      echo "::error file=$CONFIG::\"$component\" has no release-type"
      status=1
      ;;
  esac
done

# ── manifest → config ──
for component in "${manifested[@]}"; do
  if ! printf '%s\n' "${configured[@]}" | grep -qxF "$component"; then
    echo "::error file=$CONFIG::\"$component\" is in $MANIFEST but not registered here"
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "${#configured[@]} component(s) registered and consistent: ${configured[*]}"
fi

exit "$status"
