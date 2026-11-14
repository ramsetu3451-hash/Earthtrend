"""Independent snapshot vector summary oracle, no Go implementation imported."""
import json,math,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
report=[]
for id,uname,vname in [('wind','wind_u','wind_v'),('currents','u','v')]:
 raw=json.loads((ROOT/f'data/systems/{id}_snapshot.json').read_text())['table'];names=raw['columnNames'];rows=[dict(zip(names,r)) for r in raw['rows']];valid=[r for r in rows if r[uname] is not None and r[vname] is not None]
 assert len(valid)>1000
 assert sum(math.hypot(r[uname],r[vname])>0 for r in valid)>1000
 for box in [(-70,0,10,60),(45,100,-30,25),(-160,-80,-30,40)]:
  west,east,south,north=box
  pts=[r for r in valid if west<=((r['longitude']+180)%360-180)<=east and south<=r['latitude']<=north]
  weights=[math.cos(r['latitude']*math.pi/180) for r in pts];total=sum(weights)
  u=sum(w*r[uname] for w,r in zip(weights,pts))/total;v=sum(w*r[vname] for w,r in zip(weights,pts))/total;speed=sum(w*math.hypot(r[uname],r[vname]) for w,r in zip(weights,pts))/total
  q=f'id={id}&west={west}&east={east}&south={south}&north={north}'
  got=json.load(urllib.request.urlopen('http://127.0.0.1:8080/api/flow/analyze?'+q))
  error=max(abs(got['meanU']-u),abs(got['meanV']-v),abs(got['meanSampleSpeed']-speed),abs(got['meanVectorSpeed']-math.hypot(u,v)))
  assert error<1e-10 and got['sampleCount']==len(pts)
  bearing=(math.degrees(math.atan2(u,v))+360)%360
  assert abs(got['bearingTo']-bearing)<1e-9
  assert got['date']==rows[0]['time']
  report.append({'id':id,'bounds':box,'n':len(pts),'speed':speed,'maximumAbsoluteDifference':error,'date':got['date']})
(ROOT/'qa-v02/flow-validation.json').write_text(json.dumps({'status':'pass','checks':report},indent=2));print('PASS: independent summaries, directions, units and dates for six real regions')
