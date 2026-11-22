import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { NODES, EDGES } from './steps.js';

function labelSprite(text) {
  const c = document.createElement('canvas'); c.width = 384; c.height = 96;
  const g = c.getContext('2d'); g.font = '600 38px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#e8f0ff'; g.fillText(text, 192, 48);
  const t = new THREE.CanvasTexture(c); t.anisotropy = 4;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  s.scale.set(2.2, 0.55, 1); return s;
}

export default function Scene({ active, flow, paused, reduced, onFail }) {
  const mount = useRef(null);
  const st = useRef({ active, flow, paused, reduced });
  st.current = { active, flow, paused, reduced };

  useEffect(() => {
    const el = mount.current; let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch (e) { onFail(); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    const nodes = {}, group = new THREE.Group(); scene.add(group);
    const geo = new THREE.IcosahedronGeometry(0.38, 1);
    for (const [id, n] of Object.entries(NODES)) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x28406e, emissive: 0x0a1630, roughness: 0.4, metalness: 0.3 });
      const m = new THREE.Mesh(geo, mat); m.position.set(...n.pos); group.add(m);
      const l = labelSprite(n.label); l.position.set(n.pos[0], n.pos[1] - 0.75, 0.2); group.add(l);
      nodes[id] = { m, mat, l };
    }
    const edges = EDGES.map(([a, b]) => {
      const pa = new THREE.Vector3(...NODES[a].pos), pb = new THREE.Vector3(...NODES[b].pos);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([pa, pb]), new THREE.LineBasicMaterial({ color: 0x3a5280, transparent: true, opacity: 0.45 }));
      group.add(line); return { a, b, pa, pb, line };
    });
    const packets = [];
    const pgeo = new THREE.SphereGeometry(0.12, 12, 12);
    for (let i = 0; i < 6; i++) { const p = new THREE.Mesh(pgeo, new THREE.MeshBasicMaterial({ color: 0xffc857 })); p.visible = false; group.add(p); packets.push(p); }
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(3, 5, 8); scene.add(dl);

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h, false);
      cam.aspect = w / h;
      const tan = Math.tan(THREE.MathUtils.degToRad(20));
      const dist = Math.max(8 / (2 * tan), 13.4 / (2 * tan * cam.aspect));
      const k = w < 520 ? 1.35 : 1; Object.values(nodes).forEach(n => n && n.l && n.l.scale.set(2.2 * k, 0.55 * k, 1));
      cam.position.set(0, 0, dist); cam.lookAt(0, 0, 0); cam.updateProjectionMatrix();
    };
    resize(); const ro = new ResizeObserver(() => { resize(); draw(performance.now()); }); ro.observe(el);

    let raf = 0, t0 = performance.now();
    function draw(now) {
      const s = st.current, t = (now - t0) / 1000;
      const act = new Set(s.active);
      for (const [id, n] of Object.entries(nodes)) {
        const on = act.has(id);
        const pulse = on && !s.reduced ? 1 + 0.12 * Math.sin(t * 3) : 1;
        n.m.scale.setScalar(on ? 1.25 * pulse : 0.9);
        n.mat.color.setHex(on ? 0xffc857 : 0x28406e); n.mat.emissive.setHex(on ? 0x5a3d00 : 0x0a1630);
        n.l.material.opacity = on ? 1 : 0.5;
        if (!s.reduced) n.m.rotation.y = t * 0.4;
      }
      const flowSet = s.flow.map(([a, b]) => [a, b]);
      for (const e of edges) {
        const hot = flowSet.some(([a, b]) => (a === e.a && b === e.b) || (a === e.b && b === e.a));
        e.line.material.opacity = hot ? 1 : act.has(e.a) && act.has(e.b) ? 0.7 : 0.3;
        e.line.material.color.setHex(hot ? 0xffc857 : 0x3a5280);
      }
      packets.forEach((p, i) => {
        const f = flowSet[i % Math.max(flowSet.length, 1)];
        if (!f || i >= flowSet.length * 2) { p.visible = false; return; }
        const pa = new THREE.Vector3(...NODES[f[0]].pos), pb = new THREE.Vector3(...NODES[f[1]].pos);
        const k = s.reduced ? 0.5 : ((t * 0.5 + i * 0.37) % 1);
        p.position.lerpVectors(pa, pb, k); p.visible = true;
      });
      if (!s.reduced) group.rotation.y = Math.sin(t * 0.25) * 0.18;
      else group.rotation.y = 0.1;
      renderer.render(scene, cam);
    }
    const loop = (now) => { if (!st.current.paused && !st.current.reduced) draw(now); raf = requestAnimationFrame(loop); };
    draw(performance.now()); raf = requestAnimationFrame(loop);
    const redraw = () => draw(performance.now());
    el._redraw = redraw;
    return () => { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); el.removeChild(renderer.domElement); };
  }, []);

  // static redraw when paused/reduced and state changes
  useEffect(() => { const el = mount.current; if (el && el._redraw && (paused || reduced)) requestAnimationFrame(el._redraw); }, [active, flow, paused, reduced]);

  return <div ref={mount} className="scene" role="img" aria-label="3D" />;
}
