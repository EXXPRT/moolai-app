#!/bin/sh
set -eu
cd "$(dirname "$0")"
bundle="build/Moolai Native.app"
mkdir -p "$bundle/Contents/MacOS" build/module-cache
swiftc -swift-version 5 -parse-as-library -O -module-cache-path "$PWD/build/module-cache" \
  -target arm64-apple-macosx14.0 TranscriptAssembler.swift VoiceActivity.swift MoolaiNative.swift \
  -framework AppKit -framework AVFoundation -framework ScreenCaptureKit \
  -o "$bundle/Contents/MacOS/MoolaiNative"
cp Info.plist "$bundle/Contents/Info.plist"
codesign --force --sign - --identifier com.exxprt.moolai.native "$bundle"
printf 'Built %s\n' "$PWD/$bundle"
