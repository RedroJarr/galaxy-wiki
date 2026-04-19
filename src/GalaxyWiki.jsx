import { useState, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";

// ============================================================
//  DATA ACCESS LAYER
//  The seed CSV is loaded from /public/data/stars.csv
//  User changes are stored in localStorage.
//  To add a backend later, replace dbLoad/dbSave with fetch().
// ============================================================

const DB_KEY = "galaxy-wiki-stars";

function parseCSV(csv) {
  const lines = csv.trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const parts = line.split(",");
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (parts[i] || "").trim(); });
    obj.r = Number(obj.r) || 0;
    obj.theta = Number(obj.theta) || 0;
    obj.height = Number(obj.height) || 0;
    obj.info = "";
    return obj;
  });
}

async function loadSeedData() {
  const res = await fetch("/data/stars.csv");
  const text = await res.text();
  return parseCSV(text);
}

function dbLoad() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p) && p.length) return p; }
  } catch(e) {}
  return null;
}

function dbSave(stars) {
  try { localStorage.setItem(DB_KEY, JSON.stringify(stars)); } catch(e) {}
}

function dbClear() {
  try { localStorage.removeItem(DB_KEY); } catch(e) {}
}

// Wookieepedia
function wikiSlug(name) { return name.trim().replace(/ /g, "_"); }
function makeWikiUrl(slug) { return "https://starwars.fandom.com/wiki/" + encodeURI(slug); }

// Wookieepedia auto-fetch (may need proxy in production — see /api/wiki.js)
async function fetchWikiSummary(slug) {
  try {
    const params = new URLSearchParams({
      action: "query",
      titles: slug.replace(/_/g, " "),
      prop: "extracts",
      exintro: "true",
      explaintext: "true",
      format: "json",
      origin: "*"
    });
    const res = await fetch("https://starwars.fandom.com/api.php?" + params.toString());
    if (!res.ok) return null;
    const d = await res.json();
    const pages = d && d.query && d.query.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined || !page.extract) return null;
    let extract = page.extract.trim();
    if (extract.length > 800) extract = extract.slice(0, 797) + "...";
    return { extract, url: makeWikiUrl(slug) };
  } catch(e) {
    // If direct fetch fails, try proxy (uncomment when proxy is set up):
    // try {
    //   const res = await fetch("/api/wiki?slug=" + encodeURIComponent(slug));
    //   if (!res.ok) return null;
    //   return await res.json();
    // } catch(e2) {}
    return null;
  }
}

// Height limits for galactic disc shape
function getHeightLimit(r) { if (r <= 100) return 50; if (r <= 200) return 15; if (r <= 400) return 8; return 3; }
function clampHeight(r, h) { const l = getHeightLimit(r); return Math.max(-l, Math.min(l, h)); }

// ============================================================
//  CHANGE TRACKING + SUBMISSION
// ============================================================

let sessionChanges = [];
function trackChange(action, star, details) {
  sessionChanges.push({ action, name: star.name, id: star.id, details, ts: Date.now() });
}

function buildSubmissionText(changes, currentStars) {
  if (!changes.length) return null;
  let lines = [];
  lines.push("GALAXY WIKI - CHANGE SUBMISSION");
  lines.push("Date: " + new Date().toISOString().slice(0, 16).replace("T", " "));
  lines.push("Changes: " + changes.length);
  lines.push("");
  const added = changes.filter(c => c.action === "created");
  const edited = changes.filter(c => c.action === "edited");
  const moved = changes.filter(c => c.action === "repositioned");
  if (added.length) {
    lines.push("--- NEW STARS ---");
    added.forEach(c => {
      const s = currentStars.find(x => x.id === c.id);
      if (s) lines.push(s.id + "," + s.name + "," + (s.wiki || wikiSlug(s.name)) + "," + s.r + "," + s.theta + "," + s.height + "," + s.color);
    });
    lines.push("");
  }
  if (edited.length) {
    lines.push("--- EDITS ---");
    edited.forEach(c => {
      const s = currentStars.find(x => x.id === c.id);
      if (s) lines.push(c.name + ": " + (c.details || "info/name/colour changed"));
    });
    lines.push("");
  }
  if (moved.length) {
    lines.push("--- REPOSITIONED ---");
    moved.forEach(c => {
      const s = currentStars.find(x => x.id === c.id);
      if (s) lines.push(c.name + ": now r=" + s.r + " theta=" + s.theta + " h=" + s.height);
    });
    lines.push("");
  }
  return lines.join("\n");
}

// Replace with your email address
const ADMIN_EMAIL = "your-email@example.com";

// Replace with your Formspree/Web3Forms endpoint URL when ready (optional)
const FORM_ENDPOINT = null;

// ============================================================
//  RENDERING
// ============================================================

function coordsToCartesian(r, thetaDeg, height) {
  const a = (thetaDeg * Math.PI) / 180;
  return [r * Math.cos(a), height, r * Math.sin(a)];
}

