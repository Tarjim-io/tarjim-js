#!/usr/bin/env bash
#/ DESCRIPTION:
#/   Fills an empty project, made only for fixtures, with invented keys covering every shape the
#/   clients handle: a plain key, a plural with all six forms, a string array, the three
#/   placeholder styles, a media key, an empty value, a tagged key, a key missing in one language
#/   and a mixed-case key name. Languages en and ar must already be on the project.
#/   The key is read from the environment variable TARJIM_RW_KEY only (a read-write key for that
#/   project, not a delivery key); it is never printed or passed on a command line.
#/   Run it once per project: a second run stops at the first key that already exists.
#/
#/ USAGE:
#/   TARJIM_RW_KEY=... seed-fixture-project.sh --api-base <url> --project <id> [--namespace <name>] [--api-version <v>] [--help]
#/
#/ SYNOPSIS:
#/   --api-base: API base URL, https://<host>[:port] (http only for localhost and 127.0.0.1)
#/   --project: numeric project id
#/   --namespace: namespace to create the keys in (default: default)
#/   --api-version: value for X-Tarjim-Api-Version (default: 2026-07-29)
#/   --help: Prints this message

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

api_base=""
project=""
namespace="default"
api_version="2026-07-29"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-base)
      api_base="${2:?--api-base requires a value}"
      shift 2
      ;;
    --api-base=*)
      api_base="${1#*=}"
      shift
      ;;
    --project)
      project="${2:?--project requires a value}"
      shift 2
      ;;
    --project=*)
      project="${1#*=}"
      shift
      ;;
    --namespace)
      namespace="${2:?--namespace requires a value}"
      shift 2
      ;;
    --namespace=*)
      namespace="${1#*=}"
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

if [[ -z "$api_base" || -z "$project" ]]; then
  echo "[ERROR] --api-base and --project are required" >&2
  usage
fi

if [[ -z "${TARJIM_RW_KEY:-}" ]]; then
  fail "TARJIM_RW_KEY is not set"
fi

api_base="${api_base%/}"
https_re='^https://[A-Za-z0-9.-]+(:[0-9]+)?$'
local_re='^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$'
if [[ ! "$api_base" =~ $https_re && ! "$api_base" =~ $local_re ]]; then
  fail "--api-base must be https://<host>[:port] (http only for localhost and 127.0.0.1)"
fi

if [[ ! "$project" =~ ^[0-9]+$ ]]; then
  fail "--project must be a number"
fi

work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT

# The key goes to curl through a header file so it never appears in argv.
umask 077
key_headers="$work/key.hdr"
printf 'X-Tarjim-Apikey: %s\nX-Tarjim-Api-Version: %s\nContent-Type: application/json\n' \
  "$TARJIM_RW_KEY" "$api_version" >"$key_headers"
umask 022

# call <method> <path> [json-body]  -> prints the response body; fails unless the status is 2xx
call() {
  local method="$1" path="$2" body="${3:-}"
  local cfg="$work/curl.cfg" out="$work/response" status
  # A transport failure writes no body; a stale one would be reported as this request's answer.
  rm -f "$out"
  printf 'url = "%s%s"\n' "$api_base" "$path" >"$cfg"
  local args=(-q -sS --max-time 60 -X "$method" -o "$out" -w '%{http_code}' -K "$cfg" -H "@$key_headers")
  if [[ -n "$body" ]]; then
    args+=(--data-binary "$body")
  fi
  status="$(curl "${args[@]}")"
  if [[ ! "$status" =~ ^2 ]]; then
    echo "[ERROR] $method $path answered $status:" >&2
    jq -c '{status, code, detail}' <"$out" >&2 || true
    if [[ "$status" == "409" ]]; then
      echo "[ERROR] the key already exists: this project was seeded before; use a new, empty project" >&2
    fi
    exit 1
  fi
  cat "$out"
}

p="/projects/$project"

