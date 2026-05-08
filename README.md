# Pi VS Code File Context

Continuously shares active VS Code file + selection with [pi](https://github.com/badlogic/pi-coding-agent) via a temp JSON file.

## What it does

- VS Code extension writes active file, cursor, selection range/text, and open file paths.
- Pi extension polls that file every 100ms.
- Pi footer shows current file/selection, e.g. `ArticleBody.tsx (main) / 8 lines selected`.
- The Pi extension uses Pi's standard extension status line, so VS Code context appears below the default footer.
- Pi auto-injects selected text into the next prompt.
- If nothing is selected, Pi injects only active file path + cursor.
- Toggle Pi-side context injection/status with `/vscode-context`.

## Security

- No network server
- No shell execution
- No telemetry
- Full file content is never written, only selected text
- `.env*` files are excluded from active/open file context and selection capture
- Selected text capped at 64KB
- Selection text omitted when VS Code workspace is untrusted
- Context file mode `0600`

## Install

### 1. Install Pi package

```bash
pi install git:github.com/je-boska/pi-vscode-file-context
```

Then restart pi or run:

```text
/reload
```

### 2. Install VS Code extension

Clone this repo, then:

```bash
cd pi-vscode-file-context
npx @vscode/vsce package
code --install-extension pi-vscode-file-context-0.1.0.vsix
```

Reload VS Code window.

## Context file

Writes to:

```text
$TMPDIR/pi-vscode-file-context/context-<workspace-hash>.json
```

Payload shape:

```json
{
  "version": 1,
  "updatedAt": 1710000000000,
  "workspaceFolders": ["/repo"],
  "isTrusted": true,
  "activeFile": {
    "path": "/repo/src/file.ts",
    "languageId": "typescript",
    "isDirty": false,
    "cursor": { "line": 12, "character": 3 },
    "selection": {
      "start": { "line": 12, "character": 1 },
      "end": { "line": 14, "character": 20 },
      "isEmpty": false,
      "text": "selected text"
    }
  },
  "openFiles": []
}
```