let idCounter = 500;
function genId() { return "s" + (++idCounter) + "_" + Date.now(); }

const COLORS = ["#FFE87C","#AED6F1","#E8744F","#E6B0AA","#D4E6F1","#F9E79F","#85C1E9","#ABEBC6","#D7BDE2","#FADBD8","#FFFFFF"];

export default function GalaxyWiki() {
  const mountRef = useRef(null);
  const threeRef = useRef({});
  const starsRef = useRef([]);
  const seedRef = useRef([]);
  const camTarget = useRef({ x:0, y:0, z:0 });
  const camGoal = useRef(null);
  const dragRef = useRef({ dragging:false, button:-1, lastX:0, lastY:0, moved:false });
  const camState = useRef({ dist:400, az:0.3, el:0.8 });

  const [stars, setStars] = useState([]);
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState("view");
  const [formData, setFormData] = useState({ name:"", r:100, theta:0, height:0, color:"#FFE87C" });
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [showSubmit, setShowSubmit] = useState(false);
  const [submitEmail, setSubmitEmail] = useState("");
  const [submitSent, setSubmitSent] = useState(false);
  const [changeCount, setChangeCount] = useState(0);

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(""), 3500); }

  // Load data: check localStorage first, fall back to seed CSV
  useEffect(() => {
    (async () => {
      const seed = await loadSeedData();
      seedRef.current = seed;
      let data = dbLoad();
      if (!data) { data = seed.map(s => ({...s})); dbSave(data); }
      starsRef.current = data; setStars(data); setLoaded(true);

      // Try to auto-fetch Wookieepedia descriptions for entries without info
      let changed = false;
      const updated = await Promise.all(data.map(async s => {
        if (s.info && s.info.length > 10) return s;
        const w = await fetchWikiSummary(s.wiki || wikiSlug(s.name));
        if (w && w.extract) { changed = true; return { ...s, info: w.extract, wikiUrl: w.url }; }
        return s;
      }));
      if (changed) { starsRef.current = updated; setStars(updated); dbSave(updated); }
    })();
  }, []);

  const saveStars = useCallback((ns) => {
    starsRef.current = ns; setStars(ns); dbSave(ns);
  }, []);

  // beforeunload warning
  useEffect(() => {
    const handler = (e) => {
      if (sessionChanges.length > 0) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  function applyCam(target) {
    const c = camState.current; const t = target || camTarget.current;
    const cam = threeRef.current.camera; if (!cam) return;
    cam.position.set(t.x+c.dist*Math.sin(c.el)*Math.cos(c.az), t.y+c.dist*Math.cos(c.el), t.z+c.dist*Math.sin(c.el)*Math.sin(c.az));
    cam.lookAt(t.x, t.y, t.z);
  }

  function flyTo(star) {
    const p = coordsToCartesian(star.r, star.theta, star.height);
    camGoal.current = { x:p[0], y:p[1], z:p[2], dist:Math.max(30, star.r*0.3+15), progress:0 };
  }

  // Three.js scene
  useEffect(() => {
    if (!loaded || !mountRef.current) return;
    const el = mountRef.current;
    const W = el.clientWidth; const H = el.clientHeight;
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x030308);
    const camera = new THREE.PerspectiveCamera(60, W/H, 1, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias:true });
    renderer.setSize(W, H); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    threeRef.current = { scene, camera, renderer, raycaster: new THREE.Raycaster(), meshes:[], glows:[], labels:[] };

    // Grid
    const gg = new THREE.Group();
    const gm = new THREE.LineBasicMaterial({ color:0x1a2a55, transparent:true, opacity:0.35 });
    const gmb = new THREE.LineBasicMaterial({ color:0x2a3a77, transparent:true, opacity:0.5 });
    [50,100,150,200,250,300].forEach((rad,idx) => {
      const pts = []; for(let i=0;i<=96;i++){const a=(i/96)*Math.PI*2;pts.push(new THREE.Vector3(Math.cos(a)*rad,0,Math.sin(a)*rad));}
      gg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), idx%2===1?gmb:gm));
    });
    for(let i=0;i<12;i++){const a=(i/12)*Math.PI*2;gg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(Math.cos(a)*320,0,Math.sin(a)*320)]),gm));}
    for(let i=0;i<12;i++){const deg=i*30;const a=(deg*Math.PI)/180;const cv=document.createElement("canvas");cv.width=128;cv.height=32;const cx=cv.getContext("2d");cx.font="14px system-ui,sans-serif";cx.textAlign="center";cx.textBaseline="middle";cx.fillStyle="rgba(80,110,180,0.55)";cx.fillText(deg+"\u00B0",64,16);const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(cv),transparent:true,depthWrite:false}));sp.scale.set(16,4,1);sp.position.set(Math.cos(a)*335,1,Math.sin(a)*335);gg.add(sp);}
    [50,100,150,200,250,300].forEach(rad=>{const cv=document.createElement("canvas");cv.width=128;cv.height=32;const cx=cv.getContext("2d");cx.font="16px system-ui,sans-serif";cx.textAlign="center";cx.textBaseline="middle";cx.fillStyle="rgba(60,90,160,0.6)";cx.fillText(String(rad),64,16);const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(cv),transparent:true,depthWrite:false}));sp.scale.set(20,5,1);sp.position.set(rad+2,1,8);gg.add(sp);});
    scene.add(gg);

    // Galactic centre
    const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(20,24,24), new THREE.MeshBasicMaterial({color:0xfffdf0}));
    scene.add(coreMesh);
    const mkG=(r,g,b,a,s)=>{const cv=document.createElement("canvas");cv.width=256;cv.height=256;const cx=cv.getContext("2d");const h=128;const gr=cx.createRadialGradient(h,h,0,h,h,h);gr.addColorStop(0,"rgba(255,253,240,"+a+")");gr.addColorStop(0.08,"rgba("+r+","+g+","+b+","+(a*0.85)+")");gr.addColorStop(0.3,"rgba("+r+","+g+","+b+","+(a*0.35)+")");gr.addColorStop(0.6,"rgba("+r+","+g+","+b+","+(a*0.1)+")");gr.addColorStop(1,"rgba(0,0,0,0)");cx.fillStyle=gr;cx.fillRect(0,0,256,256);const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(cv),transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));sp.scale.setScalar(s);return sp;};
    const coreGlows=[mkG(255,248,200,1,140),mkG(255,240,180,0.55,280),mkG(240,220,160,0.25,500)];
    const coreBases=[140,280,500]; coreGlows.forEach(s=>scene.add(s));
    const clc=document.createElement("canvas");clc.width=512;clc.height=64;const clx=clc.getContext("2d");clx.font="bold 26px system-ui,sans-serif";clx.textAlign="center";clx.textBaseline="middle";clx.fillStyle="rgba(0,0,0,0.4)";clx.fillText("Galactic Centre",257,34);clx.fillStyle="rgba(255,250,210,0.8)";clx.fillText("Galactic Centre",256,33);const clSp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(clc),transparent:true,depthWrite:false}));clSp.scale.set(55,7,1);clSp.position.set(0,32,0);scene.add(clSp);

    // Dust
    const dGeo=new THREE.BufferGeometry();const N=3000;const dp=new Float32Array(N*3);const dc=new Float32Array(N*3);
    for(let i=0;i<N;i++){dp[i*3]=(Math.random()-0.5)*1600;dp[i*3+1]=(Math.random()-0.5)*1600;dp[i*3+2]=(Math.random()-0.5)*1600;const b=0.15+Math.random()*0.3;dc[i*3]=b*0.6;dc[i*3+1]=b*0.65;dc[i*3+2]=b;}
    dGeo.setAttribute("position",new THREE.BufferAttribute(dp,3));dGeo.setAttribute("color",new THREE.BufferAttribute(dc,3));
    const dust=new THREE.Points(dGeo,new THREE.PointsMaterial({size:1.2,vertexColors:true,transparent:true,opacity:0.5}));scene.add(dust);
    for(let i=0;i<6;i++){const cv=document.createElement("canvas");cv.width=128;cv.height=128;const cx=cv.getContext("2d");const g=cx.createRadialGradient(64,64,0,64,64,64);g.addColorStop(0,"rgba("+(Math.random()*60|0)+","+(Math.random()*40|0)+","+(60+Math.random()*80|0)+",0.1)");g.addColorStop(1,"rgba(0,0,0,0)");cx.fillStyle=g;cx.fillRect(0,0,128,128);const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(cv),transparent:true,depthWrite:false}));sp.position.set((Math.random()-0.5)*500,(Math.random()-0.5)*200,(Math.random()-0.5)*500);const sc=200+Math.random()*250;sp.scale.set(sc,sc,1);scene.add(sp);}

    buildMeshes(starsRef.current);
    applyCam();

    let raf;
    const tick=()=>{raf=requestAnimationFrame(tick);const t=Date.now()*0.001;
      if(camGoal.current){const g=camGoal.current;g.progress=Math.min(1,g.progress+0.025);camTarget.current.x+=(g.x-camTarget.current.x)*0.06;camTarget.current.y+=(g.y-camTarget.current.y)*0.06;camTarget.current.z+=(g.z-camTarget.current.z)*0.06;camState.current.dist+=(g.dist-camState.current.dist)*0.06;applyCam();if(g.progress>=1)camGoal.current=null;}
      threeRef.current.glows.forEach((sp,i)=>{sp.scale.setScalar(sp.userData.baseScale*(1+Math.sin(t*1.8+i*1.7)*0.18));});
      coreGlows.forEach((sp,i)=>{sp.scale.setScalar(coreBases[i]*(1+Math.sin(t*0.8+i*2)*0.08));});
      coreMesh.scale.setScalar(1+Math.sin(t*1.2)*0.05);
      dust.rotation.y+=0.00003;renderer.render(scene,camera);};
    tick();

    const onResize=()=>{if(!el)return;camera.aspect=el.clientWidth/el.clientHeight;camera.updateProjectionMatrix();renderer.setSize(el.clientWidth,el.clientHeight);};
    window.addEventListener("resize",onResize);
    return()=>{cancelAnimationFrame(raf);window.removeEventListener("resize",onResize);try{el.removeChild(renderer.domElement);}catch(e){}renderer.dispose();};
  }, [loaded]);

  function makeStarGlow(color, size) {
    const c = new THREE.Color(color);const cv=document.createElement("canvas");cv.width=size;cv.height=size;const cx=cv.getContext("2d");const h=size/2;const g=cx.createRadialGradient(h,h,0,h,h,h);const r=Math.round(c.r*255);const gr=Math.round(c.g*255);const b=Math.round(c.b*255);g.addColorStop(0,"rgba(255,255,255,1)");g.addColorStop(0.06,"rgba("+r+","+gr+","+b+",0.95)");g.addColorStop(0.25,"rgba("+r+","+gr+","+b+",0.5)");g.addColorStop(0.55,"rgba("+r+","+gr+","+b+",0.12)");g.addColorStop(1,"rgba("+r+","+gr+","+b+",0)");cx.fillStyle=g;cx.fillRect(0,0,size,size);return new THREE.CanvasTexture(cv);
  }

  function buildMeshes(starList) {
    const ref=threeRef.current;if(!ref.scene)return;
    ref.meshes.forEach(m=>ref.scene.remove(m));ref.meshes.length=0;
    ref.glows.forEach(m=>ref.scene.remove(m));ref.glows.length=0;
    ref.labels.forEach(m=>ref.scene.remove(m));ref.labels.length=0;
    starList.forEach(s=>{
      const p=coordsToCartesian(s.r,s.theta,s.height);const col=s.color||"#FFE87C";
      const mesh=new THREE.Mesh(new THREE.SphereGeometry(2.5,14,14),new THREE.MeshBasicMaterial({color:0xffffff}));
      mesh.position.set(p[0],p[1],p[2]);mesh.userData={starId:s.id};ref.scene.add(mesh);ref.meshes.push(mesh);
      const iSp=new THREE.Sprite(new THREE.SpriteMaterial({map:makeStarGlow(col,128),transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));
      const isc=18+Math.random()*6;iSp.scale.setScalar(isc);iSp.userData={baseScale:isc};iSp.position.set(p[0],p[1],p[2]);ref.scene.add(iSp);ref.glows.push(iSp);
      const oSp=new THREE.Sprite(new THREE.SpriteMaterial({map:makeStarGlow(col,128),transparent:true,opacity:0.35,depthWrite:false,blending:THREE.AdditiveBlending}));
      const osc=35+Math.random()*12;oSp.scale.setScalar(osc);oSp.userData={baseScale:osc};oSp.position.set(p[0],p[1],p[2]);ref.scene.add(oSp);ref.glows.push(oSp);
      const lc=document.createElement("canvas");lc.width=512;lc.height=64;const lx=lc.getContext("2d");lx.font="bold 24px system-ui,sans-serif";lx.textAlign="center";lx.textBaseline="middle";lx.fillStyle="rgba(0,0,0,0.45)";lx.fillText(s.name,257,34);lx.fillStyle="rgba(255,255,255,0.8)";lx.fillText(s.name,256,33);
      const lSp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(lc),transparent:true,depthWrite:false}));lSp.scale.set(50,6.5,1);lSp.position.set(p[0],p[1]+10,p[2]);ref.scene.add(lSp);ref.labels.push(lSp);
    });
  }

  useEffect(()=>{if(!loaded||!threeRef.current.scene)return;buildMeshes(stars);},[stars,loaded]);

  const raycastStar=(ex,ey)=>{const ref=threeRef.current;if(!ref.raycaster||!ref.camera||!ref.meshes)return null;const rect=mountRef.current&&mountRef.current.getBoundingClientRect();if(!rect)return null;ref.raycaster.setFromCamera({x:((ex-rect.left)/rect.width)*2-1,y:-((ey-rect.top)/rect.height)*2+1},ref.camera);const hits=ref.raycaster.intersectObjects(ref.meshes);if(hits.length){return starsRef.current.find(s=>s.id===hits[0].object.userData.starId)||null;}return null;};

  const onDown=(e)=>{dragRef.current={dragging:true,button:e.button,lastX:e.clientX,lastY:e.clientY,moved:false};};
  const onMove=(e)=>{const d=dragRef.current;if(d.dragging){const dx=e.clientX-d.lastX;const dy=e.clientY-d.lastY;if(Math.abs(dx)>2||Math.abs(dy)>2)d.moved=true;const c=camState.current;if(d.button===0){c.az-=dx*0.005;c.el=Math.max(0.1,Math.min(Math.PI-0.1,c.el+dy*0.005));}else if(d.button===2){const cam=threeRef.current.camera;if(cam){const right=new THREE.Vector3();cam.getWorldDirection(right);right.cross(cam.up).normalize();const up=cam.up.clone();const ps=c.dist*0.002;camTarget.current.x-=(right.x*dx+up.x*-dy)*ps;camTarget.current.y-=(right.y*dx+up.y*-dy)*ps;camTarget.current.z-=(right.z*dx+up.z*-dy)*ps;}}d.lastX=e.clientX;d.lastY=e.clientY;camGoal.current=null;applyCam();}if(mountRef.current){mountRef.current.style.cursor=raycastStar(e.clientX,e.clientY)?"pointer":(d.dragging?"grabbing":"grab");}};
  const onUp=(e)=>{if(!dragRef.current.moved&&dragRef.current.button===0){const hit=raycastStar(e.clientX,e.clientY);if(hit){selectStar(hit);}else if(mode!=="add"){setSelected(null);setMode("view");}}dragRef.current.dragging=false;};
  const onWheel=(e)=>{e.preventDefault();camState.current.dist=Math.max(20,Math.min(2000,camState.current.dist+e.deltaY*0.5));camGoal.current=null;applyCam();};

  function selectStar(star){setSelected(star);setMode("view");setShowSubmit(false);flyTo(star);}

  // --- ACTIONS ---
  const addStar = async () => {
    const name = formData.name || "Unnamed Star";
    const rVal = Number(formData.r) || 100;
    const ns = { id:genId(), name, wiki:wikiSlug(name), r:rVal, theta:Number(formData.theta)||0, height:clampHeight(rVal, Number(formData.height)||0), info:"", color:formData.color };
    const all = [...starsRef.current, ns];
    saveStars(all);
    trackChange("created", ns); setChangeCount(sessionChanges.length);
    setSelected(ns); setMode("view"); flyTo(ns);
    setFormData({ name:"", r:100, theta:0, height:0, color:"#FFE87C" });
    // Try auto-fetch description
    const w = await fetchWikiSummary(ns.wiki);
    if (w && w.extract) {
      const upd = { ...ns, info: w.extract, wikiUrl: w.url };
      const a2 = starsRef.current.map(s => s.id === ns.id ? upd : s);
      saveStars(a2); setSelected(upd);
    }
    showToast("Star created.");
  };

  const editStar = () => {
    if (!selected) return;
    const changes = [];
    if (formData.name !== selected.name) changes.push("name");
    if (formData.color !== selected.color) changes.push("colour");
    if (formData.info !== (selected.info||"")) changes.push("info");
    const all = starsRef.current.map(s => s.id===selected.id ? { ...s, name:formData.name, info:formData.info, color:formData.color, wiki:formData.wiki||s.wiki } : s);
    saveStars(all);
    trackChange("edited", selected, changes.join(", ") + " changed"); setChangeCount(sessionChanges.length);
    setSelected(all.find(s=>s.id===selected.id)); setMode("view");
    showToast("Changes saved.");
  };

  const repositionStar = () => {
    if (!selected) return;
    const rVal = Number(formData.r);
    const all = starsRef.current.map(s => s.id===selected.id ? { ...s, r:rVal, theta:Number(formData.theta), height:clampHeight(rVal, Number(formData.height)) } : s);
    saveStars(all);
    trackChange("repositioned", selected); setChangeCount(sessionChanges.length);
    const up = all.find(s=>s.id===selected.id); setSelected(up); setMode("view"); flyTo(up);
    showToast("Position updated.");
  };

  const resetGalaxy = async () => {
    const seed = await loadSeedData();
    seedRef.current = seed;
    const fresh = seed.map(s => ({...s}));
    dbClear(); dbSave(fresh);
    starsRef.current = fresh; setStars(fresh); setSelected(null); setMode("view"); setConfirmReset(false);
    sessionChanges = []; setChangeCount(0);
    camTarget.current={x:0,y:0,z:0}; camState.current={dist:400,az:0.3,el:0.8}; applyCam();
    showToast("Galaxy reset.");
  };

  // --- SUBMISSION ---
  const openSubmitPanel = () => { setShowSubmit(true); setSelected(null); setMode("view"); setSubmitSent(false); };

  const sendSubmission = () => {
    const body = buildSubmissionText(sessionChanges, starsRef.current);
    if (!body) return;
    const subject = "Galaxy Wiki - Change Submission (" + sessionChanges.length + " changes)";

    if (FORM_ENDPOINT) {
      fetch(FORM_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ email: submitEmail, subject, message: body })
      }).then(() => {
        setSubmitSent(true); showToast("Changes submitted!");
      }).catch(() => { showToast("Submission failed."); });
    } else {
      const mailUrl = "mailto:" + ADMIN_EMAIL + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent("From: " + (submitEmail || "anonymous") + "\n\n" + body);
      window.open(mailUrl, "_blank");
      setSubmitSent(true); showToast("Email client opened.");
    }
  };

  const startEdit=()=>{setFormData({name:selected.name,info:selected.info||"",color:selected.color,r:selected.r,theta:selected.theta,height:selected.height,wiki:selected.wiki||""});setMode("edit");};
  const startReposition=()=>{setFormData({...formData,r:selected.r,theta:selected.theta,height:selected.height});setMode("reposition");};
  const startAdd=()=>{setFormData({name:"",r:100,theta:Math.round(Math.random()*360),height:0,color:"#FFE87C"});setMode("add");setSelected(null);setShowSubmit(false);};
  const goHome=()=>{camTarget.current={x:0,y:0,z:0};camState.current={dist:400,az:0.3,el:0.8};camGoal.current=null;applyCam();};

  const starWikiUrl=selected?makeWikiUrl(selected.wiki||wikiSlug(selected.name)):null;

  // Styles
  const ps={position:"absolute",top:12,right:12,width:340,maxHeight:"calc(100% - 24px)",background:"rgba(8,8,24,0.93)",border:"1px solid rgba(80,100,160,0.35)",borderRadius:12,padding:16,color:"#c8d4ee",fontSize:13,overflowY:"auto",zIndex:10,fontFamily:"system-ui,sans-serif"};
  const btn={background:"rgba(60,80,130,0.4)",border:"1px solid rgba(90,120,190,0.35)",color:"#b8c8ee",borderRadius:6,padding:"6px 14px",cursor:"pointer",fontSize:12};
  const btnP={...btn,background:"rgba(70,110,210,0.45)",borderColor:"rgba(100,150,255,0.4)"};
  const btnD={...btn,background:"rgba(180,50,50,0.4)",borderColor:"rgba(200,70,70,0.35)"};
  const btnS={...btn,padding:"4px 10px",fontSize:11};
  const btnSubmit={...btn,background:"rgba(50,160,80,0.45)",borderColor:"rgba(80,200,110,0.4)"};
  const inp={background:"rgba(15,18,40,0.85)",border:"1px solid rgba(80,100,160,0.35)",color:"#c8d4ee",borderRadius:6,padding:"6px 10px",fontSize:13,width:"100%",boxSizing:"border-box",outline:"none"};
  const lbl={fontSize:11,color:"#7888aa",marginBottom:3,display:"block",marginTop:8};

  return (
    <div style={{width:"100%",height:"100vh",position:"relative",background:"#030308",overflow:"hidden"}}>
      <div ref={mountRef} style={{width:"100%",height:"100%",cursor:"grab"}} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onWheel={onWheel} onContextMenu={e=>e.preventDefault()} />

      {/* Toolbar */}
      <div style={{position:"absolute",top:12,left:12,display:"flex",gap:6,zIndex:10,alignItems:"center",flexWrap:"wrap"}}>
        <button style={btnP} onClick={startAdd}>+ New star</button>
        <button style={btn} onClick={goHome}>Home</button>
        {confirmReset ? (
          <><button style={btnD} onClick={resetGalaxy}>Confirm reset</button><button style={btn} onClick={()=>setConfirmReset(false)}>Cancel</button></>
        ) : (
          <button style={btnS} onClick={()=>setConfirmReset(true)}>Reset</button>
        )}
        <button style={btnSubmit} onClick={openSubmitPanel}>
          Submit changes{changeCount > 0 && <span style={{marginLeft:6,background:"rgba(80,200,110,0.6)",borderRadius:10,padding:"1px 6px",fontSize:10}}>{changeCount}</span>}
        </button>
        <span style={{color:"#445577",fontSize:11,marginLeft:4}}>{stars.length} stars</span>
      </div>

      {/* Toast */}
      {toast && <div style={{position:"absolute",bottom:50,left:"50%",transform:"translateX(-50%)",background:"rgba(8,8,24,0.92)",border:"1px solid rgba(80,100,160,0.4)",borderRadius:8,padding:"8px 16px",color:"#a0b8dd",fontSize:12,zIndex:20,whiteSpace:"nowrap"}}>{toast}</div>}

      {/* Side panel */}
      {(selected || mode==="add" || showSubmit) && (
        <div style={ps}>

          {mode==="view" && selected && !showSubmit && (<>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
              <div style={{width:16,height:16,borderRadius:"50%",background:selected.color,boxShadow:"0 0 12px "+selected.color}} />
              <div style={{fontSize:18,fontWeight:600,color:"#e4ecfa",flex:1}}>{selected.name}</div>
            </div>
            <div style={{background:"rgba(15,18,40,0.7)",borderRadius:8,padding:"8px 12px",marginBottom:12,fontFamily:"monospace",fontSize:12,color:"#7888aa"}}>
              r = {selected.r}&nbsp;&nbsp;&nbsp;&theta; = {selected.theta}&deg;&nbsp;&nbsp;&nbsp;h = {selected.height>=0?"+":""}{selected.height}
            </div>
            {selected.info ? (
              <div style={{lineHeight:1.7,marginBottom:10,color:"#a0b0cc",maxHeight:180,overflowY:"auto"}}>{selected.info}</div>
            ) : (
              <div style={{color:"#556688",fontStyle:"italic",marginBottom:10}}>No description yet — click Edit to add one.</div>
            )}
            <div style={{display:"flex",gap:6,marginBottom:12,alignItems:"center"}}>
              {starWikiUrl && <a href={starWikiUrl} target="_blank" rel="noopener noreferrer" style={{color:"#6688cc",fontSize:12,textDecoration:"none"}}>Read on Wookieepedia &#8599;</a>}
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button style={btn} onClick={startEdit}>Edit</button>
              <button style={btn} onClick={startReposition}>Reposition</button>
              <button style={{...btn,marginLeft:"auto"}} onClick={()=>{setSelected(null);setMode("view");}}>Close</button>
            </div>
          </>)}

          {mode==="add" && !showSubmit && (<>
            <div style={{fontSize:16,fontWeight:600,color:"#e4ecfa",marginBottom:4}}>New star entry</div>
            <div style={{fontSize:11,color:"#667799",marginBottom:8}}>Wookieepedia link generated automatically from name.</div>
            <label style={lbl}>Name</label>
            <input style={inp} value={formData.name} onChange={e=>setFormData(f=>({...f,name:e.target.value}))} placeholder="e.g. Coruscant, Tatooine..." />
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:4}}>
              <div><label style={lbl}>r (dist)</label><input style={inp} type="number" value={formData.r} onChange={e=>setFormData(f=>({...f,r:e.target.value}))} /></div>
              <div><label style={lbl}>&theta; (deg)</label><input style={inp} type="number" step="1" value={formData.theta} onChange={e=>setFormData(f=>({...f,theta:e.target.value}))} /></div>
              <div><label style={lbl}>h (elev)</label><input style={inp} type="number" value={formData.height} onChange={e=>setFormData(f=>({...f,height:e.target.value}))} /></div>
            </div>
            <div style={{fontSize:10,color:"#556688",marginTop:2}}>Height limit: &plusmn;{getHeightLimit(Number(formData.r)||100)}</div>
            <label style={lbl}>Colour</label>
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:4}}>
              {COLORS.map(c=><div key={c} onClick={()=>setFormData(f=>({...f,color:c}))} style={{width:22,height:22,borderRadius:"50%",background:c,cursor:"pointer",border:formData.color===c?"2px solid #88aaff":"2px solid transparent",boxShadow:formData.color===c?"0 0 8px "+c:"none"}} />)}
            </div>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button style={btnP} onClick={addStar}>Create star</button>
              <button style={btn} onClick={()=>setMode("view")}>Cancel</button>
            </div>
          </>)}

          {mode==="edit" && selected && !showSubmit && (<>
            <div style={{fontSize:16,fontWeight:600,color:"#e4ecfa",marginBottom:8}}>Edit: {selected.name}</div>
            <label style={lbl}>Name</label>
            <input style={inp} value={formData.name} onChange={e=>setFormData(f=>({...f,name:e.target.value}))} />
            <label style={lbl}>Wookieepedia slug</label>
            <input style={inp} value={formData.wiki||""} onChange={e=>setFormData(f=>({...f,wiki:e.target.value}))} placeholder="e.g. Coruscant" />
            <label style={lbl}>Colour</label>
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:4}}>
              {COLORS.map(c=><div key={c} onClick={()=>setFormData(f=>({...f,color:c}))} style={{width:22,height:22,borderRadius:"50%",background:c,cursor:"pointer",border:formData.color===c?"2px solid #88aaff":"2px solid transparent"}} />)}
            </div>
            <label style={lbl}>Description</label>
            <textarea style={{...inp,height:100,resize:"vertical"}} value={formData.info} onChange={e=>setFormData(f=>({...f,info:e.target.value}))} placeholder="Write a description or paste from Wookieepedia..." />
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button style={btnP} onClick={editStar}>Save</button>
              <button style={btn} onClick={()=>setMode("view")}>Cancel</button>
            </div>
          </>)}

          {mode==="reposition" && selected && !showSubmit && (<>
            <div style={{fontSize:16,fontWeight:600,color:"#e4ecfa",marginBottom:8}}>Reposition: {selected.name}</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              <div><label style={lbl}>r</label><input style={inp} type="number" value={formData.r} onChange={e=>setFormData(f=>({...f,r:e.target.value}))} /></div>
              <div><label style={lbl}>&theta;</label><input style={inp} type="number" step="1" value={formData.theta} onChange={e=>setFormData(f=>({...f,theta:e.target.value}))} /></div>
              <div><label style={lbl}>h</label><input style={inp} type="number" value={formData.height} onChange={e=>setFormData(f=>({...f,height:e.target.value}))} /></div>
            </div>
            <div style={{fontSize:10,color:"#556688",marginTop:2}}>Height limit: &plusmn;{getHeightLimit(Number(formData.r)||100)}</div>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button style={btnP} onClick={repositionStar}>Apply</button>
              <button style={btn} onClick={()=>setMode("view")}>Cancel</button>
            </div>
          </>)}

          {showSubmit && (<>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{fontSize:16,fontWeight:600,color:"#e4ecfa"}}>Submit your changes</div>
              <button style={btnS} onClick={()=>setShowSubmit(false)}>Close</button>
            </div>
            {sessionChanges.length === 0 ? (
              <div style={{color:"#556688",fontStyle:"italic",lineHeight:1.7}}>You haven't made any changes this session. Add, edit, or reposition some stars, then come back here to submit them for review.</div>
            ) : submitSent ? (
              <div style={{lineHeight:1.7}}>
                <div style={{color:"#66cc88",fontWeight:500,marginBottom:8}}>Changes submitted — thank you!</div>
                <div style={{color:"#8899bb",fontSize:12}}>Your {sessionChanges.length} change{sessionChanges.length>1?"s":""} will be reviewed. Approved changes will appear in the next galaxy update.</div>
              </div>
            ) : (<>
              <div style={{color:"#8899bb",fontSize:12,lineHeight:1.6,marginBottom:12}}>
                You have {sessionChanges.length} change{sessionChanges.length>1?"s":""}. Review below, then enter your email and submit.
              </div>
              <div style={{background:"rgba(15,18,40,0.7)",borderRadius:8,padding:"10px 12px",marginBottom:12,fontFamily:"monospace",fontSize:11,lineHeight:1.7,color:"#7888aa",maxHeight:150,overflowY:"auto",whiteSpace:"pre-wrap"}}>
                {sessionChanges.map((c,i) => (
                  <div key={i}>
                    <span style={{color:c.action==="created"?"#66cc88":"#88aadd"}}>{c.action}</span>
                    {" "}{c.name}{c.details ? " — "+c.details : ""}
                  </div>
                ))}
              </div>
              <label style={lbl}>Your email (so we can follow up)</label>
              <input style={inp} type="email" value={submitEmail} onChange={e=>setSubmitEmail(e.target.value)} placeholder="you@example.com" />
              <div style={{display:"flex",gap:8,marginTop:12}}>
                <button style={{...btnP,background:"rgba(50,160,80,0.5)",borderColor:"rgba(80,200,110,0.4)"}} onClick={sendSubmission}>Send submission</button>
              </div>
              <div style={{fontSize:10,color:"#556688",marginTop:8,lineHeight:1.5}}>
                This will open your email client with the changes pre-filled.
              </div>
            </>)}
          </>)}
        </div>
      )}

      <StarSearch stars={stars} onSelect={selectStar} />
    </div>
  );
}

