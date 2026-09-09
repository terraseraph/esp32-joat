# Copy the authored UI into the embed path. CMake embeds web/dist/index.html.
# Usage: python tools/sync_web.py
import pathlib
import shutil

root = pathlib.Path(__file__).resolve().parents[1]
src = root / "web" / "source" / "index.html"
dst = root / "web" / "dist" / "index.html"
if not src.exists():
    raise SystemExit(f"missing {src}")
dst.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(src, dst)
print(f"copied {src} -> {dst} ({dst.stat().st_size} bytes)")
