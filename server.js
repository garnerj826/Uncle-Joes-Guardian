const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 5 * 1024 * 1024 });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/locked', (req, res) => res.sendFile(path.join(__dirname, 'locked.html')));
app.get('/health', (req, res) => res.send('OK'));

// ── Persistent data stored in memory (survives reconnects, resets on server restart)
// For true persistence across Railway restarts, we use a JSON file
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { accounts: { admin: { password: 'admin123', name: 'Admin', students: [] } }, studentLinks: {} };
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch(e) {}
}

let db = loadData();

// ── REST API for accounts & student management ──────────────────

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const acc = db.accounts[username];
  if (acc && acc.password === password) {
    res.json({ ok: true, name: acc.name, students: acc.students || [] });
  } else {
    res.json({ ok: false, error: 'Invalid username or password' });
  }
});

// Create account
app.post('/api/register', (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password || !name) return res.json({ ok: false, error: 'Missing fields' });
  if (db.accounts[username]) return res.json({ ok: false, error: 'Username already taken' });
  db.accounts[username] = { password, name, students: [] };
  saveData();
  res.json({ ok: true });
});

// Add student by code
app.post('/api/add-student', (req, res) => {
  const { username, code } = req.body;
  if (!db.accounts[username]) return res.json({ ok: false, error: 'Account not found' });
  const code5 = String(code).trim().toUpperCase();
  // Find student with this code
  const studentId = db.studentLinks[code5];
  if (!studentId) return res.json({ ok: false, error: 'No student found with that code. Make sure the student has the extension open.' });
  // Check not already added
  const acc = db.accounts[username];
  if (!acc.students) acc.students = [];
  if (acc.students.includes(studentId)) return res.json({ ok: false, error: 'Student already in your classroom' });
  acc.students.push(studentId);
  saveData();
  res.json({ ok: true, studentId });
});

// Remove student
app.post('/api/remove-student', (req, res) => {
  const { username, studentId } = req.body;
  if (!db.accounts[username]) return res.json({ ok: false, error: 'Account not found' });
  const acc = db.accounts[username];
  acc.students = (acc.students || []).filter(s => s !== studentId);
  saveData();
  res.json({ ok: true });
});

// Get teacher's student list
app.get('/api/students/:username', (req, res) => {
  const acc = db.accounts[req.params.username];
  if (!acc) return res.json({ ok: false });
  res.json({ ok: true, students: acc.students || [] });
});

// ── WebSocket state ─────────────────────────────────────────────

const students = new Map();    // studentId → { ws, info, code }
const teachers = new Map();    // ws → { username }
const screenshots = new Map(); // studentId → image

