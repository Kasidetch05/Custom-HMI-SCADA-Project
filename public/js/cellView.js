// Draws the robot cell on a <canvas> from the frames the server streams.
// Frames arrive 20 times a second. We draw at the screen's refresh rate by
// blending the two frames on either side of "now minus a small delay".

(function () {
  'use strict';

  const C = {
    wallTop: '#1e262f', wallBottom: '#182028', grid: 'rgba(255,255,255,0.025)',
    floor: '#12171c', floorEdge: '#2f3b47',
    steel: '#8c99a6', steelDark: '#56616d', steelLight: '#c3ccd4',
    belt: '#2a2f35', beltMark: '#3e464f',
    yellow: '#f2c230', yellowDark: '#a8860f',
    ivory: '#ece8df', ivoryLight: '#f8f6f1', ivoryShade: '#c7c1b3', ivoryEdge: '#8f897b',
    stripe: '#c8322f',
    graphite: '#39424c', graphiteDark: '#262d35',
    kraft: '#c69157', kraftLight: '#dcae76', kraftDark: '#86592e', tape: '#e2c08f', label: '#f2efe8',
    ok: '#3cc4ae', bad: '#f0605d', text: '#ece8df', muted: '#a3adb8',
    binBody: '#6e2626', binRim: '#8d3331', binWindow: '#2a1414',
    packer: '#2b3744', packerEdge: '#4a5b6e', tunnel: '#0e1318',
  };

  const DEFECTS = { flap: 'Open flap', label: 'Missing label', dent: 'Dented corner', size: 'Wrong size' };
  const RENDER_DELAY = 110; // ms behind the newest frame, so there is always a frame to blend towards

  class CellView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.G = null;
      this.frames = [];
      this.offset = null;
      this.beltIn = 0;
      this.beltOut = 0;
      this.last = performance.now();
      new ResizeObserver(() => this.resize()).observe(canvas);
      this.resize();
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }

    setLayout(G) { this.G = G; }

    push(frame) {
      const now = performance.now();
      const prev = this.frames[this.frames.length - 1];
      if (prev && frame.t < prev.t) { this.frames = []; this.offset = null; } // server restarted
      const sample = now - frame.t;
      if (this.offset === null || sample < this.offset) this.offset = sample;
      else this.offset += (sample - this.offset) * 0.02;
      this.frames.push(frame);
      if (this.frames.length > 40) this.frames.shift();
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
      this.dpr = dpr;
    }

    loop(now) {
      requestAnimationFrame(this.loop);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (!this.G || document.hidden || this.canvas.offsetParent === null) return;
      const f = this.sample(now);
      if (f) {
        this.beltIn += f.beltIn * dt;
        this.beltOut += f.beltOut * dt;
      }
      this.draw(f);
    }

    // Blend the two frames around the render time
    sample(now) {
      const fr = this.frames;
      if (!fr.length) return null;
      const rt = now - this.offset - RENDER_DELAY;
      if (rt <= fr[0].t) return fr[0];
      const last = fr[fr.length - 1];
      if (rt >= last.t) return last;
      let i = fr.length - 2;
      while (i > 0 && fr[i].t > rt) i--;
      const a = fr[i], b = fr[i + 1];
      const k = (rt - a.t) / (b.t - a.t || 1);
      const lerp = (x, y) => x + (y - x) * k;
      const prevBoxes = new Map(a.boxes.map(bx => [bx.id, bx]));
      return {
        ...b,
        q: b.q.map((v, j) => lerp(a.q[j], v)),
        gap: lerp(a.gap, b.gap),
        cam: lerp(a.cam, b.cam),
        boxes: b.boxes.map(bx => {
          const p = prevBoxes.get(bx.id);
          if (!p || p.s !== bx.s) return bx;
          return { ...bx, x: lerp(p.x, bx.x), y: lerp(p.y, bx.y) };
        }),
      };
    }

    // ---------- Drawing helpers (world units: mm, y up) ----------
    fk(q) {
      const { shoulder: S, L1, L2 } = this.G.robot;
      const E = { x: S.x + L1 * Math.cos(q[0]), y: S.y + L1 * Math.sin(q[0]) };
      const W = { x: E.x + L2 * Math.cos(q[0] + q[1]), y: E.y + L2 * Math.sin(q[0] + q[1]) };
      return { S, E, W };
    }

    text(str, x, y, { size = 46, color = C.muted, align = 'center', weight = 600 } = {}) {
      const c = this.ctx;
      c.save();
      c.translate(x, y);
      c.scale(1, -1);
      c.font = `${weight} ${size * this.ui}px Barlow, "Segoe UI", sans-serif`;
      c.fillStyle = color;
      c.textAlign = align;
      c.fillText(str, 0, 0);
      c.restore();
    }

    rect(x, y, w, h, fill, stroke, lw = 4) {
      const c = this.ctx;
      if (fill) { c.fillStyle = fill; c.fillRect(x, y, w, h); }
      if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.strokeRect(x, y, w, h); }
    }

    rrect(x, y, w, h, r, fill, stroke, lw = 4) {
      const c = this.ctx;
      c.beginPath();
      c.roundRect(x, y, w, h, r);
      if (fill) { c.fillStyle = fill; c.fill(); }
      if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
    }

    circle(x, y, r, fill, stroke, lw = 4) {
      const c = this.ctx;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      if (fill) { c.fillStyle = fill; c.fill(); }
      if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
    }

    vgrad(y0, y1, top, bottom) {
      const g = this.ctx.createLinearGradient(0, y1, 0, y0);
      g.addColorStop(0, top);
      g.addColorStop(1, bottom);
      return g;
    }

    // ---------- Frame ----------
    draw(f) {
      const { ctx: c, G } = this;
      const v = G.view;
      const s = this.canvas.width / (v.x1 - v.x0);
      // Labels stay readable on small screens: grow them when the drawing shrinks
      this.ui = Math.min(2, Math.max(1, 0.26 / (s / this.dpr)));
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.canvas.width, this.canvas.height);
      c.setTransform(s, 0, 0, -s, -v.x0 * s, v.y1 * s);

      this.background(f);
      this.cameraFrame();
      this.infeed();
      this.outfeed();
      this.robotBase();

      const boxes = f ? f.boxes : [];
      for (const b of boxes) if (b.s === 'in' || b.s === 'out' || b.s === 'fall') this.box(b);

      this.bin(f ? f.bin : 0);
      this.packer(f ? f.caseFill : 0);
      this.cameraHead(f ? f.cam : 0);

      if (f) this.robotArm(f, boxes.find(b => b.s === 'held'));

      for (const b of boxes) if ((b.s === 'in' || b.s === 'out') && b.qc) this.badge(b);
      this.labels();
      if (f && f.person) this.person();
    }

    background(f) {
      const { G } = this;
      const v = G.view;
      this.rect(v.x0, 0, v.x1 - v.x0, v.y1, this.vgrad(0, v.y1, C.wallTop, C.wallBottom));
      const c = this.ctx;
      c.strokeStyle = C.grid;
      c.lineWidth = 3;
      c.beginPath();
      for (let x = 200; x < v.x1; x += 200) { c.moveTo(x, 0); c.lineTo(x, v.y1); }
      for (let y = 200; y < v.y1; y += 200) { c.moveTo(v.x0, y); c.lineTo(v.x1, y); }
      c.stroke();

      // Floor
      this.rect(v.x0, v.y0, v.x1 - v.x0, -v.y0, C.floor);
      this.rect(v.x0, -4, v.x1 - v.x0, 8, C.floorEdge);

      // Robot area: hatched floor marking and boundary lines
      const z = G.zone;
      const alert = f && f.person;
      c.save();
      c.beginPath();
      c.rect(z.x0, -40, z.x1 - z.x0, 34);
      c.clip();
      this.rect(z.x0, -40, z.x1 - z.x0, 34, '#1b1b1b');
      c.fillStyle = alert ? C.bad : C.yellow;
      for (let x = z.x0 - 40; x < z.x1; x += 70) {
        c.beginPath();
        c.moveTo(x, -40); c.lineTo(x + 34, -40); c.lineTo(x + 68, -6); c.lineTo(x + 34, -6);
        c.fill();
      }
      c.restore();

      if (alert) this.rect(z.x0, 0, z.x1 - z.x0, 2060, 'rgba(240,96,93,0.12)');
      c.save();
      c.setLineDash([30, 22]);
      c.strokeStyle = alert ? C.bad : 'rgba(242,194,48,0.35)';
      c.lineWidth = alert ? 8 : 5;
      c.beginPath();
      c.moveTo(z.x0, 0); c.lineTo(z.x0, 2060);
      c.moveTo(z.x1, 0); c.lineTo(z.x1, 2060);
      c.stroke();
      c.restore();
      this.text('Robot area', z.x0 + 24, 2000, { align: 'left', size: 40, color: alert ? C.bad : 'rgba(242,194,48,0.7)' });
    }

    leg(x, top) {
      this.rect(x - 20, 0, 40, top, C.yellow);
      this.rect(x - 20, 0, 8, top, 'rgba(255,255,255,0.12)');
      this.rect(x - 46, 0, 92, 16, C.yellowDark);
    }

    infeed() {
      const { G, ctx: c } = this;
      const { x0, x1 } = G.infeed;
      const top = G.beltTop;
      [140, 700, 1300].forEach(x => this.leg(x, top - 80));
      this.rect(140, 230, 1160, 18, C.steelDark);
      this.rect(x0, top - 84, x1 - x0, 44, this.vgrad(top - 84, top - 40, C.steelLight, C.steelDark));

      // Rubber belt with moving texture so you can see it run
      c.save();
      c.beginPath();
      c.roundRect(x0 - 40, top - 38, x1 - x0 + 40, 38, [0, 19, 19, 0]);
      c.fillStyle = C.belt;
      c.fill();
      c.clip();
      c.fillStyle = C.beltMark;
      const off = this.beltIn % 110;
      for (let x = x0 - 110 + off; x < x1; x += 110) c.fillRect(x, top - 26, 46, 10);
      c.restore();

      // Drive drum
      const dx = x1 - 22, dy = top - 19;
      this.circle(dx, dy, 13, C.steelLight, C.steelDark, 3);
      const a = -this.beltIn / 13;
      c.strokeStyle = C.steelDark;
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(dx, dy);
      c.lineTo(dx + Math.cos(a) * 11, dy + Math.sin(a) * 11);
      c.stroke();
    }

    outfeed() {
      const { G, ctx: c } = this;
      const { x0, x1 } = G.outfeed;
      const top = G.beltTop;
      [2330, 2700].forEach(x => this.leg(x, top - 90));
      this.rect(x0, top - 92, x1 - x0, 46, this.vgrad(top - 92, top - 46, C.steelLight, C.steelDark));

      // Rollers turn with the belt speed
      const r = 24;
      const a = -this.beltOut / r;
      for (let x = x0 + 34; x < x1; x += 68) {
        const g = c.createRadialGradient(x - 8, top - r + 8, 2, x, top - r, r);
        g.addColorStop(0, C.steelLight);
        g.addColorStop(1, C.steelDark);
        this.circle(x, top - r, r, g, '#47515c', 3);
        c.strokeStyle = 'rgba(30,36,43,0.8)';
        c.lineWidth = 4;
        c.beginPath();
        c.moveTo(x - Math.cos(a) * 17, top - r - Math.sin(a) * 17);
        c.lineTo(x + Math.cos(a) * 17, top - r + Math.sin(a) * 17);
        c.stroke();
      }
    }

    cameraFrame() {
      const { G } = this;
      const x = G.camera.x;
      const top = G.beltTop;
      this.rect(x - 250, top - 80, 34, 1560 - top, C.steelDark);
      this.rect(x + 216, top - 80, 34, 1560 - top, C.steelDark);
      this.rect(x - 280, 1480, 560, 52, this.vgrad(1480, 1532, C.steelLight, C.steel));

      // Height limit the camera checks against
      const c = this.ctx;
      const limit = top + G.camera.maxHeight;
      c.save();
      c.setLineDash([22, 14]);
      c.strokeStyle = 'rgba(195,204,212,0.55)';
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(x - 216, limit);
      c.lineTo(x + 216, limit);
      c.stroke();
      c.restore();
      this.text('Max height', x - 262, limit - 14, { align: 'right', size: 36 });
    }

    cameraHead(flash) {
      const { G, ctx: c } = this;
      const x = G.camera.x;
      if (flash > 0) {
        c.beginPath();
        c.moveTo(x - 26, 1300); c.lineTo(x + 26, 1300);
        c.lineTo(x + 210, G.beltTop); c.lineTo(x - 210, G.beltTop);
        c.closePath();
        c.fillStyle = `rgba(60,196,174,${0.3 * flash})`;
        c.fill();
      }
      this.rrect(x - 75, 1330, 150, 150, 14, C.graphite, C.graphiteDark, 5);
      this.rect(x - 32, 1296, 64, 36, C.graphiteDark);
      this.circle(x, 1300, 18, '#0b0f13');
      this.circle(x + 44, 1440, 12, flash > 0.1 ? '#b8fff3' : C.ok);
    }

    bin(count) {
      const { G, ctx: c } = this;
      const { x0, x1, h, capacity } = G.bin;
      c.beginPath();
      c.moveTo(x0, 0); c.lineTo(x1, 0); c.lineTo(x1 + 18, h); c.lineTo(x0 - 18, h);
      c.closePath();
      c.fillStyle = this.vgrad(0, h, C.binRim, C.binBody);
      c.fill();
      this.rect(x0 - 30, h - 22, x1 - x0 + 60, 28, C.binRim);

      // See-through window shows how full the bin is
      const wx = x0 + 40, ww = x1 - x0 - 80, wy = 40, wh = h - 170;
      this.rrect(wx, wy, ww, wh, 10, C.binWindow);
      const level = Math.min(1, count / capacity);
      if (level > 0) this.rrect(wx + 6, wy + 6, ww - 12, (wh - 12) * level, 6, count >= capacity ? C.yellow : C.kraft);
      this.text('Reject', (x0 + x1) / 2, h - 105, { size: 44, color: C.text });
    }

    packer(fill) {
      const { G } = this;
      const { x0, x1, h, caseSize } = G.packer;
      this.rect(x0, 0, x1 - x0, h, this.vgrad(0, h, '#33414f', C.packer));
      this.rect(x0, 0, 10, h, C.packerEdge);
      this.rect(x0, G.beltTop - 20, 70, 430, C.tunnel);
      this.rect(x0, h - 16, x1 - x0, 16, C.packerEdge);
      // Slots fill up as boxes go into the current shipping case
      const size = 40, gap = 10;
      const total = caseSize * size + (caseSize - 1) * gap;
      const sx = (x0 + 70 + x1) / 2 - total / 2;
      for (let i = 0; i < caseSize; i++) {
        this.rrect(sx + i * (size + gap), h - 270, size, size, 6, i < fill ? C.kraft : null, i < fill ? null : C.steel, 4);
      }
    }

    robotBase() {
      const { G } = this;
      const { x, pedestal, shoulder: S } = G.robot;
      this.rect(x - 130, 0, 260, pedestal, this.vgrad(0, pedestal, '#434d58', C.graphiteDark));
      this.rect(x - 155, pedestal - 22, 310, 24, C.graphiteDark);
      this.rrect(x - 60, 230, 120, 70, 6, C.graphiteDark, C.steelDark, 3);
      this.rrect(x - 152, pedestal, 304, 140, 28, this.vgrad(pedestal, pedestal + 140, C.ivoryLight, C.ivoryShade), C.ivoryEdge, 5);
      this.rect(x - 140, pedestal + 68, 280, 4, C.ivoryEdge);
      this.rrect(x - 112, pedestal + 120, 224, S.y - pedestal - 110, 30, this.vgrad(pedestal + 120, S.y, C.ivory, C.ivoryShade), C.ivoryEdge, 5);
    }

    link(a, b, width, stripe) {
      const c = this.ctx;
      c.lineCap = 'round';
      c.strokeStyle = C.ivoryEdge;
      c.lineWidth = width + 10;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();

      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L, ny = dx / L;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const g = c.createLinearGradient(mx + nx * width / 2, my + ny * width / 2, mx - nx * width / 2, my - ny * width / 2);
      g.addColorStop(0, C.ivoryLight);
      g.addColorStop(0.5, C.ivory);
      g.addColorStop(1, C.ivoryShade);
      c.strokeStyle = g;
      c.lineWidth = width;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();

      if (stripe) {
        const o = width * 0.2;
        c.strokeStyle = C.stripe;
        c.lineWidth = 14;
        c.beginPath();
        c.moveTo(a.x + dx * 0.22 + nx * o, a.y + dy * 0.22 + ny * o);
        c.lineTo(a.x + dx * 0.8 + nx * o, a.y + dy * 0.8 + ny * o);
        c.stroke();
      }
      c.lineCap = 'butt';
    }

    joint(p, r) {
      const g = this.ctx.createRadialGradient(p.x - r * 0.3, p.y + r * 0.3, r * 0.1, p.x, p.y, r);
      g.addColorStop(0, C.ivoryLight);
      g.addColorStop(1, C.ivoryShade);
      this.circle(p.x, p.y, r, g, C.ivoryEdge, 5);
      this.circle(p.x, p.y, r * 0.48, '#dcd6c9', C.ivoryEdge, 3);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        this.circle(p.x + Math.cos(a) * r * 0.72, p.y + Math.sin(a) * r * 0.72, r * 0.06, C.ivoryEdge);
      }
    }

    robotArm(f, held) {
      const { G } = this;
      const { S, E, W } = this.fk(f.q);
      const tcp = W.y - G.robot.tcp;
      const gap = f.gap;

      this.link(S, E, 190);
      this.joint(S, 122);
      this.link(E, W, 140, true);
      this.joint(E, 100);

      // Flange and gripper (always pointing down)
      this.rect(W.x - 46, tcp + 40, 92, W.y - tcp - 40, C.graphite);
      this.joint(W, 66);
      this.rrect(W.x - 80, tcp + 22, 160, 46, 8, '#d9dbda', '#8e959a', 4);
      this.rrect(W.x - G.robot.openGap - 42, tcp, (G.robot.openGap + 42) * 2, 26, 6, '#c3c7c9', '#8e959a', 4);

      if (held) this.box({ ...held, x: W.x, y: tcp - 10 - held.h });

      for (const side of [-1, 1]) {
        const fx = side < 0 ? W.x - gap - 34 : W.x + gap;
        this.rrect(fx, tcp - 150, 34, 166, 4, '#e8eae9', '#8e959a', 4);
        this.rect(fx, tcp - 150, 34, 34, C.graphite);
      }
    }

    box(b) {
      const c = this.ctx;
      const l = b.x - b.w / 2, r = b.x + b.w / 2, top = b.y + b.h;

      c.beginPath();
      if (b.d === 'dent') {
        c.moveTo(l, b.y); c.lineTo(r, b.y); c.lineTo(r, top - 75); c.lineTo(r - 50, top - 30); c.lineTo(r - 92, top); c.lineTo(l, top);
      } else {
        c.rect(l, b.y, b.w, b.h);
      }
      c.closePath();
      c.fillStyle = this.vgrad(b.y, top, C.kraftLight, C.kraft);
      c.fill();
      c.strokeStyle = C.kraftDark;
      c.lineWidth = 5;
      c.stroke();

      if (b.d === 'flap') {
        this.rect(l + 6, top - 12, b.w - 12, 12, '#5d3f20');
        const len = b.w * 0.42;
        for (const [px, ang] of [[l, 2.05], [r, 1.09]]) {
          c.save();
          c.translate(px, top);
          c.rotate(ang);
          this.rect(0, -12, len, 24, C.kraftLight, C.kraftDark, 4);
          c.restore();
        }
      } else {
        c.strokeStyle = 'rgba(134,89,46,0.6)';
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(l + 4, top - 30); c.lineTo(b.d === 'dent' ? r - 58 : r - 4, top - 30);
        c.stroke();
        if (b.d !== 'dent') this.rect(b.x - 22, top - 64, 44, 64, C.tape);
      }

      if (b.d !== 'label') {
        const lw = b.w * 0.4, lh = Math.min(70, b.h * 0.32);
        const lx = l + b.w * 0.1, ly = b.y + b.h * 0.18;
        this.rect(lx, ly, lw, lh, C.label);
        c.fillStyle = '#2a2a2a';
        for (let i = 0; i < 7; i++) c.fillRect(lx + 8 + i * (lw - 16) / 7, ly + 8, i % 3 === 0 ? 6 : 3, lh - 16);
      }
    }

    badge(b) {
      const c = this.ctx;
      const top = b.y + b.h + (b.d === 'flap' ? 130 : 0);
      const cx = b.x, cy = top + 66;
      const pass = b.qc === 'pass';
      this.circle(cx, cy, 38, pass ? C.ok : C.bad, '#141a20', 6);
      c.strokeStyle = '#141a20';
      c.lineWidth = 10;
      c.lineCap = 'round';
      c.beginPath();
      if (pass) { c.moveTo(cx - 17, cy); c.lineTo(cx - 4, cy - 14); c.lineTo(cx + 18, cy + 13); }
      else { c.moveTo(cx - 13, cy - 13); c.lineTo(cx + 13, cy + 13); c.moveTo(cx + 13, cy - 13); c.lineTo(cx - 13, cy + 13); }
      c.stroke();
      c.lineCap = 'butt';
      if (!pass && b.d) this.text(DEFECTS[b.d], cx, cy + 62, { size: 38, color: '#ffb3b1' });
    }

    labels() {
      const { G } = this;
      const y = -82;
      this.text('Infeed belt', 340, y);
      this.text('Packing line', 2560, y);
      this.text('Vision camera', G.camera.x, 1560);
      this.text('R1', G.robot.x, 250, { size: 40, color: C.text });
      this.text('Reject bin', (G.bin.x0 + G.bin.x1) / 2, y);
      this.text(this.ui > 1.4 ? 'Packer' : 'Case packer', (G.packer.x0 + 70 + G.packer.x1) / 2, G.packer.h - 130, { color: C.text, size: 40 });
    }

    person() {
      const x = 2040; // standing inside the robot area, in front of the reject bin
      this.rect(x - 70, 0, 56, 900, '#3b4651');
      this.rect(x + 14, 0, 56, 900, '#3b4651');
      this.rrect(x - 120, 880, 240, 560, 60, '#e8b923', '#9a7a12', 5);
      this.rect(x - 120, 1080, 240, 30, '#f5f0dc');
      this.rrect(x - 160, 960, 44, 420, 20, '#e8b923', '#9a7a12', 4);
      this.rrect(x + 116, 960, 44, 420, 20, '#e8b923', '#9a7a12', 4);
      this.circle(x, 1560, 80, '#cbb59b', '#8a7660', 4);
      const c = this.ctx;
      c.beginPath();
      c.arc(x, 1590, 92, 0, Math.PI);
      c.fillStyle = '#f2f2ee';
      c.fill();
      this.rect(x - 110, 1584, 220, 18, '#d9d9d2');
    }
  }

  window.CellView = CellView;
})();