function StarSearch({stars,onSelect}){
  const[q,setQ]=useState("");const[open,setOpen]=useState(false);
  const filtered=q.length>0?stars.filter(s=>s.name.toLowerCase().includes(q.toLowerCase())):[];
  return(
    <div style={{position:"absolute",bottom:12,left:12,zIndex:10,width:260}}>
      <input style={{background:"rgba(8,8,24,0.9)",border:"1px solid rgba(80,100,160,0.35)",color:"#c8d4ee",borderRadius:8,padding:"8px 12px",fontSize:13,width:"100%",boxSizing:"border-box",outline:"none"}} placeholder="Search stars..." value={q} onFocus={()=>setOpen(true)} onBlur={()=>setTimeout(()=>setOpen(false),200)} onChange={e=>{setQ(e.target.value);setOpen(true);}} />
      {open&&filtered.length>0&&(
        <div style={{background:"rgba(8,8,24,0.96)",border:"1px solid rgba(80,100,160,0.35)",borderRadius:8,marginTop:4,maxHeight:180,overflowY:"auto"}}>
          {filtered.map(s=>(
            <div key={s.id} style={{padding:"8px 12px",cursor:"pointer",display:"flex",alignItems:"center",gap:8,borderBottom:"1px solid rgba(80,100,160,0.15)"}} onMouseDown={()=>{onSelect(s);setQ("");setOpen(false);}} onMouseEnter={e=>{e.currentTarget.style.background="rgba(60,80,130,0.3)";}} onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
              <div style={{width:10,height:10,borderRadius:"50%",background:s.color,boxShadow:"0 0 6px "+s.color}} />
              <span style={{color:"#b8c8ee",fontSize:13}}>{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
