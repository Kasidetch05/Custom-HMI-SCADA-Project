// Robot pick-and-place QC cell simulation.
//
// Everything is in millimetres and seconds, seen from the side:
// x grows to the right, y grows upward, the floor is y = 0.
//
//   infeed belt ──► vision QC camera ──► pick point ──► robot ──┬─► packing line ──► case packer
//                                                               └─► reject bin
//
// The server owns this simulation (like a PLC owns a real machine).
// Browsers only draw what it sends them.

(function () {
  'use strict';

  const G = {
    view: { x0: 0, x1: 3400, y0: -110, y1: 2140 },
    beltTop: 700,
    infeed: { x0: 0, x1: 1420 },
    outfeed: { x0: 2250, x1: 3060 },
    packer: { x0: 2960, x1: 3400, h: 1260, caseSize: 6 },
    camera: { x: 700, maxHeight: 290 },
    pickX: 1270,
    placeX: 2420,
    bin: { x0: 1850, x1: 2170, h: 430, capacity: 8 },
    zone: { x0: 1440, x1: 2205 },
    robot: { x: 1650, pedestal: 560, shoulder: { x: 1650, y: 830 }, L1: 650, L2: 600, tcp: 100, openGap: 172 },
  };

  const BOX_TYPES = [
    { size: 'S', w: 220, h: 180 },
    { size: 'M', w: 260, h: 215 },
    { size: 'L', w: 300, h: 250 },
  ];

  const DEFECTS = {
    flap:  'Open flap',
    label: 'Missing label',
    dent:  'Dented corner',
    size:  'Wrong size',
  };

  const ALARMS = {
    ESTOP:    { level: 'alarm',   text: 'Emergency stop pressed',          help: 'Check that everyone is clear of the cell, then press Reset.' },
    CURTAIN:  { level: 'alarm',   text: 'Someone entered the robot area',  help: 'The robot stopped to keep them safe. Wait until the area is clear, then press Reset.' },
    JAM:      { level: 'alarm',   text: 'Infeed belt jammed',              help: 'Remove the stuck box from the belt, then press Reset.' },
    BIN_FULL: { level: 'warning', text: 'Reject bin is full',              help: 'Empty the reject bin. The robot holds rejected boxes until you do.' },
    HOT:      { level: 'warning', text: 'Robot joint running hot',         help: 'Lower the line speed so the robot can cool down.' },
    REJECTS:  { level: 'warning', text: 'High reject rate',                help: 'More than 3 of the last 10 boxes failed inspection. Check the machine that packs boxes before this cell.' },
  };

  // Tuning at 100 % line speed
  const BELT_SPEED = 260;   // mm/s
  const SPAWN_EVERY = 5.2;  // s between boxes (also the ideal cycle time)
  const JOINT_SPEED = 2.4;  // rad/s
  const LINE_SPEED = 800;   // mm/s for straight up/down moves
  const GRIP_TIME = 0.3;    // s
  const GRAVITY = 6000;     // mm/s², softened so falling boxes are visible
  const HOT_LIMIT = 57;     // °C
  const BUCKET_S = 30;      // chart bucket length

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10); // smootherstep: gentle start and stop
  const r1 = (v) => Math.round(v * 10) / 10;

  // ---------- Kinematics (2-link planar arm, gripper always pointing down) ----------
  function ik(wx, wy) {
    const { shoulder: S, L1, L2 } = G.robot;
    let dx = wx - S.x, dy = wy - S.y;
    let d = Math.hypot(dx, dy);
    const maxR = L1 + L2 - 1, minR = Math.abs(L1 - L2) + 1;
    if (d > maxR || d < minR) {
      const k = clamp(d, minR, maxR) / (d || 1);
      dx *= k; dy *= k; d = Math.hypot(dx, dy);
    }
    const c2 = clamp((d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1);
    const q2 = (dx >= 0 ? -1 : 1) * Math.acos(c2); // keep the elbow up on both sides
    const q1 = Math.atan2(dy, dx) - Math.atan2(L2 * Math.sin(q2), L1 + L2 * Math.cos(q2));
    const q3 = -Math.PI / 2 - q1 - q2; // wrist keeps the gripper vertical
    return [q1, q2, q3];
  }

  function wrist(q) {
    const { shoulder: S, L1, L2 } = G.robot;
    return {
      x: S.x + L1 * Math.cos(q[0]) + L2 * Math.cos(q[0] + q[1]),
      y: S.y + L1 * Math.sin(q[0]) + L2 * Math.sin(q[0] + q[1]),
    };
  }

  const READY = [G.pickX, G.beltTop + 660]; // where the robot waits for the next box

  class Cell {
    constructor() {
      this.t = 0;
      this.state = 'stopped'; // stopped | running | stopping | faulted | estop
      this.speed = 1;
      this.badBatch = false;
      this.jam = false;
      this.person = 0; // seconds until the person leaves the robot area
      this.boxes = [];
      this.nextId = 1001;
      this.spawnIn = 0.3;
      this.cam = 0;
      this.beltIn = 0;
      this.beltOut = 0;
      this.bin = 0;
      this.caseFill = 0;
      this.cases = 0;
      this.counts = { inspected: 0, passed: 0, failed: 0, sorted: 0, packed: 0, rejected: 0 };
      this.reasons = { flap: 0, label: 0, dent: 0, size: 0 };
      this.time = { run: 0, down: 0 };
      this.done = [];
      this.cycles = [];
      this.history = [];
      this.bucket = { start: 0, good: 0, rej: 0 };
      this.inspections = [];
      this.events = [];
      this.alarms = new Map();
      this.temps = [30, 31, 30, 29, 29, 28];
      this.loads = [0, 0, 0, 0, 0, 0];
      this.lastResults = [];
      this.robot = { q: ik(...READY), gap: G.robot.openGap, held: null, plan: [], cur: null, text: 'Waiting for the next box', stage: -1, cycleTime: 0 };
      this.log('info', 'Simulator ready. Press Start to run the cell.');
    }

    // ---------- Main update ----------
    update(dt) {
      this.t += dt;
      const moving = this.state === 'running' || this.state === 'stopping';
      if (moving) this.time.run += dt;
      if (this.state === 'faulted' || this.state === 'estop') this.time.down += dt;

      const qBefore = this.robot.q.slice();
      if (moving) this.stepRobot(dt);
      this.moveBoxes(dt);
      this.updateHealth(dt, qBefore);

      if (this.person > 0) {
        this.person -= dt;
        if (this.person <= 0) {
          this.person = 0;
          this.clearAlarm('CURTAIN');
          this.log('info', 'The robot area is clear. Press Reset to continue.');
        }
      }
      this.cam = Math.max(0, this.cam - dt * 2.5);

      if (this.t - this.bucket.start >= BUCKET_S) {
        this.history.push({ t: Date.now(), good: this.bucket.good, rej: this.bucket.rej });
        if (this.history.length > 20) this.history.shift();
        this.bucket = { start: this.t, good: 0, rej: 0 };
      }
    }

    // ---------- Conveyors, camera, falling boxes ----------
    moveBoxes(dt) {
      const running = this.state === 'running';
      const vIn = running && !this.jam ? BELT_SPEED * this.speed : 0;
      const vOut = running || this.state === 'stopping' ? BELT_SPEED * this.speed : 0;
      this.beltIn = vIn;
      this.beltOut = vOut;

      // Infeed: boxes queue up behind the box waiting at the pick point
      const infeed = this.boxes.filter(b => b.state === 'in').sort((a, b) => b.x - a.x);
      let edge = Infinity;
      for (const b of infeed) {
        const maxX = Math.min(G.pickX, edge - b.w / 2);
        b.x = Math.min(b.x + vIn * dt, Math.max(b.x, maxX));
        edge = b.x - b.w / 2 - 60;
        if (!b.qc && b.x >= G.camera.x) this.inspect(b);
      }

      // New boxes arrive from the left
      if (vIn > 0) {
        this.spawnIn -= dt * this.speed;
        if (this.spawnIn <= 0) {
          const last = infeed[infeed.length - 1];
          if (!last || last.x - last.w / 2 > -50) {
            this.spawn();
            this.spawnIn = SPAWN_EVERY * (0.8 + Math.random() * 0.4);
          } else {
            this.spawnIn = 0.5; // infeed is backed up, try again shortly
          }
        }
      }

      // Packing line: boxes ride into the case packer
      for (const b of this.boxes) {
        if (b.state === 'out') {
          b.x += vOut * dt;
          if (b.x - b.w / 2 > G.packer.x0 + 40) {
            b.state = 'gone';
            this.counts.packed++;
            this.caseFill++;
            if (this.caseFill >= G.packer.caseSize) {
              this.caseFill = 0;
              this.cases++;
              this.log('info', `Case ${this.cases} packed with ${G.packer.caseSize} boxes`);
            }
          }
        } else if (b.state === 'fall') {
          b.vy -= GRAVITY * dt;
          b.y += b.vy * dt;
          const floor = 40 + (this.bin / G.bin.capacity) * (G.bin.h - 140);
          if (b.y <= floor) {
            b.state = 'gone';
            this.bin++;
            if (this.bin >= G.bin.capacity) this.raise('BIN_FULL');
          }
        }
      }

      // Held box follows the gripper
      const held = this.robot.held;
      if (held) {
        const w = wrist(this.robot.q);
        held.x = w.x;
        held.y = w.y - G.robot.tcp - 10 - held.h;
      }

      this.boxes = this.boxes.filter(b => b.state !== 'gone');
    }

    spawn() {
      const type = BOX_TYPES[Math.floor(Math.random() * BOX_TYPES.length)];
      const defectChance = this.badBatch ? 0.5 : 0.1;
      let defect = null;
      if (Math.random() < defectChance) {
        const keys = Object.keys(DEFECTS);
        defect = keys[Math.floor(Math.random() * keys.length)];
      }
      const box = { id: this.nextId++, size: type.size, w: type.w, h: type.h, x: -200, y: G.beltTop, state: 'in', qc: null, defect, vy: 0 };
      if (defect === 'size') { box.w = 260; box.h = 330; }
      this.boxes.push(box);
    }

    inspect(b) {
      b.qc = b.defect ? 'fail' : 'pass';
      this.cam = 1;
      this.counts.inspected++;
      if (b.qc === 'pass') this.counts.passed++;
      else { this.counts.failed++; this.reasons[b.defect]++; }

      this.inspections.unshift({ id: b.id, time: Date.now(), size: b.size, result: b.qc, defect: b.defect ? DEFECTS[b.defect] : null });
      if (this.inspections.length > 40) this.inspections.pop();
      if (b.qc === 'fail') this.log('warning', `Box #${b.id} failed inspection: ${DEFECTS[b.defect]}`);

      this.lastResults.push(b.qc);
      if (this.lastResults.length > 10) this.lastResults.shift();
      const fails = this.lastResults.filter(r => r === 'fail').length;
      if (fails > 3) this.raise('REJECTS');
      else if (fails <= 1) this.clearAlarm('REJECTS');
    }

    boxAtPick() {
      return this.boxes.find(b => b.state === 'in' && Math.abs(b.x - G.pickX) < 1);
    }

    outfeedClear(box) {
      return this.boxes.every(b => b.state !== 'out' || b.x - b.w / 2 > G.placeX + box.w / 2 + 40);
    }

    binHasRoom() {
      const falling = this.boxes.filter(b => b.state === 'fall').length;
      return this.bin + falling < G.bin.capacity;
    }

    // ---------- Robot ----------
    stepRobot(dt) {
      const r = this.robot;
      r.cycleTime += dt; // only counts while the cell is moving, not while stopped
      if (!r.cur) {
        if (!r.plan.length) this.planNext();
        if (!r.plan.length) return;
        r.cur = r.plan.shift();
        this.beginStep(r.cur);
      }
      const s = r.cur;

      if (s.type === 'wait') {
        if (!s.until()) return;
      } else {
        s.t += dt * this.speed;
        const k = ease(Math.min(1, s.t / s.dur));
        if (s.type === 'joint') r.q = s.q0.map((a, i) => a + (s.q1[i] - a) * k);
        if (s.type === 'line') r.q = ik(s.p0.x + (s.to[0] - s.p0.x) * k, s.p0.y + (s.to[1] - s.p0.y) * k);
        if (s.type === 'grip' || s.type === 'release') r.gap = s.g0 + (s.g1 - s.g0) * k;
        if (s.t < s.dur) return;
      }

      if (s.type === 'grip') {
        s.box.state = 'held';
        r.held = s.box;
      }
      if (s.end) s.end();
      r.cur = null;
    }

    beginStep(s) {
      const r = this.robot;
      s.t = 0;
      if (s.text) r.text = s.text;
      if (s.stage !== undefined) r.stage = s.stage;
      if (s.type === 'joint') {
        s.q0 = r.q.slice();
        s.q1 = ik(...s.to);
        const span = Math.max(...s.q1.map((a, i) => Math.abs(a - s.q0[i])));
        s.dur = Math.max(0.3, span / JOINT_SPEED);
      } else if (s.type === 'line') {
        s.p0 = wrist(r.q);
        s.dur = Math.max(0.2, Math.hypot(s.to[0] - s.p0.x, s.to[1] - s.p0.y) / LINE_SPEED);
      } else if (s.type === 'grip') {
        s.g0 = r.gap;
        s.g1 = s.box.w / 2 + 2;
        s.dur = GRIP_TIME;
      } else if (s.type === 'release') {
        s.g0 = r.gap;
        s.g1 = G.robot.openGap;
        s.dur = GRIP_TIME;
        const box = r.held;
        r.held = null;
        if (box && s.good) {
          box.state = 'out';
          box.x = G.placeX;
          box.y = G.beltTop;
        } else if (box) {
          box.state = 'fall';
          box.vy = 0;
        }
      }
    }

    planNext() {
      const r = this.robot;
      const w = wrist(r.q);
      const atReady = Math.hypot(w.x - READY[0], w.y - READY[1]) < 2;

      if (this.state === 'stopping' && !r.held) {
        if (atReady) {
          this.state = 'stopped';
          this.log('info', 'Cell stopped');
        } else {
          r.plan = [{ type: 'joint', to: READY, stage: -1, text: 'Returning to the ready position' }];
        }
        return;
      }

      const box = this.boxAtPick();
      if (this.state === 'running' && box && box.qc) {
        this.planCycle(box);
      } else if (!atReady) {
        r.plan = [{ type: 'joint', to: READY, stage: -1, text: 'Returning to the ready position' }];
      } else {
        r.text = 'Waiting for the next box';
        r.stage = -1;
      }
    }

    planCycle(box) {
      const r = this.robot;
      const id = `#${box.id}`;
      const top = G.beltTop + box.h;
      const pick = [G.pickX, top + G.robot.tcp + 10];
      const above = [G.pickX, pick[1] + 420];
      r.cycleTime = 0;

      r.plan = [
        { type: 'joint', to: above, stage: 2, text: `Moving to pick box ${id}` },
        { type: 'line', to: pick, stage: 2, text: `Lowering onto box ${id}` },
        { type: 'grip', box, stage: 2, text: `Gripping box ${id}` },
        { type: 'line', to: above, stage: 2, text: `Lifting box ${id}` },
      ];

      if (box.qc === 'pass') {
        const place = [G.placeX, G.beltTop + box.h + G.robot.tcp + 10];
        const placeAbove = [G.placeX, place[1] + 320];
        r.plan.push(
          { type: 'joint', to: placeAbove, stage: 3, text: `Carrying good box ${id} to the packing line` },
          { type: 'wait', until: () => this.outfeedClear(box), stage: 3, text: 'Waiting: the packing line is full' },
          { type: 'line', to: place, stage: 3, text: `Placing box ${id} on the packing line` },
          { type: 'release', good: true, stage: 4, text: `Box ${id} sent to packing`, end: () => this.cycleDone(true) },
          { type: 'line', to: placeAbove, stage: 4, text: `Box ${id} sent to packing` },
        );
      } else {
        const drop = [(G.bin.x0 + G.bin.x1) / 2, Math.max(1180, G.bin.h + 230 + box.h + G.robot.tcp)];
        r.plan.push(
          { type: 'joint', to: drop, stage: 3, text: `Carrying rejected box ${id} to the reject bin` },
          { type: 'wait', until: () => this.binHasRoom(), stage: 3, text: 'Waiting: the reject bin is full' },
          { type: 'release', good: false, stage: 4, text: `Box ${id} dropped in the reject bin`, end: () => this.cycleDone(false) },
        );
      }
    }

    cycleDone(good) {
      this.done.push(this.t);
      this.counts.sorted++;
      this.cycles.push(r1(this.robot.cycleTime));
      if (this.cycles.length > 30) this.cycles.shift();
      if (good) this.bucket.good++;
      else { this.bucket.rej++; this.counts.rejected++; }
    }

    // ---------- Joint temperature & load ----------
    updateHealth(dt, qBefore) {
      if (dt <= 0) return;
      const q = this.robot.q;
      const rate = q.map((a, i) => Math.abs(a - qBefore[i]) / dt);
      const gripping = this.robot.cur && (this.robot.cur.type === 'grip' || this.robot.cur.type === 'release') ? 1 : 0;
      // J1 base, J2 shoulder, J3 elbow, J4 wrist roll, J5 wrist pitch, J6 flange
      const raw = [rate[0] * 0.7, rate[0], rate[1], rate[2] * 0.4, rate[2] * 0.8, gripping * 0.6];
      const weights = [0.8, 1.0, 0.85, 0.6, 0.65, 0.5];
      let hottest = 0;
      for (let i = 0; i < 6; i++) {
        const load = clamp(raw[i] / 2, 0, 1);
        this.loads[i] += (load - this.loads[i]) * Math.min(1, dt / 20);
        const target = 28 + 60 * this.loads[i] * weights[i];
        this.temps[i] += (target - this.temps[i]) * Math.min(1, dt / 45);
        if (this.temps[i] > this.temps[hottest]) hottest = i;
      }
      if (this.temps[hottest] > HOT_LIMIT) this.raise('HOT', `Robot joint J${hottest + 1} running hot`);
      else if (this.temps[hottest] < HOT_LIMIT - 3) this.clearAlarm('HOT');
    }

    // ---------- Alarms & events ----------
    raise(id, text) {
      const a = this.alarms.get(id);
      if (a && a.active) return;
      const def = ALARMS[id];
      this.alarms.set(id, { id, level: def.level, text: text || def.text, help: def.help, since: Date.now(), active: true, acked: false });
      this.log(def.level, text || def.text, id);
    }

    clearAlarm(id) {
      const a = this.alarms.get(id);
      if (!a || !a.active) return;
      a.active = false;
      if (a.acked) this.alarms.delete(id);
    }

    // alarm: the alarm id when this event is an alarm being raised (lets the historian count real alarms)
    log(level, text, alarm = null) {
      this.events.unshift({ time: Date.now(), level, text, alarm });
      if (this.events.length > 100) this.events.pop();
    }

    // ---------- Operator commands ----------
    command({ cmd, value }) {
      switch (cmd) {
        case 'start':
          if (this.state === 'stopped' || this.state === 'stopping') {
            this.state = 'running';
            this.log('info', 'Cell started');
          } else if (this.state === 'faulted' || this.state === 'estop') {
            this.log('info', 'Press Reset before starting');
          }
          break;
        case 'stop':
          if (this.state === 'running') {
            this.state = 'stopping';
            this.log('info', 'Stopping after the current box');
          }
          break;
        case 'estop':
          if (this.state !== 'estop') {
            this.state = 'estop';
            this.raise('ESTOP');
          }
          break;
        case 'reset':
          if (this.state !== 'faulted' && this.state !== 'estop') break;
          if (this.person > 0) {
            this.log('warning', 'Reset refused: someone is still inside the robot area');
            break;
          }
          this.jam = false;
          ['ESTOP', 'JAM', 'CURTAIN'].forEach(id => this.clearAlarm(id));
          this.state = 'stopped';
          this.log('info', 'Reset done. Press Start to run the cell.');
          break;
        case 'speed':
          this.speed = clamp(Number(value) || 100, 25, 150) / 100;
          break;
        case 'emptyBin':
          if (this.bin > 0) this.log('info', `Reject bin emptied (${this.bin} boxes)`);
          this.bin = 0;
          this.clearAlarm('BIN_FULL');
          break;
        case 'fault':
          this.injectFault(value);
          break;
        case 'ack': {
          const ids = value === 'all' ? [...this.alarms.keys()] : [value];
          for (const id of ids) {
            const a = this.alarms.get(id);
            if (!a) continue;
            a.acked = true;
            if (!a.active) this.alarms.delete(id);
          }
          break;
        }
      }
    }

    injectFault(kind) {
      const stop = () => { if (this.state !== 'estop') this.state = 'faulted'; };
      if (kind === 'jam') {
        this.jam = true;
        stop();
        this.raise('JAM');
      } else if (kind === 'person') {
        this.person = 6;
        stop();
        this.raise('CURTAIN');
      } else if (kind === 'fillBin') {
        this.bin = G.bin.capacity;
        this.raise('BIN_FULL');
      } else if (kind === 'badBatch') {
        this.badBatch = !this.badBatch;
        this.log('info', this.badBatch ? 'Practice: a bad batch of boxes is coming' : 'Practice: box quality back to normal');
      }
    }

    // ---------- Data sent to the browser ----------
    frame() {
      const r = this.robot;
      return {
        type: 'frame',
        t: Math.round(this.t * 1000),
        q: r.q.map(a => Math.round(a * 10000) / 10000),
        gap: Math.round(r.gap),
        held: r.held ? r.held.id : null,
        cam: r1(this.cam),
        person: this.person > 0,
        beltIn: this.beltIn,
        beltOut: this.beltOut,
        bin: this.bin,
        caseFill: this.caseFill,
        boxes: this.boxes.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), w: b.w, h: b.h, qc: b.qc, d: b.defect, s: b.state })),
      };
    }

    status() {
      const r = this.robot;
      const recent = this.done.filter(t => this.t - t <= 60).length;
      this.done = this.done.filter(t => this.t - t <= 600);
      const { run, down } = this.time;
      const a = run + down > 0 ? run / (run + down) : 0;
      const p = run > 5 ? Math.min(1, this.counts.sorted * SPAWN_EVERY / run) : 0;
      const q = this.counts.inspected ? this.counts.passed / this.counts.inspected : 0;
      const avg = this.cycles.length ? this.cycles.reduce((s, v) => s + v, 0) / this.cycles.length : 0;

      let stage = r.cur && r.stage >= 0 ? r.stage : -1;
      if (stage < 0) {
        const infeed = this.boxes.filter(b => b.state === 'in');
        if (infeed.some(b => b.qc)) stage = 1;
        else if (infeed.length) stage = 0;
      }
      const focus = r.held || (r.cur && this.boxAtPick()) || this.boxAtPick();

      let text = r.text;
      if (this.state === 'estop') text = 'The emergency stop is active. Everything has stopped.';
      else if (this.state === 'faulted') text = this.person > 0 ? 'Someone is inside the robot area. The robot has stopped.' : this.jam ? 'The infeed belt is jammed.' : 'The robot area is clear again.';
      else if (this.state === 'stopped') text = 'The cell is ready.';

      return {
        type: 'status',
        state: this.state,
        speed: Math.round(this.speed * 100),
        text,
        stage: this.state === 'stopped' ? -1 : stage,
        stageResult: focus ? focus.qc : null,
        person: this.person > 0,
        jam: this.jam,
        badBatch: this.badBatch,
        counts: this.counts,
        reasons: Object.entries(this.reasons).map(([id, n]) => ({ id, text: DEFECTS[id], n })),
        bin: this.bin,
        binCap: G.bin.capacity,
        caseFill: this.caseFill,
        caseSize: G.packer.caseSize,
        cases: this.cases,
        perMinute: recent,
        oee: { a, p, q, oee: a * p * q },
        cycle: { last: this.cycles[this.cycles.length - 1] || 0, avg: r1(avg) },
        cycles: this.cycles,
        temps: this.temps.map(r1),
        loads: this.loads.map(v => Math.round(v * 100)),
        hotLimit: HOT_LIMIT,
        joints: r.q.map(v => Math.round((((v * 180 / Math.PI) % 360) + 540) % 360 - 180)),
        gripper: r.held ? `Holding box #${r.held.id}` : r.gap < G.robot.openGap - 5 ? 'Closing' : 'Open',
        history: this.history,
        bucket: { good: this.bucket.good, rej: this.bucket.rej },
        inspections: this.inspections,
        events: this.events.slice(0, 60),
        alarms: [...this.alarms.values()].sort((x, y) => y.since - x.since),
      };
    }
  }

  // Node (server.js) uses require(); a plain <script> tag gets window.CellSim
  if (typeof module !== 'undefined' && module.exports) module.exports = { Cell, G };
  else window.CellSim = { Cell, G };
})();
