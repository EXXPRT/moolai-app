#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p build/module-cache
swiftc -swift-version 5 -parse-as-library -module-cache-path "$PWD/build/module-cache" \
  TranscriptAssembler.swift TranscriptAssemblerTests.swift -o build/transcript-tests
build/transcript-tests
