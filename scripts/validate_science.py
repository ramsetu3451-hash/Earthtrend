"""Independent, development-only oracle. NOT a Python runtime backend.
Reads raw NASA NetCDF using SciPy; validates the Go API against Statsmodels.
"""
from pathlib import Path
import json, math, hashlib, urllib.request, urllib.error, os
import numpy as np
from scipy.io import netcdf_file
from scipy.special import erfc
import statsmodels.api as sm
from statsmodels.stats.multitest import multipletests
ROOT=Path(__file__).resolve().parents[1]
BASE=os.environ.get('API_BASE','http://127.0.0.1:8080')
def get(path):
 with urllib.request.urlopen(BASE+path,timeout=120) as r:return json.load(r)
with netcdf_file(str(ROOT/'data/gistemp.nc'),'r',mmap=False) as nc:
 lat=nc.variables['lat'].data.copy().astype(float);lon=nc.variables['lon'].data.copy().astype(float)
 v=nc.variables['tempanomaly'];raw=v.data.copy();fill=int(v._FillValue);scale=float(v.scale_factor)
 first=1880;last=2025
 annual=[]
 for year in range(first,last+1):
  a=raw[(year-first)*12:(year-first+1)*12]
  valid=(a!=fill).all(axis=0)
  annual.append(np.where(valid,a.astype(float).mean(axis=0)*scale,np.nan))
 annual=np.array(annual)
years=np.arange(1981,2026);Y=annual[1981-first:2026-first].reshape(len(years),-1)
checks=[]
regions=[('Arctic',-180,66,180,90),('South Asia',65,5,95,35),('North Atlantic',-60,20,-10,60),('Partial cell',72.3,18.3,74.7,20.7)]
for name,w,s,e,n in regions:
 overlap_lat=np.maximum(0,np.sin(np.radians(np.minimum(lat+1,n)))-np.sin(np.radians(np.maximum(lat-1,s))))
 overlap_lat[(lat+1<=s)|(lat-1>=n)]=0
 overlap_lon=np.maximum(0,np.minimum(lon+1,e)-np.maximum(lon-1,w))*math.pi/180
 weights=(overlap_lat[:,None]*overlap_lon[None,:]).reshape(-1)
 weights=np.where(np.isfinite(Y).all(axis=0),weights,0)
 values=np.nansum(Y*weights,axis=1)/weights.sum()
 lag=int(np.floor(4*(len(years)/100)**(2/9)))
 model=sm.OLS(values,sm.add_constant(years)).fit(cov_type='HAC',cov_kwds={'maxlags':lag,'use_correction':True},use_t=False)
 response=get(f'/api/analyze?start=1981&end=2025&west={w}&south={s}&east={e}&north={n}')
 actual=response['trend'];expected={'slopePerDecade':float(model.params[1]*10),'ciLow':float(model.conf_int()[1,0]*10),'ciHigh':float(model.conf_int()[1,1]*10),'pValue':float(model.pvalues[1])}
 for key,val in expected.items():assert math.isclose(actual[key],val,rel_tol=1e-7,abs_tol=1e-9),(name,key,actual[key],val)
 assert np.max(np.abs(np.array([p['value'] for p in response['series']])-values))<1e-10
 expected_area=100*weights.sum()/((np.sin(np.radians(n))-np.sin(np.radians(s)))*(e-w)*math.pi/180)
 assert abs(response['footprintPercent']-expected_area)<1e-8
 checks.append({'region':name,'bounds':[w,s,e,n],'reference':expected,'status':'pass'})
# Separate vectorized field implementation, including missing years and calendar lags.
valid=np.isfinite(Y);N=valid.sum(axis=0);eligible=(N>=30)&(N/len(years)>=.9)
A=Y[:,eligible];valid=np.isfinite(A);N=valid.sum(axis=0);X=np.broadcast_to(years[:,None],A.shape)
mx=np.sum(np.where(valid,X,0),axis=0)/N;my=np.nansum(A,axis=0)/N
x=X-mx;xx=np.sum(np.where(valid,x*x,0),axis=0);b=np.nansum(x*(A-my),axis=0)/xx
res=A-my-b*x;u=np.where(valid,x*res,0);meat=np.sum(u*u,axis=0);lags=np.floor(4*(N/100)**(2/9)).astype(int)
for lag in range(1,int(lags.max())+1):
 meat+=2*np.where(lags>=lag,1-lag/(lags+1),0)*np.sum(u[lag:]*u[:-lag],axis=0)
se=np.sqrt(np.maximum(meat,0)/(xx*xx)*N/(N-2));p=erfc(np.abs(b/se)/np.sqrt(2));q=multipletests(p,method='fdr_bh')[1]
field=get('/api/map?start=1981&end=2025&layer=trend')
ids=np.flatnonzero(eligible)
assert len(field['features'])==90*180
slope_error=max(abs(field['features'][int(c)]['properties']['v']-float(b[i]*10)) for i,c in enumerate(ids))
q_error=max(abs(field['features'][int(c)]['properties']['q']-float(q[i])) for i,c in enumerate(ids))
assert slope_error<1e-9,slope_error
assert q_error<1e-9,q_error
assert field['meta']['eligibleCells']==int(eligible.sum())
assert field['meta']['significantCells']==int((q<=.05).sum())
# Invalid requests must fail explicitly, not silently change the requested window.
for path in ['/api/map?start=2020&end=2025','/api/analyze?west=NaN','/api/analyze?west=100&east=-100','/api/map?layer=unknown']:
 try:get(path);raise AssertionError('invalid request accepted '+path)
 except urllib.error.HTTPError as err:assert err.code==400
report={'status':'pass','input':{'source':'https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz','sha256':hashlib.sha256((ROOT/'data/gistemp.nc.gz').read_bytes()).hexdigest(),'monthly_records':raw.shape[0],'complete_years':[first,last],'grid':[90,180],'fill_value':fill,'scale_factor':scale},'window':[1981,2025],'regional_checks':checks,'global_field':{'eligible_cells':int(eligible.sum()),'bh_q_le_005_cells':int((q<=.05).sum()),'max_slope_error':slope_error,'max_q_error':q_error},'invalid_request_checks':4,'reference':'SciPy NetCDF + Statsmodels OLS/HAC (normal approximation) and fdr_bh','limitations':['Statistical validation is not external scientific peer review.','Does not propagate the complete GISTEMP observational uncertainty ensemble.','BH spatial-dependence assumptions remain a limitation.']}
(ROOT/'qa/science-validation.json').write_text(json.dumps(report,indent=2))
if os.environ.get('EVIDENCE_DIR'):
 evidence_dir=Path(os.environ['EVIDENCE_DIR']); evidence_dir.mkdir(parents=True,exist_ok=True)
 (evidence_dir/'merobiman-validation.json').write_text(json.dumps(report,indent=2))
print(json.dumps({'status':'pass','regions':len(checks),'global_cells_checked':int(eligible.sum()),'max_slope_error':slope_error,'max_q_error':q_error,'invalid_requests':4}))
