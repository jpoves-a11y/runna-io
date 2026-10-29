#!/usr/bin/env bash
# Archives, signs, checks and uploads the app to App Store Connect (TestFlight).
# Used by .github/workflows/testflight.yml and codemagic.yaml. Run from anywhere on a Mac with Xcode 26.
#
# Environment:
#   ASC_KEY_ID, ASC_ISSUER_ID   App Store Connect API key (Admin role)
#   ASC_KEY_P8                  contents of the .p8 key
#   APPLE_TEAM_ID               Apple Developer team ID
#   BUILD_NUMBER                CFBundleVersion for this upload (must be higher than the last one)
#   WORK_DIR                    scratch directory (default: a temporary one)
#   SKIP_UPLOAD=1               stop after checking the IPA
#
# The archive is made WITHOUT signing (automatic signing on a CI Mac creates a new "Apple Development"
# certificate every run, until the account hits Apple's limit). Each bundle then gets an ad-hoc
# signature carrying its entitlements, and the export signs everything with Apple's cloud-managed
# distribution certificate through the API key: no certificate or private key on the machine.
set -euo pipefail

: "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_KEY_P8:?}" "${APPLE_TEAM_ID:?}" "${BUILD_NUMBER:?}"
IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="${WORK_DIR:-$(mktemp -d)}"
mkdir -p "$WORK_DIR/keys"
KEY_FILE="$WORK_DIR/keys/AuthKey_$ASC_KEY_ID.p8"
printf '%s\n' "$ASC_KEY_P8" > "$KEY_FILE"
trap 'rm -rf "$WORK_DIR/keys"' EXIT
cd "$IOS_DIR"

echo "== Archive (Release, unsigned), build $BUILD_NUMBER"
xcodebuild archive \
  -project Runna.xcodeproj \
  -scheme Runna \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$WORK_DIR/Runna.xcarchive" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  > "$WORK_DIR/archive.log" 2>&1 || { grep -E "error:" "$WORK_DIR/archive.log" | sort -u; tail -60 "$WORK_DIR/archive.log"; exit 1; }

echo "== Entitlements (ad-hoc signature, inside out)"
APP="$WORK_DIR/Runna.xcarchive/Products/Applications/Runna.app"
# TestFlight and App Store builds use the production APNs environment
cp Config/Runna.entitlements "$WORK_DIR/Runna.entitlements"
/usr/libexec/PlistBuddy -c "Set :aps-environment production" "$WORK_DIR/Runna.entitlements"
for appex in "$APP"/PlugIns/*.appex; do
  name="$(basename "$appex" .appex)"
  if [ -f "Config/$name.entitlements" ]; then
    codesign --force --sign - --timestamp=none --entitlements "Config/$name.entitlements" "$appex"
  else
    codesign --force --sign - --timestamp=none "$appex"
  fi
done
codesign --force --sign - --timestamp=none --entitlements "$WORK_DIR/Runna.entitlements" "$APP"

echo "== Export (App Store, cloud-managed distribution signing)"
cat > "$WORK_DIR/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
PLIST
xcodebuild -exportArchive \
  -archivePath "$WORK_DIR/Runna.xcarchive" \
  -exportOptionsPlist "$WORK_DIR/ExportOptions.plist" \
  -exportPath "$WORK_DIR/export" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_FILE" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  > "$WORK_DIR/export.log" 2>&1 || { grep -E "error" "$WORK_DIR/export.log" | sort -u; tail -60 "$WORK_DIR/export.log"; exit 1; }
IPA="$(ls "$WORK_DIR"/export/*.ipa | head -1)"
echo "IPA: $IPA"

echo "== Check signature and entitlements of every bundle"
rm -rf "$WORK_DIR/ipa" && mkdir -p "$WORK_DIR/ipa"
unzip -q "$IPA" -d "$WORK_DIR/ipa"
APP="$WORK_DIR/ipa/Payload/Runna.app"
fail=0
check() { # bundle, signed entitlements plist, key, expected value ("" = must exist)
  local value
  if ! value=$(/usr/libexec/PlistBuddy -c "Print :$3" "$2" 2>/dev/null); then
    echo "ERROR: $(basename "$1") is missing the entitlement $3"; fail=1
  elif [ -n "$4" ] && [ "$value" != "$4" ]; then
    echo "ERROR: $(basename "$1"): $3 is '$value', expected '$4'"; fail=1
  fi
}
for name in RunnaLive RunnaNotificationService; do
  [ -d "$APP/PlugIns/$name.appex" ] || { echo "ERROR: $name.appex is missing from the IPA"; fail=1; }
done
for bundle in "$APP" "$APP"/PlugIns/*.appex; do
  name="$(basename "$bundle")"
  echo "-- $name"
  codesign -dvv "$bundle" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier)=" || true
  codesign -dvv "$bundle" 2>&1 | grep -q "^Authority=Apple Distribution" || { echo "ERROR: $name is not signed with Apple Distribution"; fail=1; }
  codesign --verify --strict "$bundle" || { echo "ERROR: $name has an invalid signature"; fail=1; }
  codesign -d --entitlements - --xml "$bundle" > "$WORK_DIR/$name.ent.plist" 2>/dev/null
  plutil -p "$WORK_DIR/$name.ent.plist"
  check "$bundle" "$WORK_DIR/$name.ent.plist" application-identifier ""
  check "$bundle" "$WORK_DIR/$name.ent.plist" get-task-allow false
  # Every entitlement in the bundle's file must survive the export (e.g. the widget's App Group)
  source_ent="Config/${name%.*}.entitlements"
  [ "$name" = "Runna.app" ] && source_ent="$WORK_DIR/Runna.entitlements"
  if [ -f "$source_ent" ]; then
    for key in $(/usr/libexec/PlistBuddy -c "Print" "$source_ent" | sed -n 's/^    \([A-Za-z0-9._-]*\) = .*/\1/p'); do
      check "$bundle" "$WORK_DIR/$name.ent.plist" "$key" ""
    done
  fi
done
check "$APP" "$WORK_DIR/Runna.app.ent.plist" aps-environment production
check "$APP" "$WORK_DIR/Runna.app.ent.plist" com.apple.developer.healthkit true
[ "$fail" = 0 ] || exit 1

if [ "${SKIP_UPLOAD:-0}" = 1 ]; then
  echo "SKIP_UPLOAD=1: not uploading"
  exit 0
fi

echo "== Upload to App Store Connect"
API_PRIVATE_KEYS_DIR="$WORK_DIR/keys" xcrun altool --upload-app --type ios \
  --file "$IPA" --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" \
  > "$WORK_DIR/upload.log" 2>&1 || { cat "$WORK_DIR/upload.log"; exit 1; }
tail -5 "$WORK_DIR/upload.log"
echo "Uploaded build $BUILD_NUMBER. It shows up in TestFlight once Apple has processed it (10-30 min)."
