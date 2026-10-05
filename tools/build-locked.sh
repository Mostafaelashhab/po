#!/bin/sh
# Builds the locked copy to share: ../po-bot-locked/ and ../po-bot-locked.zip (load it unpacked in Chrome).
# The owner's copy (this folder) stays unlocked. Data never travels: it lives in the owner's Chrome profile.
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$SRC/../po-bot-locked"
rm -rf "$OUT" "$OUT.zip"
mkdir -p "$OUT"
rsync -a --exclude tests --exclude tools --exclude node_modules --exclude .git --exclude README.md --exclude README.legacy.md --exclude package.json --exclude '*.zip' "$SRC/" "$OUT/"
cat > "$OUT/edition.js" <<'JS'
// Locked edition: the panel stays on "استراتيجيات يوتيوب"; stake, Start / Stop and demo-only are the only controls.
globalThis.PO_EDITION = { locked: true };
JS
# its own name, so it can't be mistaken for the owner's copy in chrome://extensions
python3 - "$OUT/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]; m = json.load(open(p)); m["name"] = "استراتيجيات mostafa elashhab"; m["action"]["default_title"] = "استراتيجيات mostafa elashhab"
json.dump(m, open(p, "w"), ensure_ascii=False, indent=2)
PY
(cd "$OUT/.." && zip -qr "po-bot-locked.zip" "po-bot-locked")
echo "built: $OUT and $OUT.zip"
