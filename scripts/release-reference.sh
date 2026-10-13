#!/usr/bin/env bash
#/ DESCRIPTION:
#/   Prepares the files of a reference client release: the client file exactly as committed, its
#/   sha256 and the release notes. Refuses a tag whose version is not the one inside the file, so a
#/   release never ships a file that reports another version.
#/
#/ USAGE:
#/   release-reference.sh --tag reference-v<x.y.z> --out <dir> [--help]
#/
#/ SYNOPSIS:
#/   --tag: the release tag, reference-v<MAJOR.MINOR.PATCH>
#/   --out: directory to create for tarjim-reference.js, tarjim-reference.js.sha256 and notes.md
#/   --help: Prints this message

set -euo pipefail
# shellcheck disable=SC2154 # ec is assigned inside the trap string
trap 'ec=$?; echo "[ERROR] $BASH_SOURCE:$LINENO: \"$BASH_COMMAND\" exited with $ec" >&2' ERR

usage() {
  grep '^#/' <"$0" | cut -c 4-
  exit 2
}

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

tag=""
out=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      tag="${2:?--tag requires a value}"
      shift 2
      ;;
    --tag=*)
      tag="${1#*=}"
      shift
      ;;
    --out)
      out="${2:?--out requires a value}"
      shift 2
      ;;
    --out=*)
      out="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "$tag" || -z "$out" ]]; then
  echo "[ERROR] --tag and --out are required" >&2
  usage
fi

source_file="reference/tarjim-reference.js"
if [[ ! -f "$source_file" ]]; then
  fail "run from the repository root: $source_file not found"
fi

if [[ ! "$tag" =~ ^reference-v((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))$ ]]; then
  fail "the tag must be reference-v<MAJOR.MINOR.PATCH>, got $tag"
fi
tag_version="${BASH_REMATCH[1]}"

file_version="$(sed -nE "s/^  var VERSION = '([0-9]+\.[0-9]+\.[0-9]+)';$/\1/p" "$source_file")"
if [[ -z "$file_version" ]]; then
  fail "no VERSION constant found in $source_file"
fi
if [[ "$file_version" != "$tag_version" ]]; then
  fail "the tag says $tag_version but the file says $file_version"
fi

if [[ -e "$out" ]]; then
  fail "$out already exists"
fi
mkdir -p "$out"

cp "$source_file" "$out/tarjim-reference.js"
if ! cmp -s "$source_file" "$out/tarjim-reference.js"; then
  fail "the release file differs from $source_file"
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$out" && sha256sum tarjim-reference.js >tarjim-reference.js.sha256)
else
  (cd "$out" && shasum -a 256 tarjim-reference.js >tarjim-reference.js.sha256)
fi
digest="$(cut -d ' ' -f 1 <"$out/tarjim-reference.js.sha256")"

cat >"$out/notes.md" <<NOTES
**Pre-release: not yet for customers.** Internal testing only.

Download \`tarjim-reference.js\` and host it next to your page; see the README for the snippet.

SHA-256 of \`tarjim-reference.js\`:

\`\`\`
$digest
\`\`\`

A copy you host never updates itself. Watch this repository's releases to learn of fixes.
NOTES

echo "Prepared reference-v$tag_version in $out (sha256 $digest)."