languages="$(call GET "$p/languages" | jq -c '[.[].lang]')"
for lang in en ar; do
  if ! jq -e --arg l "$lang" 'index($l) != null' <<<"$languages" >/dev/null; then
    fail "language $lang is not on project $project (it has $languages); add it in the console first"
  fi
done

namespaces="$(call GET "$p/namespaces?limit=100")"
if ! namespace_id="$(jq -er --arg n "$namespace" '.data[] | select(.name == $n) | .id' <<<"$namespaces")"; then
  fail "no namespace named $namespace"
fi

# create_key <name> [extra-json-fields]  -> prints the new key's id
create_key() {
  local name="$1" extra="${2:-}"
  if [[ -z "$extra" ]]; then
    extra='{}'
  fi
  call POST "$p/keys" "$(jq -nc --arg k "$name" --argjson ns "$namespace_id" --argjson x "$extra" '{key: $k, mynamespaceId: $ns} + $x')" \
    | jq -er '.id'
}

# add_child <parent-id> <plurals|string-array-items> <suffix>  -> prints the child's id
add_child() {
  call POST "$p/keys/$1/$2" "$(jq -nc --arg s "$3" '{suffix: $s}')" | jq -er '.id'
}

# set_values <key-id> <en> [<ar>]; an omitted ar leaves that language without a row
set_values() {
  local id="$1" en="$2"
  local values
  values="$(jq -nc --arg en "$en" '[{language: "en", value: $en}]')"
  if [[ $# -ge 3 ]]; then
    values="$(jq -c --arg ar "$3" '. + [{language: "ar", value: $ar}]' <<<"$values")"
  fi
  local response
  response="$(call PUT "$p/keys/$id/values" "$(jq -nc --argjson v "$values" '{values: $v}')")"
  if ! jq -e '(.skipped | length) == 0 and (.blocked | length) == 0' <<<"$response" >/dev/null; then
    fail "values for key $id were not all written: $(jq -c '{skipped, blocked}' <<<"$response")"
  fi
}

id="$(create_key app.title '{"tags":["fixture"]}')"
set_values "$id" "Tarjim" "ترجم"

id="$(create_key cart.items)"
for form in zero one two few many other; do
  child="$(add_child "$id" plurals "$form")"
  case "$form" in
    zero)
      set_values "$child" "No items" "لا عناصر"
      ;;
    one)
      set_values "$child" "One item" "عنصر واحد"
      ;;
    two)
      set_values "$child" "Two items" "عنصران"
      ;;
    few)
      set_values "$child" "%d items" "%d عناصر"
      ;;
    many)
      set_values "$child" "%d items" "%d عنصرًا"
      ;;
    other)
      set_values "$child" "%d items" "%d عنصر"
      ;;
  esac
done

id="$(create_key menu)"
child="$(add_child "$id" string-array-items 0)"
set_values "$child" "Home" "الرئيسية"
child="$(add_child "$id" string-array-items 1)"
set_values "$child" "About" "من نحن"
child="$(add_child "$id" string-array-items 2)"
set_values "$child" "Contact" "اتصل بنا"

id="$(create_key greeting.named)"
set_values "$id" "Welcome, {name}!" "أهلاً، {name}!"
id="$(create_key greeting.printf)"
set_values "$id" "%1\$s has %2\$d messages" "لدى %1\$s %2\$d رسائل"
id="$(create_key greeting.legacy)"
set_values "$id" "Hello %%name%%" "مرحباً %%name%%"

id="$(create_key hero.image '{"type":"image"}')"
set_values "$id" "https://media.example.com/hero.png" "https://media.example.com/hero-ar.png"

id="$(create_key empty.value)"
set_values "$id" "" ""

id="$(create_key only.english)"
set_values "$id" "English only"

id="$(create_key Case.Sensitive)"
set_values "$id" "Upper case key" "مفتاح بأحرف كبيرة"

echo "Seeded project $project, namespace $namespace: 10 keys (plural with 6 forms, string array with 3 items)."
echo "Not settable through the API: attributes on hero.image. Add alt/title/width in the console if the console allows it."
echo "Next: release the track in the console, move the qa stage to that release, then capture."
