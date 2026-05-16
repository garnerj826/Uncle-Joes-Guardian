// server.js — Uncle Joe's Guardian Backend
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 5 * 1024 * 1024 }); // 5MB for screenshots

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dashboard')));

const students = new Map();
const teachers = new Set();
const screenshots = new Map(); // studentId → latest screenshot dataUrl

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.role = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch(e) { return; }

    if (msg.type === 'STUDENT_CONNECT') {
      ws.role = 'student';
      ws.studentId = msg.studentId;
      students.set(msg.studentId, {
        ws, id: msg.studentId,
        name: msg.studentName || 'Unknown Student',
        isLocked: false, tabs: [], tabCount: 0,
        blockedSites: [], tabLimit: 0, lastSeen: Date.now()
      });
      console.log(`[+] Student: ${msg.studentName}`);
      broadcastToTeachers({ type: 'STUDENT_LIST', students: getStudentList() });

    } else if (msg.type === 'TEACHER_CONNECT') {
      ws.role = 'teacher';
      teachers.add(ws);
      console.log('[+] Teacher connected');
      ws.send(JSON.stringify({ type: 'STUDENT_LIST', students: getStudentList() }));
      // Send all cached screenshots to new teacher
      for (const [id, img] of screenshots.entries()) {
        const s = students.get(id);
        if (s) ws.send(JSON.stringify({ type: 'SCREENSHOT', studentId: id, studentName: s.name, image: img }));
      }

    } else if (msg.type === 'STATUS_UPDATE' && ws.role === 'student') {
      const s = students.get(msg.studentId);
      if (s) {
        Object.assign(s, {
          name: msg.studentName || s.name,
          isLocked: msg.isLocked,
          tabs: msg.tabs || [],
          tabCount: msg.tabCount,
          blockedSites: msg.blockedSites || [],
          tabLimit: msg.tabLimit || 0,
          lastSeen: Date.now()
        });
      }
      broadcastToTeachers({ type: 'STUDENT_UPDATE', student: getStudentData(msg.studentId) });

    } else if (msg.type === 'SCREENSHOT' && ws.role === 'student') {
      // Cache and relay screenshot to all teachers
      screenshots.set(msg.studentId, msg.image);
      const payload = JSON.stringify({ type: 'SCREENSHOT', studentId: msg.studentId, studentName: msg.studentName, image: msg.image, tabTitle: msg.tabTitle, tabUrl: msg.tabUrl });
      for (const t of teachers) {
        if (t.readyState === WebSocket.OPEN) t.send(payload);
      }

    } else if (msg.type === 'TEACHER_COMMAND' && ws.role === 'teacher') {
      handleTeacherCommand(msg);
    }
  });

  ws.on('close', () => {
    if (ws.role === 'student' && ws.studentId) {
      students.delete(ws.studentId);
      screenshots.delete(ws.studentId);
      console.log(`[-] Student disconnected: ${ws.studentId}`);
      broadcastToTeachers({ type: 'STUDENT_LIST', students: getStudentList() });
    } else if (ws.role === 'teacher') {
      teachers.delete(ws);
    }
  });
});

// ── Commands ──────────────────────────────────────────────────────────────────

function handleTeacherCommand(msg) {
  const { command, targetId, payload } = msg;
  const targets = targetId === 'all'
    ? [...students.values()].map(s => s.ws)
    : students.has(targetId) ? [students.get(targetId).ws] : [];

  for (const ws of targets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: command, ...payload }));
  }

  const updateIds = targetId === 'all' ? [...students.keys()] : [targetId];
  for (const id of updateIds) {
    const s = students.get(id);
    if (!s) continue;
    if (command === 'LOCK_SCREEN')   s.isLocked = true;
    if (command === 'UNLOCK_SCREEN') s.isLocked = false;
    if (command === 'SET_TAB_LIMIT') s.tabLimit = payload?.limit || 0;
    if (command === 'BLOCK_SITES')   s.blockedSites = payload?.sites || [];
  }
  broadcastToTeachers({ type: 'STUDENT_LIST', students: getStudentList() });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getStudentList() {
  return [...students.values()].map(s => getStudentData(s.id));
}

function getStudentData(id) {
  const s = students.get(id);
  if (!s) return null;
  return { id: s.id, name: s.name, isLocked: s.isLocked, tabs: s.tabs, tabCount: s.tabCount, blockedSites: s.blockedSites, tabLimit: s.tabLimit, lastSeen: s.lastSeen, online: Date.now() - s.lastSeen < 30000 };
}

function broadcastToTeachers(msg) {
  const str = JSON.stringify(msg);
  for (const ws of teachers) { if (ws.readyState === WebSocket.OPEN) ws.send(str); }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false; ws.ping();
  });
}, 15000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🛡️  Uncle Joe's Guardian running on port ${PORT}\n   Dashboard: http://localhost:${PORT}`));
