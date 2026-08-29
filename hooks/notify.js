#!/usr/bin/env node
// Called by Claude Code hooks. Usage: notify.js attention|complete|working|end
// Reads the hook JSON from stdin (cwd, session_id, message, transcript_path...) and updates
// ~/.claude-code-notify/state.json, which the VS Code extension watches.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const status = process.argv[2];
if (!['attention', 'complete', 'working', 'end'].includes(status)) {
  console.error('usage: notify.js attention|complete|working|end');
  process.exit(2);
}

const DIR = path.join(os.homedir(), '.claude-code-notify');
const STATE = path.join(DIR, 'state.json');
const MAX_SESSIONS = 30;
const PREVIEW_CHARS = 160;

let input = {};
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.trim()) input = JSON.parse(raw);
} catch (_) { /* no/invalid stdin: fine (manual invocation) */ }

const cwd = input.cwd || process.cwd();
const sessionId = input.session_id || `manual-${cwd}`;

// Ancestors of this hook process: ... -> terminal shell -> claude -> (sh) -> node(this).
// The extension matches these against its terminals' shell PIDs to find the right terminal,
// and uses the claude PID to drop sessions whose process has exited.
function ancestors() {
  const out = [];
  let pid = process.pid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    let line;
    // For `pid`, ps prints: <its parent pid> <its own command>
    try { line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim(); }
    catch (_) { break; }
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) break;
    if (pid !== process.pid) out.push({ pid, comm: m[2] });
    pid = parseInt(m[1], 10);
  }
  return out;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Millisecond sleep, synchronous (this is a short-lived one-shot process).
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Read the tail of the transcript and return { text, afterUser }:
//   text      = the last assistant message that has text
//   afterUser = true if that assistant message comes after the last real user prompt
// afterUser lets us detect the flush race: a Stop fires right after Claude answers, so if the newest
// text still predates the last user prompt, the reply hasn't hit disk yet — the caller retries.
function readLastAssistant(transcriptPath) {
  let records;
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - 512 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    records = buf.toString('utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } });
  } catch (_) { return { text: '', afterUser: true }; } // no transcript: don't loop forever

  const isText = c => Array.isArray(c) && c.some(x => x.type === 'text');
  const textOf = c => c.filter(x => x.type === 'text').map(x => x.text).join(' ')
    .replace(/[#*`_>]+/g, '').replace(/\s+/g, ' ').trim();
  // A real user prompt: type user with a string or a text block (NOT a tool_result echo).
  const isUserPrompt = o => o && o.type === 'user' &&
    (typeof o.message?.content === 'string' || isText(o.message?.content));

  let lastUser = -1, lastAsst = -1, text = '';
  for (let i = 0; i < records.length; i++) {
    const o = records[i];
    if (isUserPrompt(o)) lastUser = i;
    else if (o && o.type === 'assistant' && isText(o.message?.content)) {
      const t = textOf(o.message.content);
      if (t) { lastAsst = i; text = t; }
    }
  }
  const trimmed = text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS - 1) + '\u2026' : text;
  return { text: trimmed, afterUser: lastAsst > lastUser };
}

// Last assistant text, waiting briefly for the just-written reply to be flushed to the transcript.
function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  let r = readLastAssistant(transcriptPath);
  for (let i = 0; i < 20 && !r.afterUser; i++) { sleep(50); r = readLastAssistant(transcriptPath); } // up to ~1s
  return r.text;
}

// --- ntfy push: notify your phone even when VS Code is closed. Config in ~/.claude-code-notify/config.json:
//   { ntfyServer, ntfyTopic, ntfyPush: "off"|"attention"|"all" }. Fire-and-forget; never blocks the hook.
function pushNtfy(status, title, body) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch (_) { return; }
  const mode = cfg.ntfyPush || 'off';
  if (mode === 'off' || !cfg.ntfyTopic) return;
  if (mode === 'attention' && status !== 'attention') return;
  if (!['attention', 'complete'].includes(status)) return;
  let url;
  try { url = new URL(cfg.ntfyTopic, (cfg.ntfyServer || 'https://ntfy.sh').replace(/\/?$/, '/')); } catch (_) { return; }
  const lib = url.protocol === 'http:' ? http : https;
  const data = Buffer.from(body || title || 'Claude', 'utf8');
  const req = lib.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': data.length,
      'Title': (title || 'Claude Code').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim() || 'Claude Code',
      'Tags': status === 'attention' ? 'warning' : 'white_check_mark',
      'Priority': status === 'attention' ? 'high' : 'default',
    },
  });
  req.on('error', () => {});
  req.setTimeout(4000, () => req.destroy());
  req.end(data);
  return req;
}

fs.mkdirSync(DIR, { recursive: true });
let state = { sessions: {} };
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { /* fresh */ }
state.sessions = state.sessions || {};
if (state.focus && Date.now() - state.focus.at > 15_000) delete state.focus; // stale request

let dirty = false;
let pushed = null;

// Drop sessions whose claude process is gone (quit, crashed, terminal closed).
for (const [id, s] of Object.entries(state.sessions)) {
  if (s.claudePid && !isAlive(s.claudePid)) { delete state.sessions[id]; dirty = true; }
}

if (status === 'end') {
  if (state.sessions[sessionId]) { delete state.sessions[sessionId]; dirty = true; }
} else {
  const prev = state.sessions[sessionId];
  // "working" is a quiet transition: only record it when it actually changes something.
  if (!(status === 'working' && prev && prev.status === 'working' && prev.claudePid)) {
    let pids, claudePid;
    if (status === 'working' && prev?.pids?.length && prev.claudePid) { pids = prev.pids; claudePid = prev.claudePid; }
    else {
      const anc = ancestors();
      pids = anc.map(a => a.pid);
      claudePid = (anc.find(a => path.basename(a.comm) === 'claude' || /\/claude$/.test(a.comm)) || anc[0] || {}).pid;
    }
    let message = '';
    if (status === 'attention') message = input.message || 'Claude needs your approval';
    if (status === 'complete') message = lastAssistantText(input.transcript_path);
    state.sessions[sessionId] = {
      sessionId, cwd, name: path.basename(cwd), pids, claudePid, status, message,
      updatedAt: Date.now(),
      stamp: `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`,
    };
    dirty = true;
    pushed = pushNtfy(
      status,
      state.sessions[sessionId].name,   // Title: ASCII only (emoji comes from the Tags header)
      status === 'attention' ? (message || 'Claude needs your approval') : (message || 'Claude finished'),
    );
  }
}

if (!dirty) process.exit(0);

// Keep the list bounded: drop the oldest sessions.
const entries = Object.values(state.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
state.sessions = Object.fromEntries(entries.slice(0, MAX_SESSIONS).map(s => [s.sessionId, s]));

// Atomic write so the watcher never reads a half-written file.
const tmp = `${STATE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
fs.renameSync(tmp, STATE);
