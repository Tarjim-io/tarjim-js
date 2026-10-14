#!/usr/bin/env bash
#/ DESCRIPTION:
#/   Checks a package release tag and prints the npm dist-tag to publish under. Refuses a tag that
#/   is not v<X.Y.Z>, v<X.Y.Z>-alpha.<N> or v<X.Y.Z>-beta.<N>, and a tag whose version differs from
#/   the version of any of the three packages or from SDK_VERSION. Run it from the repository root.
#/
#/ USAGE:
#/   release-packages.sh --tag v<version> [--help]
#/
#/ SYNOPSIS:
#/   --tag: the release tag; -alpha.N publishes as alpha, -beta.N as beta, a plain version as latest
#/   --help: Prints this message
#/
#/ Prints only the dist-tag on stdout.

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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      if [[ $# -lt 2 ]]; then
        fail "--tag requires a value"
      fi
      tag="$2"
      shift 2
      ;;
    --tag=*)
      tag="${1#*=}"
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

num='(0|[1-9][0-9]*)'
pattern="^v(${num}\\.${num}\\.${num}(-(alpha|beta)\\.${num})?)\$"
if [[ ! "$tag" =~ $pattern ]]; then
  fail "the tag must be v<X.Y.Z>, v<X.Y.Z>-alpha.<N> or v<X.Y.Z>-beta.<N>, got \"$tag\""
fi
version="${BASH_REMATCH[1]}"
channel="${BASH_REMATCH[6]:-latest}"

for name in core browser react; do
  manifest="packages/$name/package.json"
  if [[ ! -f "$manifest" ]]; then
    fail "run from the repository root: $manifest not found"
  fi
  found="$(sed -nE 's/^[[:space:]]*"version": "([^"]*)".*$/\1/p' "$manifest" | head -n 1)"
  if [[ "$found" != "$version" ]]; then
    fail "the tag says $version but packages/$name says ${found:-no version}"
  fi
done

version_file="packages/core/src/version.ts"
if [[ ! -f "$version_file" ]]; then
  fail "run from the repository root: $version_file not found"
fi
sdk_version="$(sed -nE "s/^export const SDK_VERSION = '([^']*)';.*$/\1/p" "$version_file")"
if [[ "$sdk_version" != "$version" ]]; then
  fail "the tag says $version but SDK_VERSION says ${sdk_version:-nothing}"
fi

echo "$channel"
