#!/usr/bin/env bash
# Usage: .github/scripts/sync-labels.sh [--repo owner/name] [--dry-run]
set -euo pipefail

repo=""
dry_run=false
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?--repo needs a value}"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null || { echo "gh CLI is required: https://cli.github.com" >&2; exit 1; }

manifest="$(dirname "$0")/../labels.yml"
[ -f "$manifest" ] || { echo "manifest not found: $manifest" >&2; exit 1; }

# Parse without a YAML dependency: the manifest's shape is fixed to repeating
# name/color/description triples, so a line-wise reader is enough.
name="" color="" description=""

flush() {
  [ -n "$name" ] || return 0
  if $dry_run; then
    printf 'would sync %s (%s)\n' "$name" "$color"
  else
    gh label create "$name" \
      --color "$color" \
      --description "$description" \
      --force \
      ${repo:+--repo "$repo"} >/dev/null
    printf 'synced %s\n' "$name"
  fi
  name="" color="" description=""
}

strip() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  v="${v#\"}"
  v="${v%\"}"
  printf '%s' "$v"
}

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '#'*|'') continue ;;
    '- name:'*) flush; name="$(strip "${line#- name:}")" ;;
    *'color:'*) color="$(strip "${line#*color:}")" ;;
    *'description:'*) description="$(strip "${line#*description:}")" ;;
  esac
done < "$manifest"
flush
