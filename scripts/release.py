"""Create and verify this version's Windows, web and corresponding-source archives.

Run the separate desktop packager first. Only this config's new output directory
is refreshed. Historical versioned archives and receipts are never selected.
"""
from pathlib import Path,PurePosixPath
import hashlib,json,re,shutil,zipfile
ROOT=Path(__file__).resolve().parents[1]
SOURCE_CORE=[
"README.md","LICENSE","THIRD_PARTY_NOTICES.md",".gitignore","package.json","package-lock.json","electron-app.json",
"src/manifest.cjs","src/strict-json.cjs","src/cli.cjs","src/app-server.cjs",
"scripts/build.cjs","scripts/browser-test.cjs","scripts/electron-main.cjs","scripts/package-desktop.py","scripts/release.py",
"fixtures/fixture.cjs","fixtures/input.json","fixtures/result.json","tests/manifest.test.cjs","tests/results.tap",
".github/workflows/verify.yml"
]
def checked(rel):
 candidate=ROOT/rel
 if candidate.is_symlink():raise ValueError("Linked public input refused")
 p=candidate.resolve()
 if not p.is_relative_to(ROOT.resolve()) or not p.is_file():raise ValueError("Invalid public input: "+rel)
 return p
def write_zip(target,entries):
 with zipfile.ZipFile(target,"w",zipfile.ZIP_DEFLATED,compresslevel=6,strict_timestamps=False) as z:
  for source,name in entries:z.write(source,name)
def main():
 config=json.loads(checked("electron-app.json").read_text())
 version=config["version"];name=config["executable"];output=config["output_directory"]
 if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+",version) or not re.fullmatch("[A-Za-z0-9_-]+",name) or not re.fullmatch("[A-Za-z0-9_-]+",output):raise ValueError("Invalid version/output")
 desktop=(ROOT/"releases"/output).resolve()
 if not desktop.is_relative_to((ROOT/"releases").resolve()):raise ValueError("Outside release output")
 host=desktop/"resources/app"
 if json.loads((host/"package.json").read_text())["version"]!=version:raise ValueError("Output version differs; old build must not be refreshed")
 docs=["docs/"+rel for rel in config["docs_files"]]
 notes="releases/notes-"+version+".md"
 source=SOURCE_CORE+docs+[notes]
 for rel in docs:
  dest=host/rel
  dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(checked(rel),dest)
 for rel in ["README.md","LICENSE","THIRD_PARTY_NOTICES.md"]:shutil.copyfile(checked(rel),desktop/rel)
 if (host/"main.cjs").read_bytes()!=checked("scripts/electron-main.cjs").read_bytes():raise ValueError("Launcher/source mismatch")
 if not (desktop/"LICENSE.electron").is_file() or not (desktop/"LICENSES.chromium.html").is_file():raise ValueError("Missing runtime notices")
 win=ROOT/"releases"/(name+"-"+version+"-win-x64.zip")
 desktop_files=[]
 for p in sorted(desktop.rglob("*")):
  if p.is_symlink() or not p.resolve().is_relative_to(desktop):raise ValueError("Unsafe desktop input")
  if p.is_file():
   rel=p.relative_to(desktop)
   if "profile" in rel.parts:raise ValueError("Unexpected profile in package")
   desktop_files.append((p,name+"/"+rel.as_posix()))
 write_zip(win,desktop_files)
 src=ROOT/"releases"/("codex-lineage-source-"+version+".zip")
 web=ROOT/"releases"/("codex-lineage-web-"+version+".zip")
 write_zip(src,[(checked(rel),rel) for rel in source])
 write_zip(web,[(checked(rel),rel) for rel in docs+["LICENSE","THIRD_PARTY_NOTICES.md"]])
 markers=[str(ROOT).lower().encode(),str(ROOT).replace("\\","/").lower().encode()]
 if len(ROOT.parts)>2 and ROOT.parts[1].lower()=="users":
  profile=Path(*ROOT.parts[:3]);markers.extend([str(profile).lower().encode(),str(profile).replace("\\","/").lower().encode()])
 markers+= [m.decode().encode("utf-16le") for m in markers]
 pe_count=0;entry_count=0;privacy_hits=[]
 for archive in [win,src,web]:
  with zipfile.ZipFile(archive) as z:
   if z.testzip():raise ValueError("ZIP CRC failure")
   for entry in z.infolist():
    rel=PurePosixPath(entry.filename)
    if rel.is_absolute() or ".." in rel.parts or ":" in entry.filename or ".private." in entry.filename:raise ValueError("Unsafe/private ZIP entry")
    data=z.read(entry);low=data.lower();entry_count+=1
    if any(m in low for m in markers):privacy_hits.append(entry.filename)
    if entry.filename.endswith((".exe",".dll")):pe_count+=1
    if archive==src and data!=checked(entry.filename).read_bytes():raise ValueError("Source byte mismatch")
    if archive==web and data!=checked(entry.filename).read_bytes():raise ValueError("Web byte mismatch")
    if archive==win:
     prefix=name+"/resources/app/docs/"
     if entry.filename.startswith(prefix) and data!=checked("docs/"+entry.filename[len(prefix):]).read_bytes():raise ValueError("Renderer byte mismatch")
 if privacy_hits:raise ValueError("Local workspace marker in archive entries: "+str(privacy_hits))
 assets=[{"path":p.relative_to(ROOT).as_posix(),"bytes":p.stat().st_size,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()} for p in [win,src,web]]
 sums=ROOT/"releases"/("SHA256SUMS-"+version+".txt")
 sums.write_text("".join(a["sha256"]+"  "+Path(a["path"]).name+"\n" for a in assets),encoding="utf-8")
 receipt={"passed":True,"version":version,"zip_crc":True,"source_files_match":True,"desktop_renderer_matches_source":True,"launcher_matches_source":True,"runtime_licenses_retained":True,"privacy_workspace_marker_hits":0,"pe_files_scanned":pe_count,"archive_entries_scanned":entry_count,"assets":assets}
 (ROOT/"releases"/("package-verification-"+version+".json")).write_text(json.dumps(receipt,indent=2)+"\n",encoding="utf-8")
 print(json.dumps(receipt))
if __name__=="__main__":main()
