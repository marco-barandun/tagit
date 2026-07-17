#!/bin/bash
# Double-click this to try tagit's Photos integration with fake sample
# photos only — nothing in your real Photos library is touched.
cd "$(dirname "$0")"
exec "./tagit Photos Helper.app/Contents/MacOS/PhotosHelper" --demo "$@"
