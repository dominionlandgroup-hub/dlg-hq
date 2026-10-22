// Run in Chrome on a tab at https://gis.charlottenc.gov/arcgis/rest/services/HNS/CodeEnforcementCasesAll/MapServer?f=pjson
// Pulls City of Charlotte code cases (Housing/Nuisance/Zoning since 2023 + all open cases + "vacant" inspector notes),
// looks up owner/mailing data for the serious ones on the NC OneMap parcel service, then downloads dlg_charlotte_code_cases.json.
// Start it, then poll window.CEst until CEst.done (takes ~10-15 min). Year floor moves with the calendar (last ~3 years).
window.CE={}; window.PX={}; window.CEst={stage:'cases',pages:0,parcels:0,done:false,err:null};
(async()=>{try{
const Y=new Date().getFullYear()-3, u='https://gis.charlottenc.gov/arcgis/rest/services/HNS/CodeEnforcementCasesAll/MapServer/0/query';
const tfetch=async(url,body)=>{for(let t=0;t<5;t++){const ac=new AbortController(),to=setTimeout(()=>ac.abort(),30000);try{const j=await (await fetch(url,{method:'POST',body,signal:ac.signal})).json();clearTimeout(to);if(j.error)throw 0;return j}catch(e){clearTimeout(to);await new Promise(r=>setTimeout(r,2000))}}throw new Error('request failed: '+url)};
const count=async w=>(await tfetch(u,new URLSearchParams({where:w,returnCountOnly:true,f:'json'}))).count;
const all=async(where,fields,fn)=>{const n=await count(where);const offs=[];for(let o=0;o<n;o+=2000)offs.push(o);let i=0;
  const w=async()=>{while(i<offs.length){const o=offs[i++];const j=await tfetch(u,new URLSearchParams({where,outFields:fields,returnGeometry:false,orderByFields:'OBJECTID',resultOffset:o,resultRecordCount:2000,f:'json'}));j.features.forEach(f=>fn(f.attributes));CEst.pages++}};
  await Promise.all([w(),w(),w(),w()])};
const g=p=>{p=String(p||'').trim();if(!/^\d{8}$/.test(p))return null;return CE[p]||(CE[p]={h:0,n:0,z:0,o:0,v:0,last:0})};
await all(`CaseType IN ('Housing','Nuisance','Zoning') AND CreatedOnCalendarYear>=${Y}`,'ParcelId,CaseType,CaseStatus,DateCreated',r=>{const x=g(r.ParcelId);if(!x)return;if(r.CaseType==='Housing')x.h++;else if(r.CaseType==='Zoning')x.z++;else x.n++;if(r.CaseStatus==='Open'||r.CaseStatus==='New')x.o=1;if(r.DateCreated>x.last)x.last=r.DateCreated});
await all("CaseStatus IN ('Open','New')",'ParcelId,CaseType,DateCreated',r=>{const x=g(r.ParcelId);if(!x)return;x.o=1;if(r.CaseType==='Housing'&&!x.h)x.h=1;if(r.DateCreated>x.last)x.last=r.DateCreated});
await all(`UPPER(DetailedDescription) LIKE '%VACANT%' AND CreatedOnCalendarYear>=${Y-1}`,'ParcelId,DateCreated',r=>{const x=g(r.ParcelId);if(!x)return;x.v=1;if(r.DateCreated>x.last)x.last=r.DateCreated});
CEst.stage='parcels';
const ids=Object.entries(CE).filter(([k,x])=>x.h>0||x.o||x.v||x.n>=3).map(([k])=>k);const ch=[];for(let i=0;i<ids.length;i+=150)ch.push(ids.slice(i,i+150));let i=0;
const pu='https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1/query';
const w=async()=>{while(i<ch.length){const c=ch[i++];try{const j=await tfetch(pu,new URLSearchParams({where:`cntyname='Mecklenburg' AND parno IN ('${c.join("','")}')`,outFields:'saledate,parno,ownname,ownfrst,ownlast,mailadd,munit,mcity,mstate,mzip,siteadd,scity,szip,gisacres,improvval,struct,landval,parusedesc',returnGeometry:false,returnCentroid:true,outSR:4326,f:'json'}));
  for(const f of j.features||[]){const a=f.attributes;PX[a.parno]=[a.ownname,a.ownfrst,a.ownlast,[a.mailadd,a.munit].filter(Boolean).join(' '),a.mcity,a.mstate,a.mzip,a.siteadd,a.scity,a.szip,a.gisacres,a.improvval,a.landval,a.parusedesc,a.saledate,f.centroid?+f.centroid.y.toFixed(5):null,f.centroid?+f.centroid.x.toFixed(5):null]}}catch(e){}CEst.parcels++}};
await Promise.all([w(),w(),w(),w(),w(),w()]);
const ce={};for(const [k,x] of Object.entries(CE)){const d=new Date(x.last);ce[k]=[x.h,x.n,x.z,x.o,x.v,d.getFullYear()*100+d.getMonth()+1]}
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({pulled:new Date().toISOString(),ce,px:PX})],{type:'application/json'}));a.download='dlg_charlotte_code_cases.json';document.body.appendChild(a);a.click();a.remove();
CEst.done=true}catch(e){CEst.err=e.message}})();
