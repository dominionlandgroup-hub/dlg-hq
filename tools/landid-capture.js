// Land id picture capture (used by Claude during "Run DD / Comps"; not loaded by DLG HQ).
// Paste into the Land id report tab (id.land/tour/<id>/preview) with javascript_tool, then per tab:
//   1. click the tab (Buildable Areas / Terrain / Floodplain) and wait ~7s (Terrain ~10s)
//   2. get the lot close: "Fit Map bounds" button (works on Buildable Areas) then one "Zoom out";
//      on Terrain and Floodplain, scroll-wheel up over the red lot outline until the lot fills the middle
//      (Fit on Floodplain jumps to the flood features, and a second Zoom out can fly away; check a screenshot)
//   3. const url = await LIDCAP.shot()   -> JPEG data URL: Land id panel in a left column + the full map (nothing covers the lot)
//      mapbox only hands over a frame while it is drawing: if shot()/grab() returns null, start it and
//      scroll the wheel one tick over the lot while it waits (that redraws the map)
//   4. upload: in the DLG HQ tab (use #dashboard; board views sometimes block scripts) create
//      sb.storage.from('deal-files').createSignedUploadUrl('<dealId>/<ts>-<Street> - Land id <Tab> (close-up).jpg'),
//      read each signedUrl on its own (long output gets cut off), PUT the blob to it from this tab
//      (headers content-type image/jpeg, x-upsert false), then insert the deal_files row from the DLG HQ tab.
(function () {
  let want = false, cap = null, q = false;
  const cv = () => document.querySelector('canvas.mapboxgl-canvas');
  // mapbox doesn't keep its frame, so read the canvas right after a frame is drawn
  for (const P of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) for (const fn of ['drawElements', 'drawArrays']) {
    if (P['_o' + fn]) continue; P['_o' + fn] = P[fn];
    P[fn] = function (...a) { const r = P['_o' + fn].apply(this, a); if (want && this.canvas === cv() && !q) { q = true; queueMicrotask(() => { q = false; if (!want) return; want = false; cap = this.canvas.toDataURL('image/jpeg', 0.9); }); } return r; };
  }
  async function grab() { cap = null; want = true; window.dispatchEvent(new Event('resize')); for (let i = 0; i < 40 && !cap; i++) await new Promise(r => setTimeout(r, 100)); return cap; }
  function inline(src) { const c = src.cloneNode(true); const a = [src, ...src.querySelectorAll('*')], b = [c, ...c.querySelectorAll('*')]; a.forEach((e, i) => { const s = getComputedStyle(e); let t = ''; for (const k of s) t += k + ':' + s.getPropertyValue(k) + ';'; b[i].setAttribute('style', t); }); return c; }
  const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('image')); i.src = src; });
  async function shot() {
    const c = cv(), map = await grab(); if (!map) return null;
    const dpr = c.width / c.clientWidth, art = document.querySelector('article'), R = art.getBoundingClientRect();
    const cl = inline(art); cl.style.position = 'static'; cl.style.margin = '0';
    const w = Math.ceil(R.width), h = Math.ceil(R.height);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * dpr}" height="${h * dpr}"><foreignObject width="${w}" height="${h}" transform="scale(${dpr})">${new XMLSerializer().serializeToString(cl)}</foreignObject></svg>`;
    const mi = await load(map), pw = (w + 32) * dpr, out = document.createElement('canvas');
    out.width = pw + c.width; out.height = Math.max(c.height, (h + 32) * dpr);
    const g = out.getContext('2d'); g.fillStyle = '#141416'; g.fillRect(0, 0, out.width, out.height); g.drawImage(mi, pw, 0);
    const pi = await load('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
    g.fillStyle = '#202024'; g.beginPath(); g.roundRect(16 * dpr, 16 * dpr, w * dpr, h * dpr, 28); g.fill(); g.drawImage(pi, 16 * dpr, 16 * dpr);
    return out.toDataURL('image/jpeg', 0.85);
  }
  window.LIDCAP = { shot, grab };
})();
