// Run in Chrome on a tab at https://mecknc.widen.net/s/vb8vhrwvtm/ind_taxbills_advertisement
// (Mecklenburg "Delinquent Individual Taxpayers"; the business list is https://mecknc.widen.net/s/slsnqr9prl/busoth_taxbills_advertisement).
// Set window.TAXURLS to the two "Download" link hrefs on those pages (they look like /content/<id>/original/IND_Taxbills_Advertisement.xlsx?download=true)
// if the ones below stop working. Matches each delinquent property address to a parcel on NC OneMap and downloads dlg_meck_tax.json.
// Poll window.TXst until TXst.done (~20-30 min; the state parcel server is slow on address lookups).
window.TXst={stage:'xlsx',chunks:0,of:0,done:false,err:null};
(async()=>{try{
await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';s.onload=res;s.onerror=()=>rej(new Error('could not load xlsx reader'));document.head.appendChild(s)});
const urls=window.TAXURLS||['/content/kt1lahiyth/original/IND_Taxbills_Advertisement.xlsx?download=true','/content/xjmul0wxtk/original/BUSOTH_Taxbills_Advertisement.xlsx?download=true'];
let R=[];for(const u of urls){const wb=XLSX.read(await (await fetch(u)).arrayBuffer());R=R.concat(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1}))}
const cand=a=>{a=String(a||'').toUpperCase().replace(/\s+/g,' ').trim().replace(/ \d{5}(-\d{4})?$/,'');if(!/^\d+ /.test(a))return null;if(!/ NC$/.test(a))a+=' NC';return a};
const M={AVENUE:'AV',AVE:'AV',LANE:'LN',DRIVE:'DR',STREET:'ST',ROAD:'RD',COURT:'CT',PLACE:'PL',CIRCLE:'CIR',BOULEVARD:'BV',BLVD:'BV',TERRACE:'TR',TER:'TR',PARKWAY:'PY',PKWY:'PY',HIGHWAY:'HY',HWY:'HY',TRAIL:'TR',TRL:'TR',WAY:'WY',NORTH:'N',SOUTH:'S',EAST:'E',WEST:'W',COVE:'CV',LOOP:'LP',PIKE:'PK',SQUARE:'SQ',CROSSING:'XG',RIDGE:'RG',RUN:'RN',POINT:'PT'};
const TX={};for(const r of R){const c=cand(r[1]);const amt=parseFloat(String(r[3]||'').replace(/,/g,''));if(c&&amt>0)TX[c]=Math.max(TX[c]||0,amt)}
const CAND={};for(const k of Object.keys(TX)){CAND[k]=k;const a=k.split(' ').map((w,i)=>i?(M[w]||w):w).join(' ');if(!(a in CAND))CAND[a]=k}
const all=Object.keys(CAND),ch=[];for(let i=0;i<all.length;i+=120)ch.push(all.slice(i,i+120));TXst.stage='parcels';TXst.of=ch.length;let i=0;const PT={};
const pu='https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1/query';
const one=async c=>{for(let t=0;t<5;t++){const ac=new AbortController(),to=setTimeout(()=>ac.abort(),30000);try{const j=await (await fetch(pu,{method:'POST',signal:ac.signal,body:new URLSearchParams({where:`cntyname='Mecklenburg' AND siteadd IN ('${c.map(s=>s.replace(/'/g,"''")).join("','")}')`,outFields:'saledate,parno,ownname,ownfrst,ownlast,mailadd,munit,mcity,mstate,mzip,siteadd,gisacres,improvval,landval,parusedesc',returnGeometry:false,returnCentroid:true,outSR:4326,f:'json'})})).json();clearTimeout(to);if(j.error)throw 0;
  for(const f of j.features||[]){const a=f.attributes;const key=CAND[a.siteadd];PT[a.parno]=[key?TX[key]:null,a.ownname,a.ownfrst,a.ownlast,[a.mailadd,a.munit].filter(Boolean).join(' '),a.mcity,a.mstate,a.mzip,a.siteadd,a.gisacres,a.improvval,a.landval,a.parusedesc,a.saledate,f.centroid?+f.centroid.y.toFixed(5):null,f.centroid?+f.centroid.x.toFixed(5):null]}return}catch(e){clearTimeout(to);await new Promise(r=>setTimeout(r,2000))}}};
const w=async()=>{while(i<ch.length){await one(ch[i++]);TXst.chunks++}};await Promise.all([w(),w(),w(),w(),w(),w(),w(),w()]);
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({pulled:new Date().toISOString(),tx:TX,pt:PT})],{type:'application/json'}));a.download='dlg_meck_tax.json';document.body.appendChild(a);a.click();a.remove();
TXst.done=true}catch(e){TXst.err=e.message}})();
