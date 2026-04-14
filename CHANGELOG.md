# Change Log

## 0.3.27

- Warmed up the Copilot client at startup and reused it per workspace so the first commit message generation feels faster.

## 0.3.26

- Clarified the README requirements so users know they should already have GitHub Copilot in VS Code or GitHub Copilot CLI installed and signed in before using the extension.

## 0.3.25

- Lowered the supported VS Code engine and `@types/vscode` compatibility to `^1.100.0` so the extension can work in older VS Code-compatible editors.

## 0.3.24

- Clarified in the README that the extension is primarily intended for VS Code-compatible editors such as Cursor, Kiro, VSCodium, and Antigravity.

## 0.3.23

- Switched commit message generation to `@github/copilot-sdk` 0.2.2.
- Updated the model used for commit message generation to `gpt-5-mini`.
