#!/usr/bin/env bash
#/ DESCRIPTION:
#/   Records a stage's current release from the delivery routes into the layout the fixture tests
#/   read (see test/fixtures/README.md): meta.<mode>.json, manifest.json, every object the manifest
#/   lists, and the answers to a request with an invalid key and one without appVersion. The
#/   manifest is checked against meta.checksum and every object against its manifest hash before
#/   anything is written, and the hash chain is checked again on the written copy.
#/   Only meta is rewritten: the host becomes *.invalid, the signature a placeholder, and the
#/   tenant and project ids 1. The manifest and the objects are kept byte for byte, so record
#/   only from a project made for fixtures — never from one with real content or users.
#/   The API key is read from the environment variable TARJIM_APIKEY only; it is never printed,
#/   written to disk outside a private temporary directory, or passed on a command line.
#/   Re-run it to replace a recording: write to a new --out, then swap the directories.
#/
#/ USAGE:
#/   TARJIM_APIKEY=... capture-fixtures.sh --delivery-url <url> --app-version <x.y.z> --out <dir> [--api-version <v>] [--help]
#/
#/ SYNOPSIS:
#/   --delivery-url: the meta URL copied from the console: https://<host>/t/<tenant>/projects/<project>/delivery/meta
#/                   (http only for localhost and 127.0.0.1)
#/   --app-version: MAJOR.MINOR.PATCH sent as ?appVersion=
#/   --out: recording directory to create; must not exist
#/   --api-version: value for X-Tarjim-Api-Version (default: 2026-07-29)
#/   --help: Prints this message
#/
#/ Afterwards move the directory to test/fixtures/recorded/<name>/ and run `pnpm test`: its leak
#/ scan must pass before the recording is committed. A recording it flags is captured again, never
#/ edited — an edit breaks the hashes.

set -euo pipefail
# shellcheck disable=SC2154 # ec is assigned inside the trap string
trap 'ec=$?; echo "[ERROR] $BASH_SOURCE:$LINENO: \"$BASH_COMMAND\" exited with $ec" >&2' ERR

usage() {
  grep '^#/' <"$0" | cut -c 4-
  exit 2
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[ERROR] missing: $1" >&2
    exit 127
  fi
}

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

need curl
need jq

delivery_url=""
app_version=""
out=""
api_version="2026-07-29"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --delivery-url)
      delivery_url="${2:?--delivery-url requires a value}"
      shift 2
      ;;
    --delivery-url=*)
      delivery_url="${1#*=}"
      shift
      ;;
    --app-version)
      app_version="${2:?--app-version requires a value}"
      shift 2
      ;;
    --app-version=*)
      app_version="${1#*=}"
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
    --api-version)
      api_version="${2:?--api-version requires a value}"
      shift 2
      ;;
    --api-version=*)
      api_version="${1#*=}"
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

if [[ -z "$delivery_url" || -z "$app_version" || -z "$out" ]]; then
  echo "[ERROR] --delivery-url, --app-version and --out are required" >&2
  usage
fi

if [[ -z "${TARJIM_APIKEY:-}" ]]; then
  fail "TARJIM_APIKEY is not set"
fi

# No userinfo, query, fragment or trailing slash: the key must go to the host the operator typed.
url_path='/t/[0-9]+/projects/[0-9]+/delivery/meta'
https_re="^https://[A-Za-z0-9.-]+(:[0-9]+)?${url_path}\$"
local_re="^http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?${url_path}\$"
if [[ ! "$delivery_url" =~ $https_re && ! "$delivery_url" =~ $local_re ]]; then
  fail "--delivery-url must be https://<host>/t/<tenant>/projects/<project>/delivery/meta (http only for localhost)"
fi

