# Change Log

## 0.3.41

- Tuned the internal Git context and prompt limits for commit message generation so larger diffs stay useful while the overall prompt remains compact and the Git output buffer stays stable.

## 0.3.40

- Adjusted the internal Git context collection limits so commit message generation stays stable on larger changes without overflowing the Git output buffer.

## 0.3.39

- Added a safeguard so generated commit messages no longer include co-authorship trailers such as `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## 0.3.37

- Commented out the remaining debug output so normal use no longer spams the Output panel.

## 0.3.36

- Clarified the extension description so it now refers to the GitHub Copilot environment instead of the Codex environment.

## 0.3.34

- Excluded the logo PSD from the distribution package so the published extension no longer ships that unused asset.

## 0.3.33

- Removed the proposed API declaration so the extension no longer requires `contribSourceControlInputBoxMenu` during installation or activation.

## 0.3.32

- Simplified the Copilot CLI package lookup so Windows now always uses the `@github/copilot-win32-x64` package, matching the extension's supported environment.

## 0.3.31

- Separated the prompt setting keys from the Codex variant by moving them to the extension-specific `commitMessageGeneByGhcopilot.*` namespace, so this extension no longer shares those prompt settings with the Codex version.

## 0.3.29

- Warmed up the Copilot client at startup and reused it per workspace so the first commit message generation feels faster.
- Removed the temporary sign-in notification after Copilot auth checks so the output and status bar stay quiet.

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
