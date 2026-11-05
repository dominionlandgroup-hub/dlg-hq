window.RC=(function(){
const esc=s=>String(s).replace(/'/g,"''");
const P=async(u,p,ms=40000)=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(u,{method:'POST',body:new URLSearchParams(p),signal:c.signal});if(!r.ok)throw new Error('http '+r.status);const j=await r.json();if(j.error)throw new Error(j.error.message||'err');return j}finally{clearTimeout(t)}};
const SRV={Gaston:['https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Parcels/MapServer/11/query',a=>`PID='${esc(a)}'`],
 // Cabarrus: exact match on the full 14-digit PIN (a 10-digit PIN is padded with zeros); fewer than 10 digits = skip (no prefix guessing)
 Cabarrus:['https://location.cabarruscounty.us/arcgisservices/rest/services/opendata/MapServer/46/query',a=>{const d=a.replace(/\D/g,'');return d.length<10?null:`PIN14='${d.slice(0,14).padEnd(14,'0')}'`}],
 Iredell:['https://maps.iredellcountync.gov/server/rest/services/Data/TaxSQL_Parcels/FeatureServer/0/query',a=>`PIN='${esc(a.replace(/-/g,''))}'`],
 Mecklenburg:['https://meckgis.mecklenburgcountync.gov/server/rest/services/TaxParcelBoundaries/FeatureServer/0/query',a=>`pid='${a.replace(/\D/g,'').padStart(8,'0')}'`],
 Union:['https://atlas.unioncountync.gov/server/rest/services/OperationalLayers/MapServer/215/query',a=>`PID='${a.replace(/\D/g,'')}'`],
 York:['https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer/0/query',a=>`TAXMAPID='${a.replace(/\D/g,'')}'`],
 Chester:['https://services8.arcgis.com/h9JHFVWvWofKfQhH/arcgis/rest/services/Scenario_Basemap_Parcels/FeatureServer/0/query',a=>`TAXMAP_NO='${esc(a)}'`],
 Lancaster:['https://services3.arcgis.com/rJcpRneDUBgTeCT3/arcgis/rest/services/LC_Parcels/FeatureServer/0/query',a=>`PIN='${esc(a)}'`],
 // Duplin: PropStream's APN ('12- 752-  -  -') is the county's current ParcelNumber plus one trailing '  -' ('12- 752-  -').
 // Not CYPAR: that's the old numbering, and an old CYPAR often equals a DIFFERENT parcel's APN (owner matched 97 of 100 on ParcelNumber, 0 on CYPAR)
 Duplin:['https://gis.duplinnc.gov/server/rest/services/TaxMapping/Parcels/FeatureServer/0/query',a=>`ParcelNumber='${esc(String(a).replace(/  -$/,''))}'`],
 // Guilford: PropStream's APN is the county REID with leading zeros ('0095315' = reid '95315'); the state map has no REID
 // Lee County FL: PropStream APN '36-44-26-L2-11107.0010' = STRAP '364426L2111070010' (dashes and dot removed)
 'Lee FL':['https://services2.arcgis.com/LvWGAAhHwbCJ2GMP/ArcGIS/rest/services/Lee_County_Parcels/FeatureServer/0/query',a=>`STRAP='${String(a).replace(/[^0-9A-Za-z]/g,'').toUpperCase()}'`],
 Guilford:['https://gcgis.guilfordcountync.gov/arcgis/rest/services/Hosted/Parcel_Boundaries/FeatureServer/0/query',a=>/^\d{1,8}$/.test(String(a).trim())?`reid='${String(a).trim().replace(/^0+/,'')}'`:''],
 // Greenville: keep the letter prefix (B004.05-01-115.00 = PIN 'B004050111500'); stripping it lost every B/P/M parcel
 Greenville:['https://services.arcgis.com/zTM0LZtJeE1HzO09/arcgis/rest/services/kx_greenville_county_sc_tax_parcel_SHP/FeatureServer/0/query',a=>`PIN='${a.replace(/[^0-9A-Za-z]/g,'').toUpperCase()}'`]};
// counties only in SC (Cherokee and Union are also NC counties, so those need State = SC): never looked up on the NC statewide map
const SC_ONLY=/^(York|Chester|Lancaster|Greenville|Spartanburg|Anderson|Pickens|Oconee|Horry)$/i;
// Brunswick NC private-road communities: lots here pass even without public road frontage (Brunswick GIS LegalDescription)
const BRUNS='https://bcgis.brunswickcountync.gov/arcgis/rest/services/Layers/TaxParcels/MapServer/0/query';
const BRUNS_OK=/RIVERS?'?\s*EDGE|OCEAN\s*RIDGE|SEA\s*SCAPE|SEA\s*WATCH/i;
const brunsPrivate=async a=>{const vs=[...new Set([a.trim().toUpperCase(),a.replace(/[^0-9A-Za-z]/g,'').toUpperCase()])].filter(Boolean).map(v=>`'${esc(v)}'`).join(',');
 const j=await P(BRUNS,{where:`ParcelNumber IN (${vs})`,outFields:'ParcelNumber,LegalDescription',returnGeometry:false,f:'json',resultRecordCount:5});
 const d=(j.features||[]).map(f=>String(f.attributes.LegalDescription||'')).find(x=>BRUNS_OK.test(x));return d?d.match(BRUNS_OK)[0].toUpperCase():null};
const ST='https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1/query';
// APN spellings to try on NC OneMap; also the first 10 digits (Forsyth 6882-46-0712.000 is altparno 6882460712 there)
const vars=a=>{a=a.trim();const s=a.replace(/[^0-9A-Za-z.]/g,''),s2=a.replace(/[^0-9A-Za-z]/g,''),d=a.replace(/\D/g,'');// old LandPortal data: Wake = 'PIN REID' (REID is the state map's altparno); Pasquotank parno has two spaces ('7996  711915')
 const reid=(/\s(\d{6,8})$/.exec(a)||[])[1]||'',dbl=/^\d{4} \d{6}$/.test(a)?a.replace(' ','  '):'';
 return [...new Set([a,s,s2,d.length>10?d.slice(0,10):'',reid,dbl])].filter(Boolean)};
const SC_CO=/^(york|chester|lancaster|spartanburg|greenville|anderson|pickens|oconee|union|laurens|newberry|fairfield|kershaw|richland|lexington|charleston|berkeley|dorchester|horry|aiken|sumter|florence)$/i;
const getGeom=async(c,a,sc)=>{let g=null;if(SRV[c]){try{const [u,w]=SRV[c];const wh=w(a);if(!wh)throw 0;const j=await P(u,{where:wh,outFields:'*',returnGeometry:true,outSR:4326,f:'json',resultRecordCount:1});g=j.features?.[0]?.geometry||null}catch(e){}}
 if(!g&&!SC_ONLY.test(c||'')&&!sc){const vs=vars(a).map(v=>`'${esc(v)}'`).join(',');const j=await P(ST,{where:`cntyname='${c}' AND (parno IN (${vs}) OR altparno IN (${vs}))`,outFields:'objectid',returnGeometry:true,outSR:4326,f:'json',resultRecordCount:1});g=j.features?.[0]?.geometry||null}
 return g};
const inPoly=(pt,rs)=>{let c=false;for(const r of rs)for(let i=0,j=r.length-1;i<r.length;j=i++){const [xi,yi]=r[i],[xj,yj]=r[j];if(((yi>pt[1])!=(yj>pt[1]))&&(pt[0]<(xj-xi)*(pt[1]-yi)/(yj-yi)+xi))c=!c}return c};
// local metres projection
const proj=(rings)=>{const p=rings.flat();const lat0=p.reduce((t,q)=>t+q[1],0)/p.length,lon0=p.reduce((t,q)=>t+q[0],0)/p.length;const kx=111320*Math.cos(lat0*Math.PI/180),ky=110540;return {f:q=>[(q[0]-lon0)*kx,(q[1]-lat0)*ky],lat0,lon0,kx,ky}};
const ringArea=r=>{let a=0;for(let i=0,j=r.length-1;i<r.length;j=i++)a+=(r[j][0]+r[i][0])*(r[j][1]-r[i][1]);return a/2};
const polyArea=rs=>Math.abs(rs.reduce((t,r)=>t+ringArea(r),0));
const minRect=pts=>{let best=null;for(let d=0;d<90;d+=2){const t=d*Math.PI/180,c=Math.cos(t),s=Math.sin(t);let x0=1e18,x1=-1e18,y0=1e18,y1=-1e18;for(const [x,y] of pts){const u=x*c+y*s,v=-x*s+y*c;if(u<x0)x0=u;if(u>x1)x1=u;if(v<y0)y0=v;if(v>y1)y1=v}const a=(x1-x0)*(y1-y0);if(!best||a<best.a)best={a,L:Math.max(x1-x0,y1-y0),W:Math.min(x1-x0,y1-y0)}}return best};
const segDist=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1];const l=dx*dx+dy*dy;let t=l?((p[0]-a[0])*dx+(p[1]-a[1])*dy)/l:0;t=Math.max(0,Math.min(1,t));const x=a[0]+t*dx-p[0],y=a[1]+t*dy-p[1];return Math.hypot(x,y)};
const frontage=(ringsM,lines)=>{if(!lines.length)return 0;let len=0;for(const r of ringsM)for(let i=1;i<r.length;i++){const a=r[i-1],b=r[i];const L=Math.hypot(b[0]-a[0],b[1]-a[1]);const n=Math.max(1,Math.ceil(L/2));for(let k=0;k<n;k++){const p=[a[0]+(b[0]-a[0])*(k+.5)/n,a[1]+(b[1]-a[1])*(k+.5)/n];let near=false;for(const ln of lines){for(let m=1;m<ln.length&&!near;m++)if(segDist(p,ln[m-1],ln[m])<15)near=true;if(near)break}if(near)len+=L/n}}return len};
const env=(rings,padDeg=0)=>{const p=rings.flat(),xs=p.map(q=>q[0]),ys=p.map(q=>q[1]);return {xmin:Math.min(...xs)-padDeg,ymin:Math.min(...ys)-padDeg,xmax:Math.max(...xs)+padDeg,ymax:Math.max(...ys)+padDeg,spatialReference:{wkid:4326}}};
const grid=(rings,n)=>{const e=env(rings);const out=[];for(let i=0;i<n;i++)for(let j=0;j<n;j++){const x=e.xmin+(e.xmax-e.xmin)*(i+.5)/n,y=e.ymin+(e.ymax-e.ymin)*(j+.5)/n;if(inPoly([x,y],rings))out.push([x,y])}if(!out.length)out.push([(e.xmin+e.xmax)/2,(e.ymin+e.ymax)/2]);return out};
const gq=(rings)=>({geometry:JSON.stringify({rings,spatialReference:{wkid:4326}}),geometryType:'esriGeometryPolygon',inSR:4326,spatialRel:'esriSpatialRelIntersects',outSR:4326,f:'json'});
// Florida (Nov 2026): only Lee County so far. Its SRV key is 'Lee FL' so Lee County NC never uses it; roads follow the SC rule (any public road in TIGER)
const check=async(r)=>{const FL=String(r.properties.state||'').toUpperCase()==='FL';const c=FL?String(r.properties.county||'').trim()+' FL':r.properties.county,a=r.properties.apn;if(FL&&!SRV[c])return {fail:'hold: no parcel map for this county'};if(!a)return {fail:'hold: parcel not found on county map'};
 // South Carolina has no statewide parcel map: a county without its own source can't be checked
 const sc=FL||String(r.properties.state||'').toUpperCase()==='SC'||(!r.properties.state&&SC_CO.test(c||'')&&!/^union$/i.test(c||''));if(sc&&(!SRV[c]||/^union$/i.test(c)))return {fail:'hold: no parcel map for this county'};
 // Onslow (old LandPortal data): APN is the account number without its leading zeros ('65289' = altparno '065289')
 const g=await getGeom(c,/^onslow$/i.test(c||'')&&/^\d{1,5}$/.test(String(a).trim())?String(a).trim().padStart(6,'0'):a,sc);if(!g||!g.rings)return {fail:'hold: parcel not found on county map'};
 // CURRENT OWNER + BUILDING VALUE (Nov 2026): NC lots are looked up on the state parcel map. A building worth $20K+ means a house or
 // big structure the aerial missed (Catawba's map has no building values, so it is skipped there); an owner on the map that doesn't
 // match the owner on the list means the lot sold. Old LandPortal/Pebble data had both problems.
 if(!sc){try{const vs=vars(/^onslow$/i.test(c||'')&&/^\d{1,5}$/.test(String(a).trim())?String(a).trim().padStart(6,'0'):a).map(v=>`'${esc(v)}'`).join(',');const j=await P(ST,{where:`cntyname='${c}' AND (parno IN (${vs}) OR altparno IN (${vs}))`,outFields:'ownname,improvval',returnGeometry:false,f:'json',resultRecordCount:1});const at=j.features?.[0]?.attributes;
  if(at){if((at.improvval||0)>=20000&&!/^catawba$/i.test(c||''))return {fail:'aerial: county shows a building worth $'+Math.round(at.improvval).toLocaleString()+' (house or structure)'};
   const w=String(r.owner||'').toUpperCase().replace(/[^A-Z ]/g,' ').split(/\s+/).filter(x=>x.length>2&&!/^(LLC|INC|THE|AND|CORP|TRUST|ESTATE|HEIRS|ETAL|ETUX)$/.test(x));const own=String(at.ownname||'').toUpperCase();
   if(w.length&&own&&!w.some(x=>own.includes(x)))return {fail:'hold: owner changed (county now shows '+String(at.ownname).slice(0,40)+')'}}}catch(e){}}const rings=g.rings;const pj=proj(rings);const rm=rings.map(x=>x.map(pj.f));
 const areaM=polyArea(rm),acres=areaM/4046.86;const mr=minRect(rm.flat());const avgW=areaM/mr.L,fill=areaM/mr.a;
 const out={acres:+acres.toFixed(3),avgWft:Math.round(avgW*3.28),Lft:Math.round(mr.L*3.28)};
 if(acres<0.1)return {...out,fail:'aerial: too small'};
 if(avgW*3.28<40)return {...out,fail:'aerial: too skinny'};
 if(fill<0.55)return {...out,fail:'aerial: odd shape / triangle'};
 if(avgW*3.28<55&&mr.L/avgW>5)return {...out,fail:'hold: long narrow strip'};
 // structures
 const sj=await P('https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0/query',{...gq(rings),outFields:'SQMETERS',returnGeometry:true});
 for(const f of sj.features||[]){if((f.attributes.SQMETERS||0)<20)continue;const pts=f.geometry.rings.flat();const cx=pts.reduce((t,q)=>t+q[0],0)/pts.length,cy=pts.reduce((t,q)=>t+q[1],0)/pts.length;if(inPoly([cx,cy],rings))return {...out,fail:'aerial: structure on lot - possible encroachment'}}
 // water within 15 m
 const wj=await P('https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Detailed_Water_Bodies/FeatureServer/0/query',{...gq(rings),distance:15,units:'esriSRUnit_Meter',outFields:'NAME,SQKM',returnGeometry:false});
 if((wj.features||[]).some(f=>(f.attributes.NAME&&String(f.attributes.NAME).trim())||(f.attributes.SQKM||0)>=0.05))return {...out,fail:'aerial: waterfront'};
 // roads: state maintained + local inside town limits
 const pad=0.0004;const e=env(rings,pad);const eg={geometry:JSON.stringify(e),geometryType:'esriGeometryEnvelope',inSR:4326,spatialRel:'esriSpatialRelIntersects',outSR:4326,f:'json',returnGeometry:true};
 let lines,fr;
 if(sc){// SC: every public road in the Census TIGER file counts (primary, secondary, local, ramps); private drives and trails don't
  const T='https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/';const js=await Promise.all([2,6,8].map(l=>P(T+l+'/query',{...eg,where:"MTFCC IN ('S1100','S1200','S1400','S1640')",outFields:'MTFCC'})));
  lines=js.flatMap(j=>(j.features||[]).flatMap(f=>(f.geometry.paths||[]).map(p=>p.map(pj.f))));fr=frontage(rm,lines)}
 else{const s1=await P('https://services.arcgis.com/NuWFvHYDMVmmxMeM/ArcGIS/rest/services/NCDOT_StateMaintainedRoadsER/FeatureServer/0/query',{...eg,outFields:'RouteClass'});
  lines=(s1.features||[]).flatMap(f=>(f.geometry.paths||[]).map(p=>p.map(pj.f)));fr=frontage(rm,lines)}
 if(fr<15&&!sc){const ctr=grid(rings,1)[0];const tj=await P('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query',{geometry:JSON.stringify({x:ctr[0],y:ctr[1],spatialReference:{wkid:4326}}),geometryType:'esriGeometryPoint',inSR:4326,spatialRel:'esriSpatialRelIntersects',outFields:'NAME',returnGeometry:false,f:'json'});
  if((tj.features||[]).length){const s2=await P('https://gis11.services.ncdot.gov/arcgis/rest/services/NCDOT_RoadNC/RoadNC_CenterlinesGray/MapServer/4/query',{...eg,where:"RouteClass='5'",outFields:'RouteClass'});lines=lines.concat((s2.features||[]).flatMap(f=>(f.geometry.paths||[]).map(p=>p.map(pj.f))));fr=frontage(rm,lines);out.town=tj.features[0].attributes.NAME}}
 out.frontFt=Math.round(fr*3.28);
 if(fr<15&&/^brunswick$/i.test(c||'')&&!sc){out.privateRoad=await brunsPrivate(a)} // Rivers Edge, Ocean Ridge Plantation, SeaScape, SeaWatch: private roads OK
 if(!out.privateRoad){if(fr<=0.5)return {...out,fail:'hold: no public road frontage'};
  if(fr<15)return {...out,fail:'hold: under 50 ft on a public road'}}
 // flood + slope
 const G=grid(rings,8);const fz=await P('https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query',{geometry:JSON.stringify(env(rings)),geometryType:'esriGeometryEnvelope',inSR:4326,spatialRel:'esriSpatialRelIntersects',where:"SFHA_TF='T'",outFields:'FLD_ZONE',returnGeometry:true,outSR:4326,f:'json'});
 const fl=(fz.features||[]).filter(f=>f.geometry).map(f=>f.geometry.rings);const inF=G.filter(p=>fl.some(r=>inPoly(p,r))).length;out.floodPct=Math.round(100*inF/G.length);
 if(out.floodPct>0)return {...out,fail:'in flood zone'}; // any flood zone fails
 const E=grid(rings,5);const es=await P('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples',{geometry:JSON.stringify({points:E,spatialReference:{wkid:4326}}),geometryType:'esriGeometryMultipoint',returnFirstValueOnly:'true',f:'json'});
 const S=(es.samples||[]).map(s=>[...pj.f([s.location.x,s.location.y]),parseFloat(s.value)]).filter(s=>isFinite(s[2]));
 if(S.length>=3){const n=S.length,mx=S.reduce((t,s)=>t+s[0],0)/n,my=S.reduce((t,s)=>t+s[1],0)/n,mz=S.reduce((t,s)=>t+s[2],0)/n;let sxx=0,syy=0,sxy=0,sxz=0,syz=0;for(const [x,y,z] of S){const dx=x-mx,dy=y-my,dz=z-mz;sxx+=dx*dx;syy+=dy*dy;sxy+=dx*dy;sxz+=dx*dz;syz+=dy*dz}const D=sxx*syy-sxy*sxy;if(D>1e-6){const A=(sxz*syy-syz*sxy)/D,B=(syz*sxx-sxz*sxy)/D;out.slope=Math.round(100*Math.hypot(A,B))}}
 if(out.slope>=15)return {...out,fail:'steep slope 15%+'};
 return {...out,pass:true}};
let pg={done:0,err:0,total:0};
const save=()=>{try{localStorage.setItem('rc_res',JSON.stringify(window._RC.res))}catch(e){}};
// rows already checked (pass or fail) are skipped; rows that ended in {error} are tried again
const run=async(rows,conc=6)=>{const todo=rows.filter(r=>{const x=window._RC.res[r.id];return !x||!(x.pass||x.fail)});pg={done:0,err:0,total:todo.length,start:Date.now()};let i=0;
 const w=async()=>{while(i<todo.length){const r=todo[i++];let o;for(let t=0;t<3;t++){try{o=await check(r);break}catch(e){o={error:String(e.message||e).slice(0,80)};await new Promise(z=>setTimeout(z,1500*(t+1)))}}if(o.error)pg.err++;window._RC.res[r.id]=o;pg.done++;if(pg.done%100===0)save()}};
 await Promise.all(Array.from({length:conc},w));save();pg.finished=true};
return {run,check,get pg(){return pg}}})();'ok'
