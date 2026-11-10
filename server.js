// HMI/SCADA server for the simulated robot QC cell
// - Runs the cell simulation (sim/cell.js) like a PLC would run a real machine
// - Streams robot and box positions to the browser 20 times a second ("frame")
// - Sends counters, KPIs and alarms twice a second ("status")
// - Receives operator commands (start, stop, emergency stop, reset, ...)

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Cell, G } = require('./sim/cell');

const PORT = process.env.PORT || 3000;
const TICK_MS = 50;            // 20 Hz simulation and frame rate
const STATUS_EVERY = 10;       // status every 10 ticks = 2 Hz

const cell = new Cell();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/sim', express.static(path.join(__dirname, 'sim'))); // the page loads ../sim/cell.js for its no-server fallback
app.get('/api/status', (req, res) => res.json(cell.status()));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(text);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'layout', layout: G }));
  ws.send(JSON.stringify(cell.status()));
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'command') {
        cell.command(msg);
        broadcast(cell.status()); // answer right away so buttons feel instant
      }
    } catch (err) {
      console.warn('Bad message from client:', err.message);
    }
  });
});

let last = performance.now();
let tick = 0;
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  cell.update(dt);
  broadcast(cell.frame());
  if (++tick % STATUS_EVERY === 0) broadcast(cell.status());
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`Robot cell HMI running at http://localhost:${PORT}`);
});
