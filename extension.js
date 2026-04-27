const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONTEXT_DIR = path.join(os.tmpdir(), 'pi-vscode-file-context');
const MAX_SELECTION_CHARS = 64 * 1024;
const WRITE_DEBOUNCE_MS = 50;

let contextFile;
let writeTimer;
let statusItem;

function workspaceFolders() {
  return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

function workspaceId() {
  const folders = workspaceFolders();
  const basis = folders.length ? folders.join('|') : 'no-workspace';
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

function isFileUri(uri) {
  return uri && uri.scheme === 'file';
}

function pos(p) {
  return { line: p.line + 1, character: p.character + 1 };
}

function activeFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isFileUri(editor.document.uri)) return undefined;

  const active = {
    path: editor.document.uri.fsPath,
    languageId: editor.document.languageId,
    isDirty: editor.document.isDirty,
    cursor: pos(editor.selection.active),
  };

  if (!editor.selection.isEmpty) {
    let text;
    if (vscode.workspace.isTrusted) {
      text = editor.document.getText(editor.selection);
      if (text.length > MAX_SELECTION_CHARS) {
        text = text.slice(0, MAX_SELECTION_CHARS) + `\n\n[truncated at ${MAX_SELECTION_CHARS} chars]`;
      }
    }

    active.selection = {
      start: pos(editor.selection.start),
      end: pos(editor.selection.end),
      isEmpty: false,
      text,
    };
  } else {
    active.selection = {
      start: pos(editor.selection.active),
      end: pos(editor.selection.active),
      isEmpty: true,
    };
  }

  return active;
}

function openFiles() {
  const files = [];
  const seen = new Set();
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;

  const addUri = (uri) => {
    if (!isFileUri(uri) || seen.has(uri.fsPath)) return;
    seen.add(uri.fsPath);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    files.push({
      path: uri.fsPath,
      languageId: doc?.languageId,
      isDirty: doc?.isDirty,
      isActive: uri.fsPath === active,
    });
  };

  if (vscode.window.tabGroups && vscode.TabInputText) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) addUri(tab.input.uri);
      }
    }
  }

  for (const editor of vscode.window.visibleTextEditors) addUri(editor.document.uri);
  return files;
}

function contextPayload() {
  return {
    version: 1,
    updatedAt: Date.now(),
    pid: process.pid,
    workspaceFolders: workspaceFolders(),
    isTrusted: vscode.workspace.isTrusted,
    activeFile: activeFile(),
    openFiles: openFiles(),
  };
}

function lineLabel(active) {
  if (!active) return 'no file';
  const name = path.basename(active.path);
  const sel = active.selection;
  if (sel && !sel.isEmpty) {
    const start = sel.start.line;
    const end = sel.end.line;
    return `${name} ${start === end ? `L${start}` : `L${start}:${end}`}`;
  }
  return active.cursor ? `${name} L${active.cursor.line}` : name;
}

function updateStatus(payload) {
  if (!statusItem) return;
  statusItem.text = `$(file-code) ${lineLabel(payload.activeFile)}`;
  statusItem.tooltip = contextFile ? `Pi context: ${contextFile}` : 'Pi context';
  statusItem.show();
}

function writeNow() {
  try {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true, mode: 0o700 });
    const payload = contextPayload();
    const tmp = `${contextFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, contextFile);
    try { fs.chmodSync(contextFile, 0o600); } catch {}
    updateStatus(payload);
  } catch (err) {
    console.error('Pi VS Code File Context: failed to write context', err);
  }
}

function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = undefined;
    writeNow();
  }, WRITE_DEBOUNCE_MS);
}

function activate(context) {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true, mode: 0o700 });
  contextFile = path.join(CONTEXT_DIR, `context-${workspaceId()}.json`);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'piVscodeFileContext.showPath';
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('piVscodeFileContext.showPath', () => {
      vscode.window.showInformationMessage(`Pi context file: ${contextFile}`);
    }),
    vscode.window.onDidChangeActiveTextEditor(scheduleWrite),
    vscode.window.onDidChangeTextEditorSelection(scheduleWrite),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const active = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (event.document.uri.fsPath === active) scheduleWrite();
    }),
    vscode.workspace.onDidSaveTextDocument(scheduleWrite),
    vscode.workspace.onDidOpenTextDocument(scheduleWrite),
    vscode.workspace.onDidCloseTextDocument(scheduleWrite),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      contextFile = path.join(CONTEXT_DIR, `context-${workspaceId()}.json`);
      scheduleWrite();
    }),
  );

  if (vscode.window.tabGroups?.onDidChangeTabs) {
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(scheduleWrite));
  }

  writeNow();
}

function deactivate() {
  if (writeTimer) clearTimeout(writeTimer);
  if (contextFile) {
    try { fs.unlinkSync(contextFile); } catch {}
  }
  if (statusItem) statusItem.dispose();
}

module.exports = { activate, deactivate };
