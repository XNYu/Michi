import * as THREE from './node_modules/three/build/three.module.js';

const CARD_W = 152, CARD_H = 88, GAP_X = 180, GAP_Y = 118;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Real Three.js orthographic scene: rounded meshes, tube edges, projected DOM labels.
 * DOM labels keep the small Chinese typography sharp and the nodes keyboard-accessible.
 * One canvas per tree, rebuilt/disposed on data changes; zero rendering while closed. */
export class ThoughtTree {
  constructor(viewport, labels, onSelect) {
    this.viewport = viewport;
    this.labels = labels;
    this.onSelect = onSelect;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-200, 200, 200, -200, .1, 3000);
    this.camera.position.z = 1000;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.materials = [];
    this.nodes = [];
    this.pointers = new Map();
    this.motion = { x: 0, y: 0, scale: 1, tx: 0, ty: 0, ts: 1, vx: 0, vy: 0, vs: 0 };
    this.active = false;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.setClearColor(0x000000, 0);
      viewport.prepend(this.renderer.domElement);
    } catch {
      // Still usable when WebGL is disabled; the primary path renders the geometry in WebGL.
      this.renderer = null;
      this.fallbackSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      Object.assign(this.fallbackSVG.style, { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' });
      viewport.prepend(this.fallbackSVG);
    }
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(viewport);
    this.bindGestures();
  }

  rounded(w, h, r) {
    const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
    s.moveTo(x+r,y); s.lineTo(x+w-r,y); s.quadraticCurveTo(x+w,y,x+w,y+r);
    s.lineTo(x+w,y+h-r); s.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    s.lineTo(x+r,y+h); s.quadraticCurveTo(x,y+h,x,y+h-r);
    s.lineTo(x,y+r); s.quadraticCurveTo(x,y,x+r,y);
    return new THREE.ShapeGeometry(s, 12);
  }

  mesh(geometry, color, x, y, z, opacity = 1) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity === 1 });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    return mesh;
  }

  setData(data, current) {
    this.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    this.group.clear(); this.labels.replaceChildren();
    this.current = current;
    const positions = new Map();
    let leaf = 0;
    const place = (node, depth) => {
      const children = data.filter(n => n.parent === node.id);
      let x;
      if (children.length) {
        const xs = children.map(n => place(n, depth + 1));
        x = (xs[0] + xs.at(-1)) / 2;
      } else x = leaf++ * GAP_X;
      positions.set(node.id, { x, y: -depth * GAP_Y });
      return x;
    };
    data.filter(n => !n.parent).forEach(n => place(n, 0));
    const xs = [...positions.values()].map(p => p.x), ys = [...positions.values()].map(p => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    positions.forEach(p => { p.x -= cx; p.y -= cy; });
    this.bounds = { w: Math.max(...xs) - Math.min(...xs) + CARD_W + 30, h: Math.max(...ys) - Math.min(...ys) + CARD_H + 45 };
    const style = getComputedStyle(document.documentElement);
    const color = name => style.getPropertyValue(name).trim();
    this.edges = [];
    for (const n of data) {
      if (!n.parent) continue;
      const a = positions.get(n.parent), b = positions.get(n.id);
      if (!a || !b) continue;
      const from = new THREE.Vector3(a.x, a.y-CARD_H/2, 0);
      const to = new THREE.Vector3(b.x, b.y+CARD_H/2, 0);
      const curve = new THREE.CubicBezierCurve3(from, new THREE.Vector3(from.x, from.y-28,0),new THREE.Vector3(to.x,to.y+28,0),to);
      this.mesh(new THREE.TubeGeometry(curve,32,n.id===current?1.1:.8,6,false),color(n.id===current?'--accent':'--line-strong'),0,0,0);
      this.edges.push({ a: from, b: to, active: n.id === current });
    }
    this.nodes = data.map((n,i) => {
      const p = positions.get(n.id);
      const selected = n.id === current;
      this.mesh(this.rounded(CARD_W+4,CARD_H+4,18),color('--fg'),p.x,p.y-4,1,.035);
      this.mesh(this.rounded(CARD_W+1,CARD_H+1,16),color(selected?'--accent':'--line-strong'),p.x,p.y,2);
      this.mesh(this.rounded(CARD_W-(selected?3:1),CARD_H-(selected?3:1),15),color('--surface'),p.x,p.y,3);
      if (selected) this.mesh(new THREE.CircleGeometry(3,16),color('--accent'),p.x,p.y-CARD_H/2-8,4);
      const el = document.createElement('button');
      el.className = `tree-node${selected?' current':''}${this.renderer?'':' fallback'}`;
      el.dataset.node = n.id;
      el.setAttribute('aria-label',`${n.title}${selected?'，当前页面':''}`);
      el.setAttribute('aria-current',selected?'page':'false');
      const meta = document.createElement('span'); meta.className = 'tree-node-meta';
      const caption = document.createElement('span'); caption.textContent = n.parent ? `分支 ${String(i).padStart(2,'0')}` : '起点 · 主线';
      const dot = document.createElement('span'); dot.className = 'node-dot';
      meta.append(caption,dot);
      const title = document.createElement('strong'); title.textContent = n.title;
      const summary = document.createElement('small'); summary.textContent = n.summary;
      el.append(meta,title,summary);
      el.addEventListener('click',e => { if(e.detail === 0 || !this.didDrag) this.onSelect(n.id); });
      this.labels.append(el);
      return { id:n.id, x:p.x, y:p.y, el };
    });
    this.fit(true);
  }

  resize() {
    this.width = this.viewport.clientWidth;
    this.height = this.viewport.clientHeight;
    if (!this.width || !this.height) return;
    this.camera.left = -this.width/2; this.camera.right = this.width/2;
    this.camera.top = this.height/2; this.camera.bottom = -this.height/2;
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(this.width,this.height);
    if (this.bounds) this.fit(true);
  }

  fit(immediate=false) {
    if (!this.bounds) return;
    this.motion.ts = Math.min((this.width-24)/this.bounds.w,(this.height-20)/this.bounds.h,1.13);
    this.fitScale = this.motion.ts;
    this.motion.tx = 0; this.motion.ty = 0;
    if (immediate) { this.motion.x=0;this.motion.y=0;this.motion.scale=this.motion.ts; this.motion.vx=0;this.motion.vy=0;this.motion.vs=0; }
    this.draw();
  }

  zoom(factor) {
    this.motion.ts = clamp(this.motion.ts * factor,this.fitScale*.65,2.4);
  }

  setActive(active) { this.active=active; if(active){this.resize();this.draw();} }

  update(dt) {
    if (!this.active) return;
    const m = this.motion;
    if (!this.pointers.size) {
      for (const [key,target,velocity] of [['x','tx','vx'],['y','ty','vy'],['scale','ts','vs']]) {
        if (this.reduced) { m[key] = m[target]; m[velocity] = 0; continue; }
        m[velocity] += ((m[target]-m[key])*220-m[velocity]*29)*dt;
        m[key] += m[velocity]*dt;
      }
    }
    this.draw();
  }

  draw() {
    if (!this.width || !this.height) return;
    const m = this.motion;
    this.group.position.set(m.x,m.y,0); this.group.scale.setScalar(m.scale);
    this.group.updateMatrixWorld(true);
    this.renderer?.render(this.scene,this.camera);
    for (const n of this.nodes) {
      const x=this.width/2+m.x+(n.x-CARD_W/2)*m.scale;
      const y=this.height/2-m.y+(-n.y-CARD_H/2)*m.scale;
      n.el.style.transform=`translate3d(${x}px,${y}px,0) scale(${m.scale})`;
    }
    if (this.fallbackSVG) {
      this.fallbackSVG.replaceChildren();
      this.edges.forEach(({a,b,active}) => {
        const p=document.createElementNS('http://www.w3.org/2000/svg','path');
        const ax=this.width/2+m.x+a.x*m.scale, ay=this.height/2-m.y-a.y*m.scale;
        const bx=this.width/2+m.x+b.x*m.scale, by=this.height/2-m.y-b.y*m.scale;
        p.setAttribute('d',`M${ax},${ay} C${ax},${ay+28*m.scale} ${bx},${by-28*m.scale} ${bx},${by}`);
        p.setAttribute('fill','none');p.setAttribute('stroke',active?'var(--accent)':'var(--line-strong)');
        this.fallbackSVG.append(p);
      });
    }
  }

  bindGestures() {
    const v=this.viewport, m=this.motion;
    v.addEventListener('pointerdown',e=>{
      if (e.button!==0) return;
      this.didDrag=false;
      this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      this.start={x:e.clientX,y:e.clientY,mx:m.x,my:m.y,time:performance.now()};
      this.last={x:e.clientX,y:e.clientY,time:performance.now()};
      this.velocity={x:0,y:0};
      if(this.pointers.size===2){
        const [a,b]=[...this.pointers.values()];
        this.pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),scale:m.scale};
      }
    });
    v.addEventListener('pointermove',e=>{
      if(!this.pointers.has(e.pointerId))return;
      this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(this.pointers.size===2){
        this.didDrag=true;
        const [a,b]=[...this.pointers.values()];
        m.scale=m.ts=clamp(this.pinch.scale*Math.hypot(a.x-b.x,a.y-b.y)/this.pinch.distance,this.fitScale*.65,2.4);
      }else{
        const dx=e.clientX-this.start.x, dy=e.clientY-this.start.y;
        if(Math.hypot(dx,dy)>7){this.didDrag=true;v.setPointerCapture(e.pointerId);}
        if(!this.didDrag)return;
        m.x=m.tx=this.start.mx+dx;m.y=m.ty=this.start.my-dy;
        const now=performance.now(),dt=Math.max(now-this.last.time,8)/1000;
        this.velocity={x:(e.clientX-this.last.x)/dt,y:-(e.clientY-this.last.y)/dt};
        this.last={x:e.clientX,y:e.clientY,time:now};
      }
      e.preventDefault();
    });
    const release=e=>{
      if(!this.pointers.has(e.pointerId))return;
      this.pointers.delete(e.pointerId);
      if(this.pointers.size){
        const p=[...this.pointers.values()][0];
        this.start={x:p.x,y:p.y,mx:m.x,my:m.y,time:performance.now()};
        return;
      }
      if(this.didDrag){
        const recent=performance.now()-this.last.time<90;
        m.vx=recent?clamp(this.velocity.x,-1400,1400):0;m.vy=recent?clamp(this.velocity.y,-1400,1400):0;
        const limitX=(this.bounds.w*m.scale+this.width)*.42, limitY=(this.bounds.h*m.scale+this.height)*.42;
        m.tx=clamp(m.x+m.vx*.12,-limitX,limitX);m.ty=clamp(m.y+m.vy*.12,-limitY,limitY);
      }
    };
    v.addEventListener('pointerup',release);v.addEventListener('pointercancel',release);
    window.addEventListener('pointerup',release);
    v.addEventListener('wheel',e=>{
      e.preventDefault();
      if(e.ctrlKey||e.metaKey) this.zoom(Math.exp(-e.deltaY*.008));
      else {m.tx-=e.deltaX;m.ty+=e.deltaY;}
    },{passive:false});
  }
}
