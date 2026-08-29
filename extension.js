const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const lib = require('./lib');

let statusItem;

function cfg() { return vscode.workspace.getConfiguration('claudeCodeNotify'); }
function myFolders() { return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath); }
function isThisWindow(s) { return myFolders().some(f => lib.inside(s.cwd, f)); }

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const STATUS = {
  attention: { icon: '$(warning)', label: 'Needs attention', group: 'Needs attention',
               themeIcon: new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange')) },
  complete:  { icon: '$(check)', label: 'Completed', group: 'Completed',
               themeIcon: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')) },
  working:   { icon: '$(sync~spin)', label: 'Working', group: 'Working (not a notification)',
               themeIcon: new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue')) },
};
const isNotification = s => s.status === 'attention' || s.status === 'complete';

// ---- status bar -------------------------------------------------------------------------------
function refreshStatus() {
  if (!cfg().get('showStatusBar')) { statusItem.hide(); return; }
  const list = lib.sessions();
  const attention = list.filter(s => s.status === 'attention');
  const complete = list.filter(s => s.status === 'complete');
  const muted = lib.isMuted();
  if (attention.length || complete.length) {
    const parts = [`${muted ? '$(mute)' : '$(bell-dot)'} Claude`];
    if (attention.length) parts.push(`$(warning) ${attention.length}`);
    if (complete.length) parts.push(`$(pass-filled) ${complete.length}`);
    statusItem.text = parts.join('  ');
    // Orange background while anything needs you; green text when only completions are waiting to be read.
    // (VS Code only allows warning/error/prominent backgrounds, and "prominent" is nearly invisible in most themes.)
    statusItem.backgroundColor = attention.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    statusItem.color = attention.length ? undefined : new vscode.ThemeColor('charts.green');
    statusItem.tooltip = [
      ...attention.map(s => `⚠ ${s.name}: ${s.message}`),
      ...complete.map(s => `✓ ${s.name} (${ago(s.updatedAt)}): ${s.message || 'finished'}`),
      '', 'Click to open the list',
    ].join('\n');
  } else {
    statusItem.text = muted ? '$(mute) Claude' : '$(bell) Claude';
    statusItem.backgroundColor = undefined;
    statusItem.color = undefined;
    statusItem.tooltip = `Claude Code Notify${muted ? ' (muted)' : ''} — no unread notifications`;
  }
  statusItem.show();
}

// ---- terminals --------------------------------------------------------------------------------
const terminalPids = new Map(); // Terminal -> shell pid

async function trackTerminals() {
  for (const t of vscode.window.terminals) {
    if (!terminalPids.has(t)) { try { terminalPids.set(t, await t.processId); } catch (_) {} }
  }
  for (const t of [...terminalPids.keys()]) if (!vscode.window.terminals.includes(t)) terminalPids.delete(t);
  lib.registerWindow(myFolders(), [...terminalPids.values()].filter(Boolean));
}

// The terminal in THIS window whose shell is an ancestor of the session's hook process.
function ownedTerminal(s) {
  const pids = new Set(s.pids || []);
  for (const [t, pid] of terminalPids) if (pids.has(pid)) return t;
  return null;
}

function revealTerminal(t) { t.show(false); }

// Another window asked us (via state.focus) to reveal a terminal we own.
function handleFocusRequest(state) {
  const req = state.focus;
  if (!req || Date.now() - req.at > 15_000) return;
  const t = ownedTerminal(req);
  if (!t) return;
  revealTerminal(t);
  const fresh = lib.readState();
  delete fresh.focus;
  lib.writeState(fresh);
}

// When the user switches to this window and Claude is waiting here, bring that terminal forward.
function onWindowFocused() {
  if (!cfg().get('focusTerminalOnWindowFocus')) { markSeenByTerminal(vscode.window.activeTerminal); return; }
  const waiting = lib.sessions().filter(s => s.status === 'attention').map(s => ownedTerminal(s)).filter(Boolean);
  if (waiting[0]) revealTerminal(waiting[0]);
  // Whatever terminal is now in front has been seen.
  setTimeout(() => markSeenByTerminal(vscode.window.activeTerminal), 300);
}

// Viewing a session's terminal counts as having seen its notification: drop it.
function markSeenByTerminal(t) {
  if (!t || !cfg().get('dismissOnView')) return;
  const pid = terminalPids.get(t);
  if (!pid) return;
  for (const s of lib.sessions()) if (isNotification(s) && (s.pids || []).includes(pid)) dismiss(s);
}

// VS Code fires no event when you click into a terminal that is already the active one (e.g. the only
// terminal in the window). So: if a notification lands in the focused window for the terminal that's
// already in front, treat it as seen after a short delay, as long as you're still there.
function autoReadIfInFront(s) {
  const delay = cfg().get('autoReadDelay');
  if (!delay || !cfg().get('dismissOnView') || !isNotification(s)) return;
  const inFront = () => vscode.window.state.focused && ownedTerminal(s) && ownedTerminal(s) === vscode.window.activeTerminal;
  if (!inFront()) return;
  setTimeout(() => {
    const cur = lib.readState().sessions?.[s.sessionId];
    if (cur && cur.stamp === s.stamp && inFront()) dismiss(cur);
  }, delay * 1000);
}

// ---- events -----------------------------------------------------------------------------------
function onChange(_state, changed, updated = []) {
  updated.forEach(autoReadIfInFront);
  const c = cfg();
  for (const s of changed) {
    const isAttention = s.status === 'attention';
    if (!lib.isMuted()) lib.playSound(c.get(isAttention ? 'attentionSound' : 'completeSound'), c.get('volume'));
    if (c.get('showToast')) {
      const msg = isAttention ? `Claude needs you in ${s.name}: ${s.message}` : `Claude finished in ${s.name}`;
      const show = isAttention ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      show(msg, 'Open').then(pick => { if (pick === 'Open') focusSession(s); });
    }
  }
  handleFocusRequest(_state);
  refreshStatus();
}

// ---- focusing another window ------------------------------------------------------------------
function codeCli() {
  // Prefer the CLI shipped with the running VS Code (works even if `code` isn't on PATH).
  const candidates = [
    path.join(vscode.env.appRoot, 'bin', 'code'),                  // macOS/Linux
    path.join(vscode.env.appRoot, 'bin', vscode.env.appName.toLowerCase().replace(/\s+/g, '')),
    path.join(vscode.env.appRoot, 'bin', 'code.cmd'),              // Windows
  ];
  return candidates.find(p => fs.existsSync(p)) || 'code';
}

function focusSession(s) {
  const t = ownedTerminal(s);
  if (t) { revealTerminal(t); if (isNotification(s)) dismiss(s); return; }   // in this window: just show it

  const folder = lib.folderForSession(s);
  // `code <folder>` focuses the window that already has the folder open, or opens a new one.
  try {
    spawn(codeCli(), [folder], { stdio: 'ignore', detached: true }).unref();
  } catch (_) {
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
  }
  // Ask the owning window to reveal the terminal, and drop the session from the list.
  const state = lib.readState();
  if (isNotification(s) && state.sessions?.[s.sessionId]) delete state.sessions[s.sessionId];
  state.focus = { pids: s.pids || [], cwd: s.cwd, at: Date.now() };
  lib.writeState(state);
  refreshStatus();
}

function clearNotifications() {
  const state = lib.readState();
  for (const [id, s] of Object.entries(state.sessions || {})) if (isNotification(s)) delete state.sessions[id];
  lib.writeState(state);
  refreshStatus();
}

function dismiss(s) {
  const state = lib.readState();
  if (state.sessions?.[s.sessionId]) { delete state.sessions[s.sessionId]; lib.writeState(state); }
  refreshStatus();
}

// ---- nag: repeat the attention sound while something stays unanswered -------------------------
function nagTick() {
  const mins = cfg().get('nagIntervalMinutes');
  if (!mins || lib.isMuted()) return;
  const intervalMs = mins * 60_000;
  const now = Date.now();
  const overdue = lib.sessions().filter(s => s.status === 'attention' && now - s.updatedAt >= intervalMs);
  if (!overdue.length) return;
  // One sound per interval across all windows: the first window to claim this time bucket plays it.
  const bucket = Math.floor(now / intervalMs);
  if (!lib.claim(`nag-${bucket}`)) return;
  lib.playSound(cfg().get('attentionSound'), cfg().get('volume'));
}

// ---- jump: go straight to whatever needs you next -----------------------------------------------
function jumpToNext() {
  const list = lib.sessions();
  // Oldest unanswered approval first; otherwise the most recent completion.
  const attention = list.filter(s => s.status === 'attention').sort((a, b) => a.updatedAt - b.updatedAt);
  const target = attention[0] || list.find(s => s.status === 'complete');
  if (!target) { vscode.window.setStatusBarMessage('Claude Code Notify: nothing needs you right now', 3000); return; }
  focusSession(target);
}

// ---- quick pick -------------------------------------------------------------------------------
const BTN_MUTE = { iconPath: new vscode.ThemeIcon('mute'), tooltip: 'Mute sounds' };
const BTN_UNMUTE = { iconPath: new vscode.ThemeIcon('unmute'), tooltip: 'Unmute sounds' };
const BTN_CLEAR = { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Mark all as read' };
const BTN_DISMISS = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Dismiss' };

function showList() {
  const qp = vscode.window.createQuickPick();
  qp.title = 'Claude Code sessions';
  qp.placeholder = 'Select a session to focus its window (it is then removed from the list)';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  const render = () => {
    const list = lib.sessions();
    const muted = lib.isMuted();
    qp.buttons = [muted ? BTN_UNMUTE : BTN_MUTE, BTN_CLEAR];
    const items = [];
    for (const key of ['attention', 'complete', 'working']) {
      const group = list.filter(s => s.status === key);
      if (!group.length) continue;
      const st = STATUS[key];
      items.push({ label: st.group, kind: vscode.QuickPickItemKind.Separator });
      for (const s of group) items.push({
        label: `${s.name}${isThisWindow(s) ? '  (this window)' : ''}`,
        iconPath: st.themeIcon,
        description: ago(s.updatedAt),
        detail: s.message || s.cwd,
        session: s,
        buttons: isNotification(s) ? [BTN_DISMISS] : [],
        alwaysShow: true,
      });
    }
    if (!items.length) items.push({ label: '$(info) No Claude Code activity', description: 'Events appear here as hooks fire', alwaysShow: true });
    items.push(
      { label: 'Actions', kind: vscode.QuickPickItemKind.Separator },
      { label: 'Mark all as read', iconPath: new vscode.ThemeIcon('check-all'), description: 'Clear every notification', action: 'clear', alwaysShow: true },
      muted
        ? { label: 'Unmute sounds', iconPath: new vscode.ThemeIcon('unmute'), description: 'Sounds are currently muted', action: 'mute', alwaysShow: true }
        : { label: 'Mute sounds', iconPath: new vscode.ThemeIcon('mute'), description: 'Sounds are currently on', action: 'mute', alwaysShow: true },
    );
    qp.items = items;
  };
  const runAction = (action) => {
    if (action === 'clear') clearNotifications();
    if (action === 'mute') lib.setMuted(!lib.isMuted());
    refreshStatus(); render();
  };
  render();

  qp.onDidTriggerButton(btn => runAction(btn === BTN_CLEAR ? 'clear' : 'mute'));
  qp.onDidTriggerItemButton(e => { if (e.item.session) { dismiss(e.item.session); render(); } });
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    if (item?.action) { runAction(item.action); return; }   // stays open
    if (item?.session) focusSession(item.session);
    qp.hide();
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

// ---- lifecycle --------------------------------------------------------------------------------
// Mirror the push-related settings into ~/.claude-code-notify/config.json so the hook script
// (which cannot read VS Code settings) sends phone pushes with the current values.
function syncConfig() {
  const c = cfg();
  const dir = path.join(os.homedir(), '.claude-code-notify');
  const file = path.join(dir, 'config.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  const next = {
    ...existing,
    ntfyServer: c.get('ntfyServer') || 'https://ntfy.sh',
    ntfyTopic: c.get('ntfyTopic') || '',
    ntfyPush: c.get('ntfyPush') || 'off',
  };
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(next, null, 2)); } catch (_) {}
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusItem.command = 'claudeCodeNotify.showList';
  context.subscriptions.push(statusItem);

  syncConfig();
  trackTerminals();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(trackTerminals),
    vscode.window.onDidOpenTerminal(trackTerminals),
    vscode.window.onDidCloseTerminal(trackTerminals),
    vscode.window.onDidChangeWindowState(e => { if (e.focused) onWindowFocused(); }),
    vscode.window.onDidChangeActiveTerminal(t => { if (vscode.window.state.focused) markSeenByTerminal(t); }),
  );
  context.subscriptions.push({ dispose: lib.unregisterWindow });

  context.subscriptions.push(lib.watch(onChange));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('claudeCodeNotify')) { refreshStatus(); syncConfig(); }
  }));
  // Keep the "Xm ago"/badge fresh even without events.
  const tick = setInterval(refreshStatus, 60_000);
  const nag = setInterval(nagTick, 30_000);
  context.subscriptions.push({ dispose: () => { clearInterval(tick); clearInterval(nag); } });

  const here = () => myFolders()[0] || process.cwd();
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeNotify.showList', showList),
    vscode.commands.registerCommand('claudeCodeNotify.jumpToNext', jumpToNext),
    vscode.commands.registerCommand('claudeCodeNotify.testPush', () => {
      syncConfig();
      const topic = cfg().get('ntfyTopic');
      if (!topic) { vscode.window.showWarningMessage('Set claudeCodeNotify.ntfyTopic first, then subscribe to it in the ntfy app.'); return; }
      lib.emit('attention', myFolders()[0] || process.cwd(), 'Test push from Claude Code Notify');
      vscode.window.showInformationMessage(`Sent a test push to ntfy topic "${topic}". Check your phone.`);
    }),
    vscode.commands.registerCommand('claudeCodeNotify.toggleMute', () => { lib.setMuted(!lib.isMuted()); refreshStatus(); }),
    vscode.commands.registerCommand('claudeCodeNotify.clear', clearNotifications),
    vscode.commands.registerCommand('claudeCodeNotify.testAttention', () => lib.emit('attention', here(), 'Test: Claude needs your approval')),
    vscode.commands.registerCommand('claudeCodeNotify.testComplete', () => lib.emit('complete', here())),
  );
  refreshStatus();
}

function deactivate() { lib.unregisterWindow(); }

module.exports = { activate, deactivate };
