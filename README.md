[Japanese README](README.ja.md)

[![Version](https://img.shields.io/badge/version-v0.3.33-4094ff.svg)](https://marketplace.visualstudio.com/items?itemName=komiyamma.commit-message-gene-by-ghcopilot)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)
![Windows 10|11](https://img.shields.io/badge/Windows-_10_|_11-6479ff.svg?logo=windows&logoColor=white)

Primary target: VS Code-compatible editors such as Cursor, Kiro, VSCodium, and Antigravity.

# Commit Message Generator (by GitHub Copilot)

This extension automatically generates a Conventional Commits-style commit message from your repository changes and inserts it into the Source Control input box.  
It uses the GitHub Copilot SDK to collect a response from GitHub Copilot.

## Usage

- From the UI (recommended)
  - A button is added to the Source Control view title bar and near the commit input box. Click it to run “Commit message generation by GitHub Copilot.”
  - It appears when the Git provider is active.  
  [![Commit Input Box Button](images/button.png)](images/button.png)
  - While generating, the status bar shows “$(sync~spin) Generating commit message...” and it disappears automatically when finished.  
  [![Commit StatusBar](images/statusbar.png)](images/statusbar.png)
- From the Command Palette
  - Press `Ctrl+Shift+P` and type “Commit message generation by GitHub Copilot”.
  - Or run “Commit message generation by GitHub Copilot” (`commit-message-gene-by-ghcopilot.runCopilotCmd`) directly.
  - When finished, the generated message is inserted into the commit input box. You can check the execution log in the Output panel “commit message gene by ghcopilot”.

## Settings

This extension uses its own prompt settings namespace so it does not share values with the Codex variant.

- `commitMessageGeneByGhcopilot.prompt.intro.en`
- `commitMessageGeneByGhcopilot.prompt.intro.ja`

## Requirements

- Windows 10/11 with VS Code's Git extension enabled
- Source Control (SCM) view is open
- A GitHub Copilot subscription or another supported Copilot authentication method is signed in
- You need to have either GitHub Copilot in VS Code or GitHub Copilot CLI installed and signed in ahead of time. It is smoother if you already use one of them regularly.

## Notes

- Privacy: the extension itself does not send your code externally, but GitHub Copilot may send repository context to GitHub depending on your Copilot settings. Please review GitHub Copilot's policies.

## License

MIT License © 2025-2026 komiyamma
