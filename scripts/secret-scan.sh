#!/usr/bin/env bash
#/ DESCRIPTION:
#/   Fails when a file carries a Tarjim API key or a CloudFront signature, policy or key pair id.
#/   Prints file:line and the kind of secret, never the secret. Placeholders pass: keys under
#/   tenant 0 (`tarjim-0-0-0-…`), REDACTED values and short test values such as `Signature=S1`.
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

# kind<TAB>extended regex. A real key has numeric tenant, project and user ids and a long random
# tail; a real signature, policy or key pair id is far longer than any test value.
rules=$(cat <<'RULES'
API key	tarjim-[1-9][0-9]*-[0-9]+-[0-9]+-[A-Za-z0-9]{16,}
CloudFront signature	Signature=[A-Za-z0-9~_-]{20,}
CloudFront policy	Policy=[A-Za-z0-9~_-]{20,}
CloudFront key pair id	Key-Pair-Id=[A-Z0-9]{10,}
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
while IFS=$'\t' read -r kind pattern; do
  for file in "${files[@]}"; do
    if [[ ! -f "$file" ]]; then
      continue
    fi
    # -n for the line number, -o would print the secret: print only the location.
    while IFS=: read -r line _; do
      echo "$file:$line: $kind" >&2
      found=1
    done < <(grep -nE "$pattern" "$file" || true)
  done
done <<<"$rules"

exit "$found"
