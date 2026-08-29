# Claude Code Notify (local VS Code extension)

Sounds + a session list for Claude Code across many VS Code windows.

- Distinct sound when Claude **needs your approval** and another when it **finishes** (plays once, even with many windows open).
- Status bar item `🔔 Claude` — becomes a persistent badge with counts, e.g. `🔔 Claude  ⚠ 1  ✓ 2`:
  orange while anything needs approval, green text when only completions are unread. Same in every window.
- **Click it** → list of Claude sessions grouped by type — orange ⚠ *Needs attention*, green ✓ *Completed*,
  blue ⟳ *Working* (informational only) — with folder name and time.
  Selecting one **focuses that VS Code window and the exact terminal** Claude is running in, and removes it
  from the list; ✕ on a row dismisses it.
- When you switch to a window yourself and Claude is waiting there, its terminal is revealed automatically
  (`claudeCodeNotify.focusTerminalOnWindowFocus`, on by default).
- **Read = you acted.** A notification clears when you reply / approve (the session turns *Working*), or when you
  dismiss it explicitly: click it in the list, ✕ on its row, *Mark all as read*, or *Jump to next*. Nothing clears
  on a timer or on window focus, so what you come back to after leaving is always a real unread.
  (`claudeCodeNotify.dismissOnView` optionally re-enables "switching to its terminal / focusing its window counts
  as read"; `autoReadDelay` adds a timer on top of that. Both off by default.)

## How it works
Claude Code hooks pipe their JSON (cwd, session_id, message) into `hooks/notify.js`, which maintains
`~/.claude-code-notify/state.json`. Every VS Code window runs the extension, watches that file, and registers
its open folders and terminal shell PIDs in `~/.claude-code-notify/windows/`. The hook records its ancestor
PIDs (terminal shell → claude → hook), so a session maps to one specific terminal in one specific window.
A click on a session in another window runs `code <folder>` to focus it and leaves a `focus` request in
`state.json`, which the owning window picks up to reveal the terminal.

Hooks (in `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` if you use multiple Claude profiles):

| Hook | Matcher | Status |
|---|---|---|
| Notification | `permission_prompt` | needs attention |
| Stop | — | completed (with last-message preview) |
| SessionEnd | — | removed |
| UserPromptSubmit, PostToolUse | — | working (quiet, no sound) |

## Install
```sh
ln -s /path/to/claude-code-notify ~/.vscode/extensions/local.claude-code-notify
```
Then **Developer: Reload Window**.

## Phone push (ntfy) — free
Get a buzz on your phone when Claude needs you, even if VS Code is closed.
1. Install the free **ntfy** app (iOS/Android).
2. Subscribe to the topic you set in `claudeCodeNotify.ntfyTopic` (pick a long random name). (Treat the topic like a password — anyone who
   knows it can read your pushes. Change it in `claudeCodeNotify.ntfyTopic`; the extension syncs it to the hook.)
3. Test: Command Palette → **Claude Code Notify: Send Test Phone Push**.

`claudeCodeNotify.ntfyPush`: `off` | `attention` (approvals only, default) | `all` (+ completions).
`claudeCodeNotify.ntfyServer`: change only if you self-host ntfy.
The hook reads `~/.claude-code-notify/config.json`, which the extension keeps in sync with these settings.

## Also
- *Completed* rows and the tooltip show a preview of Claude's last message, so you can triage from the list.
- Sessions disappear when their `claude` process exits (`SessionEnd` hook + liveness check), so no stale rows.
- **Nag mode**: `claudeCodeNotify.nagIntervalMinutes` (default 0/off) repeats the attention sound every N minutes
  while something is still unanswered — once per interval, no matter how many windows are open.
- **Jump to next**: `Ctrl+Cmd+C` (Mac) / `Ctrl+Alt+C` focuses the oldest session waiting for approval (or the latest
  completion). `Ctrl+Cmd+Shift+C` / `Ctrl+Alt+Shift+C` opens the list. Rebind under Keyboard Shortcuts → "Claude Code Notify".

## Commands (Cmd+Shift+P → "Claude Code Notify")
Show Sessions · Jump to Next · Send Test Phone Push · Toggle Mute · Clear List · Test 'Needs Attention' Event · Test 'Complete' Event

## Settings
`claudeCodeNotify.attentionSound`, `completeSound` (macOS built-ins: `/System/Library/Sounds/`), `volume`,
`showStatusBar`, `showToast` (toast with an Open button), `focusTerminalOnWindowFocus`, `dismissOnView`,
`autoReadDelay`, `nagIntervalMinutes`.
