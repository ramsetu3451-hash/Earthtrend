import urllib.request,json,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[1]
u='https://coastwatch.pfeg.noaa.gov/erddap/griddap/erdQCwindproductsMonthly.json?wind_u[(2026-09-16T00:00:01Z)][0][0:9:539][0:9:1079],wind_v[(2026-09-16T00:00:01Z)][0][0:9:539][0:9:1079]'
try:
 raw=urllib.request.urlopen(u,timeout=90).read();d=json.loads(raw)['table'];cols=d['columnNames'];ui=cols.index('wind_u');vi=cols.index('wind_v');pts=[(r[ui],r[vi]) for r in d['rows'] if r[ui] is not None and r[vi] is not None];print(cols,len(pts),'nonzero',sum(a!=0 or b!=0 for a,b in pts),'range',min(a for a,b in pts),max(a for a,b in pts))
 if sum(a!=0 or b!=0 for a,b in pts)>100:
  (root/'data/systems/wind_snapshot.json').write_bytes(raw)
  (root/'data/systems/wind-source.json').write_text(json.dumps({'url':u,'metadata':'https://coastwatch.pfeg.noaa.gov/erddap/info/erdQCwindproductsMonthly/index.html','sha256':hashlib.sha256(raw).hexdigest()},indent=2))
except Exception as e:print(e)
