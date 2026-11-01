# Desktop packaging is intentionally separate from app builds.
# Run python scripts/package-desktop.py after installing pinned Electron locally.
from pathlib import Path
import hashlib,json,zipfile
root=Path(__file__).resolve().parents[1]
archive=root/'releases/TaskLineageWorkbench-0.1.0-win-x64.zip'
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 for rel in json.loads((root/'electron-app.json').read_text())['docs_files']:
  assert z.read('TaskLineageWorkbench/resources/app/docs/'+rel)==(root/'docs'/rel).read_bytes()
 print(json.dumps({'passed':True,'bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))
