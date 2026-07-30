#!/usr/bin/env bash
#
# Generates the Product 2.2 client with Apple's Swift OpenAPI Generator and
# compiles it for a real iOS Simulator SDK. All package/build artifacts live in
# a disposable directory; nothing generated is committed to the server repo.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly FIXTURE_ROOT="$REPO_ROOT/scripts/test/swift-openapi-client"
readonly CONTRACT_PATH="$REPO_ROOT/openapi/product-2.2.openapi.json"

blocked() {
  echo "BLOCKED_WITH_REASON: $1" >&2
  exit 2
}

command -v xcodebuild >/dev/null 2>&1 \
  || blocked "Xcode is required for the iOS generated-client contract gate."
command -v swift >/dev/null 2>&1 \
  || blocked "Swift is required for the iOS generated-client contract gate."

[[ -f "$CONTRACT_PATH" ]] || blocked "The Product 2.2 OpenAPI document is missing."
[[ -f "$FIXTURE_ROOT/Package.resolved" ]] \
  || blocked "Package.resolved is required to pin the generator and runtime."

readonly WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gamepedia-ios-openapi.XXXXXX")"

cleanup() {
  rm -rf "$WORK_DIR"
}

trap cleanup EXIT INT TERM

cp -R "$FIXTURE_ROOT/." "$WORK_DIR/"
cp "$CONTRACT_PATH" "$WORK_DIR/Sources/ContractSmoke/openapi.yaml"

cd "$WORK_DIR"

echo "Resolving the pinned Apple Swift OpenAPI packages."
swift package resolve
cmp -s Package.resolved "$FIXTURE_ROOT/Package.resolved" \
  || blocked "Swift package resolution changed the committed dependency lock."

echo "Generating the client and decoding representative Today payloads on the host."
readonly HOST_LOG="$WORK_DIR/swift-run.log"

if ! swift run ContractSmoke >"$HOST_LOG" 2>&1; then
  sed -n '1,240p' "$HOST_LOG" >&2
  exit 1
fi

if grep -Eq '(^|[[:space:]])warning:' "$HOST_LOG"; then
  grep -E '(^|[[:space:]])warning:' "$HOST_LOG" >&2
  blocked "Swift OpenAPI Generator emitted a warning."
fi

echo "Generating and compiling the Product 2.2 client for the iOS Simulator SDK."
readonly BUILD_LOG="$WORK_DIR/xcodebuild.log"

if ! xcodebuild \
    -quiet \
    -scheme GamePediaProduct22Contract \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$WORK_DIR/DerivedData" \
    -clonedSourcePackagesDirPath "$WORK_DIR/SourcePackages" \
    -skipPackagePluginValidation \
    CODE_SIGNING_ALLOWED=NO \
    build >"$BUILD_LOG" 2>&1; then
  sed -n '1,240p' "$BUILD_LOG" >&2
  exit 1
fi

if grep -Eq '(^|[[:space:]])warning:' "$BUILD_LOG"; then
  grep -E '(^|[[:space:]])warning:' "$BUILD_LOG" >&2
  blocked "The generated iOS client build emitted a warning."
fi

echo "iOS generated-client contract gate passed."
