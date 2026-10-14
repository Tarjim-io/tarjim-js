#!/usr/bin/env bash
#/ DESCRIPTION:
#/   Fails when a file carries a Tarjim API key, a CloudFront signature, policy or key pair id, a
#/   real Tarjim, CloudFront or AWS host, or an internal ticket id. Prints file:line and the kind of
#/   finding, never the finding. Placeholders pass: keys under tenant 0 (`tarjim-0-0-0-…`), REDACTED
#/   values, short test values such as `Signature=S1`, the public API host, example and `.invalid`
#/   hosts, and the `*.cloudfront.net` wildcard.
#/
#/ USAGE:
#/   secret-scan.sh [<file>...] [--help]
#/
#/ SYNOPSIS:
#/   <file>: files to scan (default: every file git tracks, run from the repository root)
#/   --help: Prints this message

set -euo pipefail
# shellcheck disable=SC2154 # ec is assigned inside the trap string
trap 'ec=$?; echo "[ERROR] $BASH_SOURCE:$LINENO: \"$BASH_COMMAND\" exited with $ec" >&2' ERR

usage() {
  grep '^#/' <"$0" | cut -c 4-
  exit 2
}

case "${1:-}" in
  -h|--help)
    usage
    ;;
esac

# kind<TAB>extended regex<TAB>allowed match (optional, a whole-match regex). A real key has non-zero
# numeric segments and a long random tail; a real signature, policy or key pair id is far longer than
# any test value. Hosts and ticket ids are matched without case, as a host or a ticket is written
# either way.
rules=$(cat <<'RULES'
API key	tarjim-[1-9][0-9]*-[0-9]+-[0-9]+-[A-Za-z0-9]{16,}
CloudFront signature	Signature=[A-Za-z0-9~_-]{20,}
CloudFront policy	Policy=[A-Za-z0-9~_-]{20,}
CloudFront key pair id	Key-Pair-Id=[A-Z0-9]{10,}
Tarjim host	([a-z0-9-]+\.)+tarjim\.(io|com|net|dev|app)	api\.tarjim\.io
CloudFront host	[a-z0-9-]+\.cloudfront\.net
AWS host	([a-z0-9-]+\.)+amazonaws\.com
ticket id	(^|[^a-z0-9])tj-[0-9]+
RULES
)

if [[ $# -gt 0 ]]; then
  files=("$@")
else
  files=()
  while IFS= read -r -d '' file; do
    files+=("$file")
  done < <(git ls-files -z)
fi

found=0
while IFS=$'\t' read -r kind pattern allowed; do
  for file in "${files[@]}"; do
    if [[ ! -f "$file" ]]; then
      continue
    fi
    # Each match is read to test it against the allowed one, and only its location is printed.
    while IFS=: read -r line match; do
      if [[ -n "$allowed" ]] && grep -qixE "$allowed" <<<"$match"; then
        continue
      fi
      echo "$file:$line: $kind" >&2
      found=1
    done < <(grep -inoE "$pattern" "$file" || true)
  done
done <<<"$rules"

exit "$found"
