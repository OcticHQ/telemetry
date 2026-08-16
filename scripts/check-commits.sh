#!/usr/bin/env bash
#
# Verify commit subjects are Conventional Commits.
#
#   check-commits.sh <base-sha>              every commit in <base-sha>..HEAD
#   check-commits.sh --message-file <path>   one message; the commit-msg hook
#
# release-please routes a commit to a component by the files it touched, not by
# its scope — but it reads the *type* to decide the bump. A commit it cannot
# parse is silently ignored, so a `fix` typed as `fixed` ships no release and no
# warning.
#
# Both modes share one pattern deliberately: the pre-commit hook and CI must
# agree, or the hook becomes something people learn to bypass.
#
# See handbook/adr/0002-per-sdk-versioning.md.

set -euo pipefail

types='feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert'
pattern="^(${types})(\([a-z0-9._/-]+\))?!?: .+"

usage() {
  echo "usage: check-commits.sh <base-sha>" >&2
  echo "       check-commits.sh --message-file <path>" >&2
  exit 2
}

explain() {
  echo
  echo "Expected: <type>[(scope)][!]: <subject>"
  echo "Types:    ${types//|/, }"
  echo "Example:  feat(node): add withSession()"
}

# release-please authors its own commits and they are not written by hand.
# `chore(main): release node 0.1.0` is the Release PR merge — the subject that
# a verbatim copy of this script from terraform-aws-modules would reject on the
# *next* pull request, because that repo only ever saw `chore(release):`.
is_generated() {
  case "$1" in
    "chore(main):"*) return 0 ;;
    "chore(release):"*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── commit-msg hook: a single message file ──
if [ "${1:-}" = "--message-file" ]; then
  file="${2:?}"
  # Comments and the diff git appends under --verbose are not the subject.
  subject="$(grep -v '^#' "$file" | sed '/^$/d' | head -1 || true)"

  is_generated "$subject" && exit 0

  if ! printf '%s' "$subject" | grep -Eq "$pattern"; then
    echo "Not a Conventional Commit: \"$subject\""
    explain
    exit 1
  fi
  exit 0
fi

[ $# -ge 1 ] || usage
base="$1"

# An empty or bogus base is the dangerous input, not a missing one. `git log
# ""..HEAD` lists nothing, so the script would report "0 commits checked, all
# conventional" and exit 0 — a green gate that inspected nothing. That is
# exactly what happens when the caller's `git merge-base` fails and its empty
# output is passed straight through.
[ -n "$base" ] || {
  echo "::error::empty base — the caller's merge-base probably failed" >&2
  exit 2
}
git rev-parse --verify --quiet "${base}^{commit}" >/dev/null || {
  echo "::error::not a commit: ${base}" >&2
  exit 2
}

status=0
count=0

while IFS= read -r line; do
  [ -n "$line" ] || continue
  sha="${line%% *}"
  subject="${line#* }"
  count=$((count + 1))

  is_generated "$subject" && continue

  if ! printf '%s' "$subject" | grep -Eq "$pattern"; then
    echo "::error::$sha is not a Conventional Commit: \"$subject\""
    status=1
  fi
done < <(git log --no-merges --format='%h %s' "$base"..HEAD)

if [ "$status" -eq 0 ]; then
  echo "$count commit(s) checked, all conventional"
else
  explain
fi

exit "$status"
