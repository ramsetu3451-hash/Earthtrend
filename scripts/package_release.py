"""Package runnable source, Windows/Linux executables, pinned data and validation evidence."""
from pathlib import Path
import hashlib,json,zipfile
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT.parent/'merobiman-detective.zip'
files=[ROOT/n for n in ['README.md','Makefile','run.sh','start-windows.bat','.gitignore']]
for directory in ['backend','frontend/src','frontend/public','data/systems']:
 for p in (ROOT/directory).rglob('*'):
  if p.is_file() and not p.name.endswith('.log'):files.append(p)
for name in ['package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html']:files.append(ROOT/'frontend'/name)
for name in ['validate_science.py','validate_flows.py','systems_qa.cjs','ui_smoke.cjs','modal_check.cjs','package_release.py','fetch_ascat.py','final_smoke.cjs']:
 p=ROOT/'scripts'/name
 if p.exists():files.append(p)
files += [ROOT/'data/gistemp.nc.gz',ROOT/'bin/merobiman-linux-amd64',ROOT/'bin/merobiman-windows-amd64.exe']
for directory in ['qa','qa-v02']:
 for p in (ROOT/directory).glob('*'):
  if p.suffix in ['.json','.png','.txt'] and p.name not in ['format.txt','export.json']:files.append(p)
files=sorted(set(files))
manifest={'release':'0.2.0-detective-workflow','scope':'Temperature trend science + real wind/current snapshot analysis + NASA satellite indicator imagery. Not full numerical pollution/habitat trend analysis.','files':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
(ROOT/'MANIFEST.json').write_text(json.dumps(manifest,indent=2));files.append(ROOT/'MANIFEST.json')
with zipfile.ZipFile(OUT,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for p in files:z.write(p,'merobiman/'+str(p.relative_to(ROOT)))
with zipfile.ZipFile(OUT) as z:
 assert z.testzip() is None
 assert not any('node_modules' in n or n.endswith('/gistemp.nc') for n in z.namelist())
 print(json.dumps({'archive':str(OUT),'files':len(z.namelist()),'sizeMB':round(OUT.stat().st_size/1024**2,2),'sha256':hashlib.sha256(OUT.read_bytes()).hexdigest()}))
