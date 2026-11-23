"""Extract an ISO 9660 image (Joliet/Rock Ridge names preferred) into a directory."""
import os
import sys

import pycdlib


def main(iso_path: str, out_dir: str) -> None:
    iso = pycdlib.PyCdlib()
    iso.open(iso_path)
    if iso.has_joliet():
        facade, path_kw = iso.get_joliet_facade(), "joliet_path"
    elif iso.has_rock_ridge():
        facade, path_kw = iso.get_rock_ridge_facade(), "rr_path"
    else:
        facade, path_kw = iso.get_iso9660_facade(), "iso_path"

    count = 0
    for root, _dirs, files in facade.walk("/"):
        for name in files:
            src = f"{root.rstrip('/')}/{name}"
            clean = name.split(";")[0]
            dst = os.path.join(out_dir, root.lstrip("/"), clean)
            # Refuse anything that would escape out_dir.
            if not os.path.realpath(dst).startswith(os.path.realpath(out_dir) + os.sep):
                print(f"skip suspicious path: {src}", file=sys.stderr)
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            facade.get_file_from_iso(dst, **{path_kw: src})
            count += 1
    iso.close()
    print(f"{iso_path}: {count} files -> {out_dir}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