// Register student code (called when extension starts)
// code → studentId mapping stored in db.studentLinks
function registerStudentCode(code, studentId) {
  db.studentLinks[code] = studentId;
  saveData();
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData); } catch(e) { return; }

    if (msg.type === 'STUDENT_CONNECT') {
      ws.role = 'student';
      ws.studentId = msg.studentId;
      ws.studentCode = msg.code ? String(msg.code).toUpperCase() : null;

      // Register code → studentId mapping
      if (ws.studentCode) registerStudentCode(ws.studentCode, msg.studentId);

      students.set(msg.studentId, {
        ws, id: msg.studentId, code: ws.studentCode,
        name: msg.studentName || 'Student',
        isLocked: false, tabs: [], tabCount: 0,
        blockedSites: [], tabLimit: 0, lastSeen: Date.now()
      });
      console.log(`[+] Student: ${msg.studentName} (code: ${ws.studentCode})`);
      // Notify teachers who have this student
      notifyRelevantTeachers(msg.studentId);

    } else if (msg.type === 'TEACHER_CONNECT') {
      ws.role = 'teacher';
      ws.username = msg.username;
      teachers.set(ws, { username: msg.username });
      console.log(`[+] Teacher: ${msg.username}`);
      // Send only this teacher's students
      sendTeacherStudentList(ws);
      // Send cached screenshots for their students
      const myStudents = db.accounts[msg.username]?.students || [];
      myStudents.forEach(sid => {
        if (screenshots.has(sid)) {
          const s = students.get(sid);
          ws.send(JSON.stringify({ type: 'SCREENSHOT', studentId: sid, studentName: s?.name || '', image: screenshots.get(sid) }));
        }
      });

    } else if (msg.type === 'STATUS_UPDATE' && ws.role === 'student') {
      const s = students.get(msg.studentId);
      if (s) {
        s.name = msg.studentName || s.name;
        s.isLocked = msg.isLocked;
        s.tabs = msg.tabs || [];
        s.tabCount = msg.tabCount;
        s.lastSeen = Date.now();
      }
      notifyRelevantTeachers(msg.studentId);

    } else if (msg.type === 'SCREENSHOT' && ws.role === 'student') {
      screenshots.set(msg.studentId, msg.image);
      const payload = JSON.stringify({ type: 'SCREENSHOT', studentId: msg.studentId, studentName: msg.studentName, image: msg.image, tabTitle: msg.tabTitle, tabUrl: msg.tabUrl });
      // Send only to teachers who own this student
      teachers.forEach((info, tws) => {
        const myStudents = db.accounts[info.username]?.students || [];
        if (myStudents.includes(msg.studentId) && tws.readyState === WebSocket.OPEN) {
          tws.send(payload);
        }
      });

    } else if (msg.type === 'TEACHER_COMMAND' && ws.role === 'teacher') {
      const username = ws.username;
      const myStudents = db.accounts[username]?.students || [];
      const { command, targetId, payload } = msg;

      // Only allow commanding own students
      const targets = targetId === 'all'
        ? myStudents.map(sid => students.get(sid)?.ws).filter(Boolean)
        : (myStudents.includes(targetId) && students.get(targetId)) ? [students.get(targetId).ws] : [];

      targets.forEach(tw => {
        if (tw && tw.readyState === WebSocket.OPEN) {
          tw.send(JSON.stringify(Object.assign({ type: command }, payload || {})));
        }
      });

      // Update local state
      const ids = targetId === 'all' ? myStudents : [targetId];
      ids.forEach(id => {
        const s = students.get(id);
        if (!s) return;
        if (command === 'LOCK_SCREEN') s.isLocked = true;
        if (command === 'UNLOCK_SCREEN') s.isLocked = false;
        if (command === 'SET_TAB_LIMIT') s.tabLimit = payload?.limit || 0;
        if (command === 'BLOCK_SITES') s.blockedSites = payload?.sites || [];
      });
      sendTeacherStudentList(ws);
    }
  });

  ws.on('close', () => {
    if (ws.role === 'student' && ws.studentId) {
      students.delete(ws.studentId);
      screenshots.delete(ws.studentId);
      notifyAllTeachers();
    } else if (ws.role === 'teacher') {
      teachers.delete(ws);
    }
  });
});

function getStudentData(id) {
  const s = students.get(id);
  if (!s) return null;
  return { id: s.id, name: s.name, code: s.code, isLocked: s.isLocked, tabs: s.tabs, tabCount: s.tabCount, blockedSites: s.blockedSites, tabLimit: s.tabLimit, lastSeen: s.lastSeen, online: (Date.now() - s.lastSeen) < 30000 };
}

function sendTeacherStudentList(tws) {
  const username = tws.username;
  const myStudentIds = db.accounts[username]?.students || [];
  const list = myStudentIds.map(sid => {
    const live = getStudentData(sid);
    return live || { id: sid, name: 'Offline', online: false, tabs: [], tabCount: 0, isLocked: false };
  });
  tws.send(JSON.stringify({ type: 'STUDENT_LIST', students: list }));
}

function notifyRelevantTeachers(studentId) {
  teachers.forEach((info, tws) => {
    const myStudents = db.accounts[info.username]?.students || [];
    if (myStudents.includes(studentId) && tws.readyState === WebSocket.OPEN) {
      const data = getStudentData(studentId);
      if (data) tws.send(JSON.stringify({ type: 'STUDENT_UPDATE', student: data }));
    }
  });
}

function notifyAllTeachers() {
  teachers.forEach((info, tws) => { if (tws.readyState === WebSocket.OPEN) sendTeacherStudentList(tws); });
}

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false; ws.ping();
  });
}, 15000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Uncle Joes Guardian on port ' + PORT));
