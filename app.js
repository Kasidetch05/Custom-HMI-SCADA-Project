// HMI client: talks to the simulator over WebSocket, draws the cell, fills in the dashboard,
// and sends operator commands back.

(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const cellView = new CellView($('#cellCanvas'));

  let ws = null;
  let everConnected = false;
  let local = null; // the in-browser simulator, used only when there is no server
  let status = null;
  let eventFilter = 'all';

  // ---------- Connection ----------
  // Normal mode: the Node server runs the simulation and streams it here.
  // No server (index.html opened directly, or another dev server): run the same
  // simulation inside this page instead, so the dashboard still works.
  function connect() {
    if (location.protocol === 'file:') return startLocal();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => { everConnected = true; setConnection('on'); };
    ws.onclose = () => {
      if (!everConnected) return startLocal();
      setConnection('off');
      setTimeout(connect, 2000);
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
  }

  function handle(msg) {
    if (msg.type === 'frame') cellView.push(msg);
    else if (msg.type === 'layout') cellView.setLayout(msg.layout);
    else if (msg.type === 'status') { status = msg; render(); }
  }

  function startLocal() {
    if (local) return;
    if (!window.CellSim) {
      setConnection('off');
      return;
    }
    local = new window.CellSim.Cell();
    handle({ type: 'layout', layout: window.CellSim.G });
    handle(local.status());
    setConnection('local');
    let last = performance.now();
    let tick = 0;
    setInterval(() => {
      const now = performance.now();
      local.update(Math.min(0.1, (now - last) / 1000));
      last = now;
      handle(local.frame());
      if (++tick % 10 === 0) handle(local.status());
    }, 50);
  }

  const CONNECTION = {
    on: 'Connected to simulator',
    local: 'Simulating in this browser',
    off: 'Reconnecting…',
  };
  function setConnection(mode) {
    const el = $('#conn');
    el.className = 'conn ' + (mode === 'off' ? 'off' : 'on');
    el.lastElementChild.textContent = CONNECTION[mode];
    if (mode === 'off') renderOffline();
  }

  function send(cmd, value) {
    if (local) {
      local.command({ cmd, value });
      handle(local.status());
    } else if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'command', cmd, value }));
    }
  }

  // ---------- Small helpers ----------
  const icon = (id, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const pct = (v) => Math.round(v * 100);
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  function setHTML(el, html) { if (el._html !== html) { el.innerHTML = html; el._html = html; } }
  function setText(el, text) { if (el.textContent !== String(text)) el.textContent = text; }

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---------- Views (hash routing so each page has its own link) ----------
  const VIEWS = ['overview', 'quality', 'robot', 'alarms', 'reports'];
  function showView(focus = true) {
    const name = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
    VIEWS.forEach((v) => ($(`#view-${v}`).hidden = v !== name));
    $$('.nav-item').forEach((a) => (a.dataset.view === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    if (focus) $('#main').focus({ preventScroll: true });
    if (status) render();
    requestAnimationFrame(() => cellView.resize());
    name === 'reports' ? startReports() : stopReports();
  }
  window.addEventListener('hashchange', () => showView(true));

  // ---------- State wording ----------
  const STATES = {
    running:  { title: 'Running',        icon: 'i-play' },
    stopping: { title: 'Stopping',       icon: 'i-stop' },
    stopped:  { title: 'Stopped',        icon: 'i-stop' },
    faulted:  { title: 'Stopped by a fault', icon: 'i-alert' },
    estop:    { title: 'Emergency stop', icon: 'i-alert' },
  };

  function nextAction(s) {
    const active = (id) => s.alarms.some((a) => a.id === id && a.active);
    switch (s.state) {
      case 'stopped': return 'Press Start to run the cell.';
      case 'stopping': return 'Finishing the current box, then stopping.';
      case 'estop': return 'Make sure everyone is clear, then press Reset.';
      case 'faulted':
        if (s.person) return 'Wait until the area is clear, then press Reset.';
        if (s.jam) return 'Clear the stuck box, then press Reset.';
        return 'Press Reset, then Start to carry on.';
      default:
        if (active('BIN_FULL')) return 'Empty the reject bin so the robot can keep sorting.';
        if (active('HOT')) return 'Lower the line speed so the robot can cool down.';
        return '';
    }
  }

  // ---------- Render ----------
  function render() {
    const s = status;
    if (!s) return;
    renderHeader(s);
    renderControl(s);
    renderSteps(s);
    renderKpis(s);
    renderAlarms(s);
    const view = location.hash.slice(1);
    if (view === 'quality') renderQuality(s);
    else if (view === 'robot') renderRobot(s);
    else if (view === 'alarms') renderAlarmView(s);
    else renderThroughput(s);
  }

  function renderHeader(s) {
    const st = STATES[s.state];
    const chip = $('#stateChip');
    chip.dataset.state = s.state;
    setText(chip.lastElementChild, st.title);
  }

  function renderOffline() {
    const chip = $('#stateChip');
    chip.dataset.state = 'faulted';
    setText(chip.lastElementChild, 'Offline');
    const banner = $('#banner');
    banner.dataset.state = 'faulted';
    setText($('#bannerTitle'), 'No connection');
    setText($('#bannerText'), 'The dashboard lost contact with the simulator.');
    setText($('#bannerNext'), 'Check that the server is running (npm start). Reconnecting automatically.');
    $$('[data-cmd], [data-fault]').forEach((b) => (b.disabled = true));
  }

  function renderControl(s) {
    const st = STATES[s.state];
    const banner = $('#banner');
    banner.dataset.state = s.state;
    $('#bannerIcon use').setAttribute('href', `#${st.icon}`);
    setText($('#bannerTitle'), st.title);
    setText($('#bannerText'), s.text);
    setText($('#bannerNext'), nextAction(s));

    const halted = s.state === 'faulted' || s.state === 'estop';
    $('#btnStart').disabled = !(s.state === 'stopped' || s.state === 'stopping');
    $('#btnStop').disabled = s.state !== 'running';
    $('#btnReset').disabled = !halted;
    $('#btnReset').classList.toggle('attention', halted);
    $('#btnEstop').setAttribute('aria-pressed', String(s.state === 'estop'));
    $('#btnEmpty').disabled = s.bin === 0;
    $('#btnEmpty').classList.toggle('attention', s.bin >= s.binCap);
    $$('[data-fault]').forEach((b) => (b.disabled = false));

    const speed = $('#speed');
    if (document.activeElement !== speed) {
      speed.value = s.speed;
      setText($('#speedOut'), `${s.speed}%`);
    }

    setText($('#binText'), `${s.bin} of ${s.binCap}`);
    $('#binMeter').style.width = `${(s.bin / s.binCap) * 100}%`;
    $('#binMeter').parentElement.classList.toggle('full', s.bin >= s.binCap);
    setText($('#caseNo'), s.cases + 1);
    setText($('#caseText'), `${s.caseFill} of ${s.caseSize}`);
    setHTML($('#caseSlots'), Array.from({ length: s.caseSize }, (_, i) => `<i class="${i < s.caseFill ? 'on' : ''}"></i>`).join(''));

    const batch = $('#btnBatch');
    batch.setAttribute('aria-pressed', String(s.badBatch));
    setText($('#batchText'), s.badBatch ? 'Stop the bad batch' : 'Send a bad batch');

    // Overlay on the live drawing
    const veil = $('#stopVeil');
    veil.hidden = !halted;
    if (halted) setText($('#stopVeilText'), s.state === 'estop' ? 'Emergency stop: everything has stopped' : s.text);
    const live = $('#liveTag');
    live.classList.toggle('paused', s.state !== 'running');
    setText(live.lastChild, s.state === 'running' ? 'Live simulation' : 'Simulation paused');
  }

  function renderSteps(s) {
    const reject = s.stageResult === 'fail';
    setText($('#step5Name'), reject && s.stage >= 3 ? 'Reject' : 'Pack');
    setText($('#step5Text'), reject && s.stage >= 3 ? 'Box drops into the reject bin' : 'Box goes into a shipping case');
    $$('#steps li').forEach((li, i) => {
      const on = i === s.stage;
      li.classList.toggle('active', on);
      li.classList.toggle('reject', on && reject && i >= 3);
      on ? li.setAttribute('aria-current', 'step') : li.removeAttribute('aria-current');
    });
  }

  function renderKpis(s) {
    const c = s.counts;
    setText($('#kPacked'), c.packed);
    setText($('#kCases'), `${s.cases} ${s.cases === 1 ? 'case' : 'cases'} shipped`);
    setText($('#kRejected'), c.rejected);
    setText($('#kInspected'), `${c.inspected} inspected`);
    setText($('#kYield'), c.inspected ? pct(c.passed / c.inspected) : '–');
    setText($('#kRate'), s.perMinute);
    setText($('#kCycle'), s.cycle.avg ? `Cycle time ${s.cycle.avg.toFixed(1)} s` : 'Cycle time –');
    const hasData = c.inspected > 0;
    setText($('#kOee'), hasData ? pct(s.oee.oee) : '–');
    setText($('#kOeeA'), hasData ? `${pct(s.oee.a)}%` : '–');
    setText($('#kOeeP'), hasData ? `${pct(s.oee.p)}%` : '–');
    setText($('#kOeeQ'), hasData ? `${pct(s.oee.q)}%` : '–');
    $('#oeeRing').style.strokeDashoffset = 169.6 * (1 - (hasData ? s.oee.oee : 0));
  }

  function alarmItem(a, big = false) {
    const state = a.active ? (a.acked ? 'Active, acknowledged' : 'Active') : 'Cleared, waiting for acknowledgement';
    return `<li class="alarm-item ${a.level} ${a.acked ? 'acked' : 'unacked'} ${a.active ? 'active' : 'cleared'}">
      ${icon('i-alert')}
      <div>
        <strong>${esc(a.text)}</strong>
        <p>${esc(a.help)}</p>
        <span class="when">${a.level === 'alarm' ? 'Alarm' : 'Warning'}, since ${time(a.since)}${big ? `. ${state}.` : ''}</span>
      </div>
      ${a.acked ? '' : `<button class="btn sm" data-ack="${a.id}">Acknowledge</button>`}
    </li>`;
  }

  function renderAlarms(s) {
    const list = s.alarms;
    const html = list.length
      ? list.map((a) => alarmItem(a)).join('')
      : `<li class="alarm-ok">${icon('i-check')}No active alarms. Everything is working normally.</li>`;
    setHTML($('#alarmListMini'), html);

    const badge = $('#navBadge');
    const unacked = list.filter((a) => !a.acked || a.active);
    badge.hidden = unacked.length === 0;
    setText(badge, unacked.length);
    badge.classList.toggle('warn', !unacked.some((a) => a.level === 'alarm'));
    badge.setAttribute('aria-label', `${unacked.length} alarms`);
  }

  function renderAlarmView(s) {
    setHTML($('#alarmCards'), s.alarms.length
      ? s.alarms.map((a) => alarmItem(a, true)).join('')
      : `<li class="panel alarm-ok">${icon('i-check')}No active alarms. Everything is working normally.</li>`);
    $('#ackAll').disabled = !s.alarms.some((a) => !a.acked);

    const LEVEL = { alarm: ['Alarm', 'i-alert'], warning: ['Warning', 'i-alert'], info: ['Info', 'i-info'] };
    const rows = s.events
      .filter((e) => eventFilter === 'all' || e.level !== 'info')
      .map((e) => `<tr><td>${time(e.time)}</td><td><span class="lvl ${e.level}">${icon(LEVEL[e.level][1], 'sm')}${LEVEL[e.level][0]}</span></td><td>${esc(e.text)}</td></tr>`)
      .join('');
    setHTML($('#eventBody'), rows || '<tr><td colspan="3" class="muted">Nothing to show yet.</td></tr>');
  }

  function renderQuality(s) {
    const c = s.counts;
    setText($('#qYield'), c.inspected ? pct(c.passed / c.inspected) : '–');
    setText($('#qSummary'), c.inspected
      ? `${c.passed} of ${c.inspected} boxes passed inspection. ${c.failed} ${c.failed === 1 ? 'was' : 'were'} rejected.`
      : 'No boxes inspected yet. Start the cell to begin.');
    setText($('#qPass'), c.passed);
    setText($('#qFail'), c.failed);
    $('#qBarGood').style.width = c.inspected ? `${(c.passed / c.inspected) * 100}%` : '0';
    $('#qBarRej').style.width = c.inspected ? `${(c.failed / c.inspected) * 100}%` : '0';

    const reasons = [...s.reasons].sort((a, b) => b.n - a.n);
    const max = Math.max(1, ...reasons.map((r) => r.n));
    setHTML($('#reasons'), reasons.map((r) => `<li><span>${r.text}</span><span class="bar"><i style="width:${(r.n / max) * 100}%"></i></span><b>${r.n}</b></li>`).join(''));

    const SIZE = { S: 'Small', M: 'Medium', L: 'Large' };
    setHTML($('#inspBody'), s.inspections.length
      ? s.inspections.map((i) => `<tr><td>#${i.id}</td><td>${time(i.time)}</td><td>${SIZE[i.size]}</td>
          <td><span class="result ${i.result}">${icon(i.result === 'pass' ? 'i-check' : 'i-x', 'sm')}${i.result === 'pass' ? 'Passed' : 'Rejected'}</span></td>
          <td>${i.defect || '<span class="muted">None</span>'}</td></tr>`).join('')
      : '<tr><td colspan="5" class="muted">Start the cell to inspect boxes.</td></tr>');
  }

  const JOINTS = ['J1 Base', 'J2 Shoulder', 'J3 Elbow', 'J4 Wrist turn', 'J5 Wrist bend', 'J6 Gripper'];
  function renderRobot(s) {
    setText($('#rDoing'), s.text);
    setText($('#rGrip'), s.gripper);
    setText($('#rCycles'), s.counts.sorted);
    setText($('#rAvg'), s.cycle.avg ? `${s.cycle.avg.toFixed(1)} s` : '–');
    setText($('#rSpeed'), `${s.speed}%`);
    setText($('#rJ2'), `${s.joints[0]}°`);
    setText($('#rJ3'), `${s.joints[1]}°`);
    setText($('#rJ5'), `${s.joints[2]}°`);
    setText($('#hotLimit'), s.hotLimit);

    const lo = 20, hi = 80;
    const at = (t) => `${((Math.min(hi, Math.max(lo, t)) - lo) / (hi - lo)) * 100}%`;
    setHTML($('#temps'), s.temps.map((t, i) => {
      const hot = t > s.hotLimit;
      return `<li class="${hot ? 'hot' : ''}"><span class="name">${JOINTS[i]}</span>
        <span class="track"><i style="width:${at(t)}"></i><span class="limit" style="left:${at(s.hotLimit)}"></span></span>
        <span class="val">${hot ? icon('i-thermo', 'sm') : ''}${t.toFixed(1)}°C</span></li>`;
    }).join(''));

    renderCycleChart(s);
  }

  // ---------- Charts ----------
  const css = getComputedStyle(document.documentElement);
  const token = (n) => css.getPropertyValue(n).trim();
  // Chart.js loads from the internet. Without it the dashboard still works, minus the two charts.
  const hasCharts = typeof window.Chart !== 'undefined';
  const NO_CHARTS = 'Charts need an internet connection to load.';
  if (hasCharts) {
    Chart.defaults.color = token('--muted');
    Chart.defaults.font.family = 'Barlow, "Segoe UI", sans-serif';
    Chart.defaults.font.size = 13;
    Chart.defaults.borderColor = token('--line-soft');
  }

  const tooltip = {
    backgroundColor: '#0f1419', borderColor: token('--line'), borderWidth: 1,
    titleColor: token('--text'), bodyColor: token('--text'), padding: 10, boxPadding: 4,
  };

  let throughputChart = null;
  function renderThroughput(s) {
    const hist = s.history;
    if (!hasCharts) return setText($('#throughputEmpty'), NO_CHARTS);
    $('#throughputEmpty').hidden = hist.length > 0;
    const key = hist.length ? hist[hist.length - 1].t : 0;
    if (throughputChart && throughputChart._key === key) return;

    const labels = hist.map((h) => new Date(h.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const panel = token('--panel');
    const bar = { borderColor: panel, borderWidth: 2, borderRadius: 4, borderSkipped: false, barPercentage: 0.7, categoryPercentage: 0.9, maxBarThickness: 40 };
    if (!throughputChart) {
      throughputChart = new Chart($('#throughputChart'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Sent to packing', data: hist.map((h) => h.good), backgroundColor: token('--good-series'), ...bar },
            { label: 'Rejected', data: hist.map((h) => h.rej), backgroundColor: token('--kraft'), ...bar },
          ],
        },
        options: {
          maintainAspectRatio: false,
          animation: { duration: 300 },
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { title: (it) => `30 seconds ending ${it[0].label}` } } },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 6 } },
            y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Boxes per 30 s' } },
          },
        },
      });
    } else {
      throughputChart.data.labels = labels;
      throughputChart.data.datasets[0].data = hist.map((h) => h.good);
      throughputChart.data.datasets[1].data = hist.map((h) => h.rej);
      throughputChart.update();
    }
    throughputChart._key = key;
  }

  // ---------- Reports (from the C# historian service) ----------
  const HISTORIAN = 'http://localhost:5080';
  let reportHours = 8;
  let reportTimer = null;
  let reportChart = null;

  function startReports() {
    loadReport();
    clearInterval(reportTimer);
    reportTimer = setInterval(loadReport, 10000);
  }

  function stopReports() {
    clearInterval(reportTimer);
    reportTimer = null;
  }

  async function loadReport() {
    try {
      const res = await fetch(`${HISTORIAN}/api/report?hours=${reportHours}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Historian answered ${res.status}`);
      renderReport(await res.json());
    } catch {
      $('#histOff').hidden = false;
      $('#histOn').hidden = true;
    }
  }

  const minutes = (m) => (m < 1 ? `${Math.round(m * 60)} s` : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);
  const RANGE = { 1: 'Last hour', 8: 'Last 8 hours', 24: 'Last 24 hours' };

  function renderReport(r) {
    $('#histOff').hidden = true;
    $('#histOn').hidden = false;

    // Warn when the historian can't hear the simulator
    const warn = $('#histWarn');
    warn.hidden = r.simulatorConnected;
    if (!r.simulatorConnected) {
      setText(warn, local
        ? 'This page is running its own simulation, which the historian cannot record. Run npm start and open http://localhost:3000 to record.'
        : 'The historian is running but cannot reach the simulator. Start it with npm start. Nothing new is being recorded.');
    }

    setText($('#rInspected'), r.inspected.toLocaleString());
    setText($('#rRange'), RANGE[reportHours]);
    setText($('#rPassRate'), r.passRate == null ? '–' : pct(r.passRate));
    setText($('#rPassed'), `${r.passed.toLocaleString()} passed`);
    setText($('#rRejected'), r.rejected.toLocaleString());
    setText($('#rTopReason'), r.reasons.length ? `Most often: ${r.reasons[0].reason.toLowerCase()}` : 'No rejects');
    setText($('#rRunning'), minutes(r.time.running));
    setText($('#rFaultTime'), `${minutes(r.time.fault)} stopped by faults`);
    setText($('#rAvail'), r.availability == null ? '–' : pct(r.availability));

    // Where the time went
    const parts = [
      ['t-run', 'Running', r.time.running],
      ['t-stop', 'Stopped by the operator', r.time.stopped],
      ['t-fault', 'Stopped by a fault', r.time.fault],
      ['t-none', 'Not recorded', r.time.noData],
    ];
    const total = parts.reduce((sum, p) => sum + p[2], 0) || 1;
    setHTML($('#timeBar'), parts.filter((p) => p[2] > 0).map(([cls, , m]) => `<i class="${cls}" style="width:${(m / total) * 100}%"></i>`).join(''));
    setHTML($('#timeList'), parts.map(([cls, label, m]) =>
      `<li><i class="sw ${cls}"></i><span>${label}</span><b>${minutes(m)}</b><span class="pct">${Math.round((m / total) * 100)}%</span></li>`).join(''));

    // Reject reasons
    const max = Math.max(1, ...r.reasons.map((x) => x.count));
    setHTML($('#repReasons'), r.reasons.length
      ? r.reasons.map((x) => `<li><span>${esc(x.reason)}</span><span class="bar"><i style="width:${(x.count / max) * 100}%"></i></span><b>${x.count}</b></li>`).join('')
      : `<li class="alarm-ok">${icon('i-check')}No boxes rejected in this time range.</li>`);

    // Alarms
    setHTML($('#repAlarms'), r.topAlarms.length
      ? r.topAlarms.map((a) => `<tr><td><span class="lvl ${a.level}">${icon('i-alert', 'sm')}${esc(a.text)}</span></td><td>${a.count}</td><td>${time(a.lastSeen)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="muted">No alarms in this time range.</td></tr>');

    // Footer
    setText($('#repNote'), r.firstRecord
      ? `Recorded by the C# historian since ${new Date(r.firstRecord).toLocaleString()}. ${r.totalInspections.toLocaleString()} inspections stored.`
      : 'The C# historian is running. Data appears here once the cell inspects its first box.');
    $('#csvLink').href = `${HISTORIAN}/api/export/inspections.csv?hours=${reportHours}`;

    renderReportChart(r);
  }

  function renderReportChart(r) {
    const empty = $('#reportChartEmpty');
    if (!hasCharts) {
      setText(empty, NO_CHARTS);
      empty.hidden = false;
      return;
    }
    empty.hidden = r.inspected > 0;
    setText($('#h-rep-chart'), `Boxes inspected per ${r.bucketMinutes} minutes`);
    const labels = r.production.map((b) => new Date(b.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const passed = r.production.map((b) => b.passed);
    const rejected = r.production.map((b) => b.rejected);
    if (!reportChart) {
      const bar = { borderColor: token('--panel'), borderWidth: 2, borderRadius: 4, borderSkipped: false, barPercentage: 0.8, categoryPercentage: 0.9, maxBarThickness: 40 };
      reportChart = new Chart($('#reportChart'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Passed', data: passed, backgroundColor: token('--good-series'), ...bar },
            { label: 'Rejected', data: rejected, backgroundColor: token('--kraft'), ...bar },
          ],
        },
        options: {
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { title: (it) => `From ${it[0].label}` } } },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } },
            y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Boxes' } },
          },
        },
      });
    } else {
      reportChart.data.labels = labels;
      reportChart.data.datasets[0].data = passed;
      reportChart.data.datasets[1].data = rejected;
      reportChart.update();
    }
  }

  let cycleChart = null;
  function renderCycleChart(s) {
    const data = s.cycles;
    if (!hasCharts) return setText($('#cycleEmpty'), NO_CHARTS);
    $('#cycleEmpty').hidden = data.length > 0;
    const key = `${data.length}-${data[data.length - 1]}-${s.counts.sorted}`;
    if (cycleChart && cycleChart._key === key) return;
    const labels = data.map((_, i) => s.counts.sorted - data.length + i + 1);
    if (!cycleChart) {
      cycleChart = new Chart($('#cycleChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Cycle time', data, borderColor: token('--ok'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 12, tension: 0.25 }] },
        options: {
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { title: (it) => `Box ${it[0].label}`, label: (it) => ` ${it.parsed.y.toFixed(1)} seconds` } } },
          scales: {
            x: { grid: { display: false }, title: { display: true, text: 'Box number' }, ticks: { maxTicksLimit: 8 } },
            y: { beginAtZero: true, title: { display: true, text: 'Seconds' } },
          },
        },
      });
    } else {
      cycleChart.data.labels = labels;
      cycleChart.data.datasets[0].data = data;
      cycleChart.update();
    }
    cycleChart._key = key;
  }

  // ---------- Input ----------
  const FEEDBACK = {
    emptyBin: 'Reject bin emptied',
    person: 'Practice: someone walked into the robot area',
    jam: 'Practice: a box jammed the infeed belt',
    fillBin: 'Practice: the reject bin is now full',
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    if (btn.dataset.cmd) {
      send(btn.dataset.cmd);
      if (FEEDBACK[btn.dataset.cmd]) toast(FEEDBACK[btn.dataset.cmd]);
    } else if (btn.dataset.fault) {
      send('fault', btn.dataset.fault);
      if (FEEDBACK[btn.dataset.fault]) toast(FEEDBACK[btn.dataset.fault]);
    } else if (btn.dataset.ack) {
      send('ack', btn.dataset.ack);
    } else if (btn.id === 'ackAll') {
      send('ack', 'all');
    } else if (btn.dataset.range) {
      reportHours = Number(btn.dataset.range);
      $$('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      loadReport();
    } else if (btn.id === 'printBtn') {
      window.print();
    } else if (btn.dataset.filter) {
      eventFilter = btn.dataset.filter;
      $$('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      if (status) renderAlarmView(status);
    }
  });

  const speed = $('#speed');
  speed.addEventListener('input', () => setText($('#speedOut'), `${speed.value}%`));
  speed.addEventListener('change', () => send('speed', Number(speed.value)));

  setInterval(() => setText($('#clock'), new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), 1000);

  showView(false);
  connect();
})();
