#!/bin/bash
# Double-click this to start the helper. It runs right here in this window
# so you can see the pairing code and stop it with Control-C.
cd "$(dirname "$0")"
exec "./tagit Photos Helper.app/Contents/MacOS/PhotosHelper" "$@"
