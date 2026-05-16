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

// Serve static files from same directory
app.use(express.static(__dirname));

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/locked', function(req, res) {
  res.sendFile(path.join(__dirname, 'locked.html'));
});

app.get('/health', function(req, res) {
  res.send('OK');
});

const students = new Map();
const teachers = new Set();
const screenshots = new Map();

wss.on('connection', function(ws) {
  ws.isAlive = true;
  ws.on('pong', function() { ws.isAlive = true; });

  ws.on('message', function(data) {
    var msg;
    try { msg = JSON.parse(data); } catch(e) { return; }

    if (msg.type === 'STUDENT_CONNECT') {
      ws.role = 'student';
      ws.studentId = msg.studentId;
      students.set(msg.studentId, {
        ws: ws, id: msg.studentId,
        name: msg.studentName || 'Student',
        isLocked: false, tabs: [], tabCount: 0,
        blockedSites: [], tabLimit: 0, lastSeen: Date.now()
      });
      console.log('[+] Student: ' + msg.studentName);
      broadcastToTeachers({ type: 'STUDENT_LIST', students: getStudentList() });

    } else if (msg.type === 'TEACHER_CONNECT') {
      ws.role = 'teacher';
      teachers.add(ws);
      console.log('[+] Teacher connected');
      ws.send(JSON.stringify({ type: 'STUDENT_LIST', students: getStudentList() }));
      screenshots.forEach(function(img, id) {
        var s = students.get(id);
        if (s) ws.send(JSON.stringify({ type: 'SCREENSHOT', studentId: id, studentName: s.name, image: img }));
      });

    } else if (msg.type === 'STATUS_UPDATE' && ws.role === 'student') {
      var s = students.get(msg.studentId);
      if (s) {
        s.name = msg.studentName || s.name;
        s.isLocked = msg.isLocked;
        s.tabs = msg.tabs || [];
        s.tabCount = msg.tabCount;
        s.blockedSites = msg.blockedSites || [];
        s.tabLimit = msg.tabLimit || 0;
        s.lastSeen = Date.now();
      }
      broadcastToTeachers({ type: 'STUDENT_UPDATE', student: getStudentData(msg.studentId) });

    } else if (msg.type === 'SCREENSHOT' && ws.role === 'student') {
      screenshots.set(msg.studentId, msg.image);
      var payload = JSON.stringify({
        type: 'SCREENSHOT',
        studentId: msg.studentId,
        studentName: msg.studentName,
        image: msg.image,
        tabTitle: msg.tabTitle,
        tabUrl: msg.tabUrl
      });
      teachers.forEach(function(t) {
        if (t.readyState === WebSocket.OPEN) t.send(payload);
      });

    } else if (msg.type === 'TEACHER_COMMAND' && ws.role === 'teacher') {
      handleTeacherCommand(msg);
    }
  });

  ws.on('close', function() {
    if (ws.role === 'student' && ws.studentId) {
      students.delete(ws.studentId);
      screenshots.delete(ws.studentId);
      broadcastToTeachers({ type: 'STUDENT_LIST', students: getStudentList() });
    } else if (ws.role === 'teacher') {
      teachers.delete(ws);
    }
  });
});

function handleTeacherCommand(msg) {
  var command = msg.command;
  var targetId = msg.targetId;
  var payload = msg.payload || {};

  var targets = targetId === 'all'
    ? Array.from(students.values()).map(function(s) { return s.ws; })
    : (students.has(targetId) ? [students.get(targetId).ws] : []);

  targets.forEach(function(w) {
    if (w.readyState === WebSocket.OPEN) {
      var toSend = Object.assign({ type: command }, payload);
      w.send(JSON.stringify(toSend));
    }
  });

  var ids = targetId === 'all' ? Array.from(students.keys()) : [targetId];
  ids.forEach(function(id) {
    var s = students.get(id);
    if (!s) return;
    if (command === 'LOCK_SCREEN') s.isLocked = true;
    if (command === 'UNLOCK_SCREEN') s.isLocked = false;
    if (command === 'SET_TAB_LIMIT') s.tabLimit = payload.limit || 0;
    if (command === 'BLOCK_SITES') s.blockedSites = payload.sites || [];
  });

  broadcastToTeachers({ type: 'STUDENT_LIST', students: getStudentList() });
}

function getStudentList() {
  return Array.from(students.values()).map(function(s) { return getStudentData(s.id); });
}

function getStudentData(id) {
  var s = students.get(id);
  if (!s) return null;
  return {
    id: s.id, name: s.name, isLocked: s.isLocked,
    tabs: s.tabs, tabCount: s.tabCount,
    blockedSites: s.blockedSites, tabLimit: s.tabLimit,
    lastSeen: s.lastSeen, online: (Date.now() - s.lastSeen) < 30000
  };
}

function broadcastToTeachers(msg) {
  var str = JSON.stringify(msg);
  teachers.forEach(function(ws) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}

setInterval(function() {
  wss.clients.forEach(function(ws) {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

var PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log('Uncle Joes Guardian running on port ' + PORT);
});
