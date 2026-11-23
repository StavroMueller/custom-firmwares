#!/usr/bin/env bash
# Re-fetch the archive.org AlphaSmart 3000 discs into ../archive/ (gitignored),
# verify checksums, and extract them. Needs: curl, sha256sum, unzip, python3 + pycdlib.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/../archive"

# local dir | archive.org item | file in item | sha256
items=(
  "as-2-2000|as-2-2000|AS-2-2000.iso|a2b0dbe26df0bbd1041057873c1a32e2196046a2eab88a38dacaa64c7d60fb82"
  "simulator|Alphasmart|AlphaSmart.iso|a7d350d2bd8586b0bba414b83bb9a8ec298faa6b0b2fbb17a3f1fd0305ae0b31"
  "smartinput-2003|smartinput-may-12-2003|Smartinput-May-12-2003.iso|550d41c6bf29652fd51ec293b463f9e8e9b06942a365060a7567ee2c5bee1549"
  "asm-manager-2.3|asm-3000-manager-2.3-full-1|ASM3000Manager2.3Full(1).zip|4cffc8dd39169421f4a3369ea90308cb3864a02ef82a5904e97061b44fb67380"
)

for entry in "${items[@]}"; do
  IFS='|' read -r dir item file sha <<<"$entry"
  out="$dest/$dir/$file"
  mkdir -p "$dest/$dir"

  if [[ ! -f "$out" ]]; then
    echo "fetching $item/$file"
    curl -fsSL -o "$out" "https://archive.org/download/$item/$(python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))" "$file")"
  fi
  echo "$sha  $out" | sha256sum -c --quiet

  if [[ ! -d "$dest/$dir/extracted" ]]; then
    case "$file" in
      *.iso) python3 -I "$here/extract_iso.py" "$out" "$dest/$dir/extracted" ;;
      *.zip) unzip -q "$out" -d "$dest/$dir/extracted" ;;
    esac
  fi
done
echo "done: $dest"
