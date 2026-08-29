// Core logic with no dependency on the `vscode` module, so it can be tested from plain Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DIR = path.join(os.homedir(), '.claude-code-notify');
const STATE = path.join(DIR, 'state.json');
const MUTE = path.join(DIR, 'muted');
const WINDOWS = path.join(DIR, 'windows');
const HOOK = path.join(__dirname, 'hooks', 'notify.js');

function ensureDir() { fs.mkdirSync(WINDOWS, { recursive: true }); }

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return { sessions: {} }; }
}

function writeState(state) {
  ensureDir();
  const tmp = `${STATE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Live sessions, grouped attention → complete → working, newest first within a group.
// Sessions whose claude process has exited are hidden (the hook script deletes them on its next run).
function sessions(state = readState()) {
  const rank = { attention: 0, complete: 1, working: 2 };
  return Object.values(state.sessions || {}).filter(s => !s.claudePid || isAlive(s.claudePid)).sort((a, b) =>
    (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.updatedAt - a.updatedAt);
}

function isMuted() { return fs.existsSync(MUTE); }
function setMuted(on) {
  ensureDir();
  if (on) fs.writeFileSync(MUTE, ''); else { try { fs.unlinkSync(MUTE); } catch (_) {} }
}

// Play a sound file. macOS uses afplay; Linux falls back to paplay.
function playSound(file, volume = 1) {
  if (!file) return;
  let cmd, args;
  if (process.platform === 'darwin') { cmd = 'afplay'; args = ['-v', String(volume), file]; }
  else if (process.platform === 'linux') { cmd = 'paplay'; args = [file]; }
  else return;
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch (_) {}
}

// Several VS Code windows each run their own copy of the extension. Each state change carries a
// unique stamp; the first instance to create the matching claim file "wins" and plays the sound.
function claim(stamp) {
  try { fs.writeFileSync(path.join(DIR, `.claim-${stamp}`), String(process.pid), { flag: 'wx' }); return true; }
  catch (e) { return e.code !== 'EEXIST'; }
}

function cleanupOldClaims(maxAgeMs = 60_000) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(DIR)) {
      if (!name.startsWith('.claim-')) continue;
      const p = path.join(DIR, name);
      try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch (_) {}
    }
  } catch (_) {}
}

// Watch state.json. onChange(state, changed, updated):
//   `updated` = sessions whose stamp is new since our last read (every window sees these)
//   `changed` = the subset this instance won the claim for (so sounds play once across all windows)
function watch(onChange) {
  ensureDir();
  const seen = new Map(Object.values(readState().sessions || {}).map(s => [s.sessionId, s.stamp]));
  let debounce;
  const watcher = fs.watch(DIR, (_type, filename) => {
    if (filename !== 'state.json' && filename !== 'muted') return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const state = readState();
      const changed = [], updated = [];
      for (const s of Object.values(state.sessions || {})) {
        if (seen.get(s.sessionId) === s.stamp) continue;
        seen.set(s.sessionId, s.stamp);
        updated.push(s);
        if (s.status !== 'working' && claim(s.stamp)) changed.push(s);
      }
      onChange(state, changed, updated);
    }, 50);
  });
  const timer = setInterval(cleanupOldClaims, 5 * 60_000);
  return { dispose() { watcher.close(); clearInterval(timer); clearTimeout(debounce); } };
}

// Emit an event the same way a hook would (used by the test commands).
function emit(status, cwd, message) {
  const payload = JSON.stringify({ cwd, session_id: `test-${cwd}`, message });
  execFileSync(process.execPath, [HOOK, status], { input: payload });
}

// --- Window registry: each VS Code window records which folders it has open, so a click on a
// session can focus the right window even when Claude was started in a subfolder.
function windowFile() { return path.join(WINDOWS, `${process.pid}.json`); }
function registerWindow(folders, terminalPids = []) {
  ensureDir();
  fs.writeFileSync(windowFile(), JSON.stringify({ pid: process.pid, folders, terminalPids, at: Date.now() }));
}
function unregisterWindow() { try { fs.unlinkSync(windowFile()); } catch (_) {} }
function liveWindows() {
  const out = [];
  try {
    for (const name of fs.readdirSync(WINDOWS)) {
      const p = path.join(WINDOWS, name);
      try {
        const w = JSON.parse(fs.readFileSync(p, 'utf8'));
        try { process.kill(w.pid, 0); out.push(w); } catch (_) { fs.unlinkSync(p); } // stale: host gone
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}
function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
// Window that owns one of the session's ancestor PIDs as a terminal shell (exact match), if any.
function windowForSession(s) {
  const pids = new Set(s.pids || []);
  return liveWindows().find(w => (w.terminalPids || []).some(pid => pids.has(pid))) || null;
}
// Best folder to pass to `code <folder>` so the window running this session gets focused.
function folderForSession(s) {
  const w = windowForSession(s);
  if (w && w.folders?.length) return w.folders.find(f => inside(s.cwd, f)) || w.folders[0];
  return folderForCwd(s.cwd);
}
// Best folder to pass to `code <folder>` so the window that has `cwd` open gets focused.
function folderForCwd(cwd) {
  let best = null;
  for (const w of liveWindows()) for (const f of w.folders || []) {
    if (inside(cwd, f) && (!best || f.length > best.length)) best = f;
  }
  return best || cwd;
}

module.exports = {
  DIR, STATE, HOOK, readState, writeState, sessions, isAlive, claim, isMuted, setMuted, playSound, watch, emit,
  registerWindow, unregisterWindow, liveWindows, folderForCwd, folderForSession, windowForSession, inside,
};