if [[ ! "$app_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  fail "--app-version must be MAJOR.MINOR.PATCH"
fi

if [[ -e "$out" ]]; then
  fail "$out already exists; recordings are never overwritten"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
else
  need shasum
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
fi

# Everything is staged here and moved to --out only after every check has passed.
work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT

# curl reads headers and URLs from files (-H @file, -K file) so neither the key nor a signed query
# appears in argv, where `ps` shows it.
umask 077
key_headers="$work/key.hdr"
bad_key_headers="$work/badkey.hdr"
printf 'X-Tarjim-Apikey: %s\nX-Tarjim-Api-Version: %s\n' "$TARJIM_APIKEY" "$api_version" >"$key_headers"
printf 'X-Tarjim-Apikey: tarjim-0-0-0-invalid\nX-Tarjim-Api-Version: %s\n' "$api_version" >"$bad_key_headers"
umask 022

stage="$work/stage"
mkdir -p "$stage/objects" "$stage/errors"
recorded_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

safe_url_re='^[A-Za-z0-9._~:/?&=%+,-]+$'

# fetch <url> <body-file> <headers-dump-file> [header-file]  -> prints the HTTP status
fetch() {
  local url="$1" body="$2" dump="$3" hdr="${4:-}"
  if [[ ! "$url" =~ $safe_url_re ]]; then
    fail "refusing a URL with unexpected characters"
  fi
  local cfg
  cfg="$(mktemp "$work/curl.XXXXXX")"
  printf 'url = "%s"\n' "$url" >"$cfg"
  # -q first: a ~/.curlrc must not add options. No redirects are followed, so the key stays on one host.
  local args=(-q -sS --compressed --max-time 60 -D "$dump" -o "$body" -w '%{http_code}' -K "$cfg")
  if [[ -n "$hdr" ]]; then
    args+=(-H "@$hdr")
  fi
  curl "${args[@]}"
}

# problem_code <body-file>  -> " (<code>)" for a problem+json body, else nothing
problem_code() {
  local code
  if code="$(jq -er '.code | strings' <"$1" 2>/dev/null)"; then
    printf ' (%s)' "$code"
  fi
}

# Content-Encoding is not kept: bodies are stored decoded.
keep_headers='["Content-Type","Cache-Control","ETag","Retry-After","X-Tarjim-Api-Version"]'

# write_envelope <status> <headers-dump> <body-file> <dest>
write_envelope() {
  local status="$1" dump="$2" body="$3" dest="$4"
  local headers
  headers="$(jq -Rs --argjson keep "$keep_headers" '
    split("\n")
    | map(rtrimstr("\r") | select(test("^[A-Za-z0-9-]+:")))
    | map(capture("^(?<k>[^:]+):[ \t]*(?<v>.*)$"))
    | map(. as $h | ($keep[] | select(ascii_downcase == ($h.k | ascii_downcase))) as $name | {key: $name, value: $h.v})
    | from_entries' <"$dump")"
  jq -n --arg at "$recorded_at" --argjson status "$status" --argjson headers "$headers" --rawfile body "$body" \
    '{provenance: "recorded", recordedAt: $at, status: $status, headers: $headers, body: $body}' >"$dest"
}

# The query is raw and the only one: the server validates the undecoded string.
meta_url="$delivery_url?appVersion=$app_version"
# Relative references in meta resolve against the directory of the meta URL.
meta_base="${delivery_url%/*}/"

status="$(fetch "$meta_url" "$work/meta.body" "$work/meta.hdr" "$key_headers")"
if [[ "$status" != "200" ]]; then
  fail "meta answered $status$(problem_code "$work/meta.body"), expected 200"
fi

# A failing jq aborts the run: command substitution in an assignment propagates its status.
checksum="$(jq -er '.checksum | strings' <"$work/meta.body")"
authenticated="$(jq -er '.authenticated | booleans | tostring' <"$work/meta.body")"
manifest_ref="$(jq -er '.manifestUrl | strings' <"$work/meta.body")"
slices_ref="$(jq -er '.slicesBaseUrl | strings' <"$work/meta.body")"

if [[ "$authenticated" == "true" ]]; then
  mode="origin"
  asset_headers="$key_headers"
  # Origin URLs are path-relative; anything else could send the key to another host.
  for ref in "$manifest_ref" "$slices_ref"; do
    if [[ "$ref" == *://* || "$ref" == /* || "$ref" == *..* ]]; then
      fail "origin-mode meta carries a URL that is not path-relative"
    fi
  done
  manifest_url="$meta_base$manifest_ref"
  slices_url="$meta_base$slices_ref"
  signed_query=""
else
  mode="cdn"
  # Object requests in CDN mode carry no key and no custom header.
  asset_headers=""
  for ref in "$manifest_ref" "$slices_ref"; do
    if [[ "$ref" != https://* ]]; then
      fail "CDN-mode meta carries a URL that is not https"
    fi
  done
  signed_query="$(jq -er '.signedQuery | strings' <"$work/meta.body")"
  manifest_url="$manifest_ref?$signed_query"
  slices_url="$slices_ref"
fi

status="$(fetch "$manifest_url" "$stage/manifest.json" "$work/manifest.hdr" "$asset_headers")"
if [[ "$status" != "200" ]]; then
  fail "manifest answered $status$(problem_code "$stage/manifest.json"), expected 200"
fi
if [[ "$(sha256 "$stage/manifest.json")" != "$checksum" ]]; then
  fail "manifest sha256 does not match meta.checksum"
fi

objects="$(jq -er '[.slices[] | .[] | to_entries[] | "\(.value.hash) \(.key)"] | unique | .[]' <"$stage/manifest.json")" || fail "the manifest is not valid or lists no objects"

object_count=0
while read -r hash file_type; do
  if [[ ! "$hash" =~ ^[0-9a-f]{64}$ || ! "$file_type" =~ ^[a-z]+$ ]]; then
    fail "the manifest lists a malformed object: $hash $file_type"
  fi
  object="$hash.$file_type"
  url="$slices_url$object"
  if [[ "$mode" == "cdn" ]]; then
    url="$url?$signed_query"
  fi
  status="$(fetch "$url" "$stage/objects/$object" "$work/object.hdr" "$asset_headers")"
  if [[ "$status" != "200" ]]; then
    fail "object $object answered $status$(problem_code "$stage/objects/$object"), expected 200"
  fi
  if [[ "$(sha256 "$stage/objects/$object")" != "$hash" ]]; then
    fail "object $object does not match its manifest hash"
  fi
  object_count=$((object_count + 1))
done <<<"$objects"

# meta only: the real host, the live signature and the real tenant and project ids go. Ids are
# rewritten wherever they appear as path segments, so relative and CDN URLs stay consistent.
tenant_id="$(sed -E 's#^.*/t/([0-9]+)/projects/.*$#\1#' <<<"$delivery_url")"
project_id="$(sed -E 's#^.*/projects/([0-9]+)/delivery/meta$#\1#' <<<"$delivery_url")"
jq -ec --arg t "$tenant_id" --arg p "$project_id" '
  def redact_host: if test("^[A-Za-z][A-Za-z0-9+.-]*://") then sub("^(?<s>[A-Za-z][A-Za-z0-9+.-]*://)[^/]+"; "\(.s)cdn.example.invalid") else . end;
  def redact_ids: gsub("/t/\($t)/"; "/t/1/") | gsub("/projects/\($p)/"; "/projects/1/") | gsub("/\($t)/\($p)/"; "/1/1/");
  .manifestUrl |= (redact_host | redact_ids)
  | .slicesBaseUrl |= (redact_host | redact_ids)
  | if has("projectId") then .projectId = 1 else . end
  | if has("signedQuery") and .signedQuery != null then .signedQuery = "Policy=REDACTED&Signature=REDACTED&Key-Pair-Id=REDACTED" else . end
' <"$work/meta.body" | tr -d '\n' >"$work/meta.redacted"
if grep -qE "Signature=[^R]|Key-Pair-Id=[^R]" "$work/meta.redacted"; then
  fail "the scrubbed meta still carries a signature"
fi
# CDN paths differ by delivery mode (`releases/<t>/<p>/`, `builds/<t>/<p>/`); a form the rewrite
# does not know must stop the capture, not reach a public fixture.
if jq -r '.manifestUrl, .slicesBaseUrl' <"$work/meta.redacted" | grep -qE "/(t/)?${tenant_id}/(projects/)?${project_id}/"; then
  fail "the scrubbed meta still carries the real tenant and project ids"
fi
write_envelope 200 "$work/meta.hdr" "$work/meta.redacted" "$stage/meta.$mode.json"

# Error bodies are not hash-chained, so their ids (an `instance` path, say) are rewritten too.
redact_ids() {
  sed -E -i.bak "s#/t/${tenant_id}/#/t/1/#g; s#/projects/${project_id}/#/projects/1/#g" "$1"
  rm -f "$1.bak"
}

status="$(fetch "$meta_url" "$work/e401.body" "$work/e401.hdr" "$bad_key_headers")"
if [[ "$status" != "401" ]]; then
  fail "meta with an invalid key answered $status, expected 401"
fi
redact_ids "$work/e401.body"
write_envelope 401 "$work/e401.hdr" "$work/e401.body" "$stage/errors/meta-401-unauthorized.json"

status="$(fetch "$delivery_url" "$work/e400.body" "$work/e400.hdr" "$key_headers")"
if [[ "$status" != "400" ]]; then
  fail "meta without appVersion answered $status, expected 400"
fi
redact_ids "$work/e400.body"
write_envelope 400 "$work/e400.hdr" "$work/e400.body" "$stage/errors/meta-400-app-version-required.json"

jq -n --arg at "$recorded_at" --arg v "$app_version" --arg mode "$mode" \
  '{recordedAt: $at, deliveryUrl: "https://delivery.example.invalid/t/1/projects/1/delivery/meta", appVersion: $v, mode: $mode}' \
  >"$stage/recording.json"

# The chain again, on what will be committed: scrubbed meta -> manifest -> objects.
written_checksum="$(jq -r '.body' <"$stage/meta.$mode.json" | jq -er '.checksum | strings')"
if [[ "$(sha256 "$stage/manifest.json")" != "$written_checksum" ]]; then
  fail "the written manifest does not match the written meta.checksum"
fi
while read -r hash file_type; do
  if [[ "$(sha256 "$stage/objects/$hash.$file_type")" != "$hash" ]]; then
    fail "the written object $hash.$file_type does not match its hash"
  fi
done <<<"$objects"

mkdir -p "$(dirname "$out")"
mv "$stage" "$out"
chmod 755 "$out"

echo "Recorded the $mode-mode release into $out:"
echo "  meta.$mode.json, manifest.json, $object_count objects, errors/meta-401-unauthorized.json, errors/meta-400-app-version-required.json"
echo "Move it to test/fixtures/recorded/<name>/ and run 'pnpm test' (the leak scan) before committing. Nothing was staged in git."
