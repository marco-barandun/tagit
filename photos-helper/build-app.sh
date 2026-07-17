#!/bin/bash
# Builds the release binary and assembles it into a minimal, invisible app
# bundle (no Dock icon, no Applications-folder install). The bundle is what
# lets the Limited Photos picker window appear at all — a bare command-line
# tool can't show system picker UI.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="tagit Photos Helper.app"
DIST="dist"
BUNDLE="$DIST/$APP_NAME"

echo "Building release binary..."
swift build -c release

echo "Assembling app bundle at $BUNDLE ..."
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS"
cp AppBundle/Info.plist "$BUNDLE/Contents/Info.plist"
cp .build/release/PhotosHelper "$BUNDLE/Contents/MacOS/PhotosHelper"
chmod +x "$BUNDLE/Contents/MacOS/PhotosHelper"

LAUNCHER="$DIST/Start tagit Photos Helper.command"
cat > "$LAUNCHER" << 'EOF'
#!/bin/bash
# Double-click this to start the helper. It runs right here in this window
# so you can see the pairing code and stop it with Control-C.
cd "$(dirname "$0")"
exec "./tagit Photos Helper.app/Contents/MacOS/PhotosHelper" "$@"
EOF
chmod +x "$LAUNCHER"

DEMO_LAUNCHER="$DIST/Try Demo Mode.command"
cat > "$DEMO_LAUNCHER" << 'EOF'
#!/bin/bash
# Double-click this to try tagit's Photos integration with fake sample
# photos only — nothing in your real Photos library is touched.
cd "$(dirname "$0")"
exec "./tagit Photos Helper.app/Contents/MacOS/PhotosHelper" --demo "$@"
EOF
chmod +x "$DEMO_LAUNCHER"

echo ""
echo "Done. In $DIST/:"
echo "  - Start tagit Photos Helper.command  (real Photos library)"
echo "  - Try Demo Mode.command              (fake data, safe to try first)"
