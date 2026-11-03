#!/usr/bin/env bash
# Fails unless the pinned Xcode is the expected stable release. A beta can live at
# /Applications/Xcode.app, so the path alone proves nothing: check the reported
# version and build too.
set -euo pipefail

: "${DEVELOPER_DIR:?DEVELOPER_DIR must name the pinned Xcode}"
: "${XCODE_EXPECTED_VERSION:?XCODE_EXPECTED_VERSION is required, for example 27.1}"

xcodebuild_path="$(xcrun --find xcodebuild)"
version_output="$(xcodebuild -version)"
echo "DEVELOPER_DIR=$DEVELOPER_DIR"
echo "xcodebuild=$xcodebuild_path"
echo "$version_output"

fail() {
  echo "::error::$1" >&2
  exit 1
}

version_line="$(printf '%s\n' "$version_output" | sed -n '1p')"
build_line="$(printf '%s\n' "$version_output" | sed -n 's/^Build version //p')"

shopt -s nocasematch
[[ "$DEVELOPER_DIR" == *beta* || "$xcodebuild_path" == *beta* || "$version_line" == *beta* ]] &&
  fail "Selected Xcode looks like a beta."
shopt -u nocasematch
[[ "$xcodebuild_path" == "$DEVELOPER_DIR"/* ]] ||
  fail "xcodebuild does not come from DEVELOPER_DIR."
[[ "$version_line" == "Xcode $XCODE_EXPECTED_VERSION" ]] ||
  fail "Expected Xcode $XCODE_EXPECTED_VERSION, got: $version_line"
[[ "$build_line" =~ ^[0-9A-Z]+[0-9]$ ]] ||
  fail "Build version '$build_line' is not a release build (beta builds end in a letter)."
