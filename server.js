const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 5 * 1024 * 1024 });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/locked', (req, res) => res.sendFile(path.join(__dirname, 'locked.html')));
app.get('/health', (req, res) => res.json({ ok: true, accounts: Object.keys(db.accounts).length, codes: Object.keys(db.studentLinks).length }));

// Extension calls this on startup to register its code BEFORE teacher adds them
app.post('/api/register-code', function(req, res) {
  try {
    var code = String(req.body.code || '').trim();
    var studentId = String(req.body.studentId || '').trim();
    var studentName = String(req.body.studentName || 'Student').trim();
    if (!code || !studentId) return res.json({ ok: false });
    db.studentLinks[code] = studentId;
    console.log('[Code] ' + code + ' -> ' + studentId + ' (' + studentName + ')');
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// ── In-memory database (persists while server runs) ──────────────
// On Railway, file system may be read-only so we keep everything in memory
// Accounts survive as long as the server process is running
const db = {
  accounts: {
    admin: { password: 'Admin', name: 'Admin', students: [] }
  },
  studentLinks: {},   // code (string) → studentId
  studentNames: {}    // code (string) → studentName
};

// ── REST API ─────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ ok: false, error: 'Missing username or password' });
    const acc = db.accounts[username.toLowerCase().trim()];
    if (acc && acc.password === password) {
      res.json({ ok: true, name: acc.name, students: acc.students || [] });
    } else {
      res.json({ ok: false, error: 'Incorrect username or password' });
    }
  } catch(e) {
    console.error('Login error:', e);
    res.json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/register', (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password || !name) return res.json({ ok: false, error: 'Please fill in all fields' });
    if (password.length < 4) return res.json({ ok: false, error: 'Password must be at least 4 characters' });
    const key = username.toLowerCase().trim();
    if (db.accounts[key]) return res.json({ ok: false, error: 'That username is already taken' });
    db.accounts[key] = { password, name: name.trim(), students: [] };
    console.log('[+] New account:', key);
    res.json({ ok: true });
  } catch(e) {
    console.error('Register error:', e);
    res.json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/add-student', (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.json({ ok: false, error: 'Missing code' });
    const code5 = String(code).trim();
    const studentId = db.studentLinks[code5];
    if (!studentId) {
      console.log('[Code lookup] ' + code5 + ' not found. Known: ' + Object.keys(db.studentLinks).join(', '));
      return res.json({ ok: false, error: 'Code not found. Make sure the student has Chrome open with the extension installed and active.' });
    }
    console.log('[+] Student lookup ok: ' + code5 + ' -> ' + studentId);
    res.json({ ok: true, studentId });
  } catch(e) {
    res.json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/remove-student', (req, res) => res.json({ ok: true }));



// ── WebSocket ────────────────────────────────────────────────────

const students = new Map();
const teachers = new Map();  // ws → username
const screenshots = new Map();

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData); } catch(e) { return; }

    if (msg.type === 'STUDENT_CONNECT') {
      ws.role = 'student';
      ws.studentId = msg.studentId;
      const code = msg.code ? String(msg.code).trim() : null;
      ws.studentCode = code;
      if (code) db.studentLinks[code] = msg.studentId;

      students.set(msg.studentId, {
        ws, id: msg.studentId, code,
        name: msg.studentName || 'Student',
        isLocked: false, tabs: [], tabCount: 0,
        blockedSites: [], tabLimit: 0, lastSeen: Date.now()
      });
      console.log(`[Student] ${msg.studentName} code=${code}`);
      // Send updated list to ALL teachers who have this student
      notifyRelevantTeachers(msg.studentId);
      // Also send full list to every teacher (so offline->online transition shows)
      notifyAllTeachers();

    } else if (msg.type === 'TEACHER_CONNECT') {
      ws.role = 'teacher';
      const username = (msg.username || '').toLowerCase().trim();
      ws.username = username;
      // If admin, automatically get all connected students
      let clientStudents = msg.studentIds || [];
      if (username === 'admin') {
        clientStudents = Array.from(students.keys());
      }
      ws.myStudentIds = clientStudents;
      teachers.set(ws, username);
      console.log(`[Teacher] ${username} with ${clientStudents.length} students: ${clientStudents.join(',')}`);
      sendTeacherStudentList(ws);
      // Send cached screenshots for their students
      clientStudents.forEach(sid => {
        if (screenshots.has(sid)) {
          const s = students.get(sid);
          try {
            ws.send(JSON.stringify({ type: 'SCREENSHOT', studentId: sid, studentName: s?.name || '', image: screenshots.get(sid) }));
          } catch(e) {}
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

    } else if (msg.type === 'CHAT_MSG' && ws.role === 'student') {
      // Student sent a chat message back to teacher
      var chatPayload = JSON.stringify({
        type: 'CHAT_MSG',
        studentId: ws.studentId,
        studentName: msg.studentName || 'Student',
        text: msg.text || '',
        timestamp: Date.now()
      });
      teachers.forEach(function(username, tws) {
        var myIds = tws.myStudentIds || [];
        if (myIds.includes(ws.studentId) && tws.readyState === WebSocket.OPEN) {
          tws.send(chatPayload);
        }
      });

    } else if (msg.type === 'SCREENSHOT' && ws.role === 'student') {
      screenshots.set(msg.studentId, msg.image);
      const payload = JSON.stringify({
        type: 'SCREENSHOT', studentId: msg.studentId,
        studentName: msg.studentName, image: msg.image,
        tabTitle: msg.tabTitle, tabUrl: msg.tabUrl
      });
      teachers.forEach((username, tws) => {
        const myIds = tws.myStudentIds || [];
        if (myIds.includes(msg.studentId) && tws.readyState === WebSocket.OPEN) {
          try { tws.send(payload); } catch(e) {}
        }
      });

    } else if (msg.type === 'TEACHER_COMMAND' && ws.role === 'teacher') {
      const username = ws.username;
      const myIds = ws.myStudentIds || [];
      const { command, targetId, payload } = msg;

      const targets = targetId === 'all'
        ? myIds.map(sid => students.get(sid)?.ws).filter(w => w && w.readyState === WebSocket.OPEN)
        : (myIds.includes(targetId) && students.get(targetId)?.ws?.readyState === WebSocket.OPEN)
          ? [students.get(targetId).ws] : [];

      targets.forEach(tw => {
        try { tw.send(JSON.stringify(Object.assign({ type: command }, payload || {}))); } catch(e) {}
      });

      const ids = targetId === 'all' ? myIds : [targetId];
      ids.forEach(id => {
        const s = students.get(id); if (!s) return;
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

  ws.on('error', () => {});
});

function getStudentData(id) {
  const s = students.get(id);
  if (!s) return { id, name: null, online: false, tabs: [], tabCount: 0, isLocked: false, code: null };
  return { id: s.id, name: s.name, code: s.code, isLocked: s.isLocked, tabs: s.tabs, tabCount: s.tabCount, lastSeen: s.lastSeen, online: (Date.now() - s.lastSeen) < 30000 };
}

function sendTeacherStudentList(tws) {
  const myIds = tws.myStudentIds || [];
  const list = myIds.map(sid => getStudentData(sid));
  try { tws.send(JSON.stringify({ type: 'STUDENT_LIST', students: list })); } catch(e) {}
}

function notifyRelevantTeachers(studentId) {
  teachers.forEach((username, tws) => {
    const myIds = tws.myStudentIds || [];
    if (myIds.includes(studentId) && tws.readyState === WebSocket.OPEN) {
      // Send full list so dashboard always has complete picture
      sendTeacherStudentList(tws);
      // Also send individual update
      const data = getStudentData(studentId);
      try { tws.send(JSON.stringify({ type: 'STUDENT_UPDATE', student: data })); } catch(e) {}
    }
  });
}

function notifyAllTeachers() {
  teachers.forEach((username, tws) => {
    if (tws.readyState === WebSocket.OPEN) sendTeacherStudentList(tws);
  });
}

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Uncle Joes Guardian running on port ' + PORT);
  console.log('Default login: Admin / Admin');
});
