import * as vscode from 'vscode';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

// Promisified wrapper for spawning git commands without direct callback usage.
const execFileAsync = promisify(execFile);
// Upper bound for each collected git section to keep prompts bounded.
const MAX_SECTION_LENGTH = 3000;
// Soft cap for git stdout when we stream output to avoid buffer exhaustion.
const GIT_STDOUT_SOFT_LIMIT = 40000;

type GitRepositoryLike = {
	rootUri?: vscode.Uri;
	inputBox?: { value: string };
	ui?: { selected?: boolean };
};

type CopilotClientLike = {
	start(): Promise<void>;
	stop(): Promise<Error[]>;
	forceStop?(): Promise<void>;
	getAuthStatus?(): Promise<{
		isAuthenticated: boolean;
		authType?: string;
		login?: string;
		statusMessage?: string;
	}>;
	createSession(config?: { model?: string; reasoningEffort?: string; onPermissionRequest: unknown }): Promise<CopilotSessionLike>;
};

type CopilotSessionLike = {
	sendAndWait(arg: { prompt: string }): Promise<unknown>;
	disconnect(): Promise<void>;
};

type WorkspaceClientEntry = {
	workspaceDir: string;
	cliPath: string;
	ready: Promise<CopilotClientLike>;
	client?: CopilotClientLike;
};

class CopilotClientPool {
	private readonly clients = new Map<string, WorkspaceClientEntry>();
	private readonly notifiedWorkspaces = new Set<string>();

	constructor(
		private readonly debug: (message: string) => void,
		private readonly output: vscode.OutputChannel,
	) {}

	async getClient(workspaceDir: string): Promise<CopilotClientLike> {
		const key = normalizeFsPath(workspaceDir);
		const cliPath = resolveCopilotCliPath();
		const existing = this.clients.get(key);
		if (existing && existing.cliPath === cliPath) {
			return existing.ready;
		}

		if (existing) {
			this.clients.delete(key);
			void this.stopEntry(existing);
		}

		const entry: WorkspaceClientEntry = {
			workspaceDir,
			cliPath,
			ready: Promise.resolve(undefined as never),
		};

		entry.ready = (async () => {
			const { CopilotClient } = await import('@github/copilot-sdk');
			const client = new CopilotClient({ cwd: workspaceDir, cliPath }) as CopilotClientLike;
			entry.client = client;
			this.debug(`warming copilot client: workspaceDir=${workspaceDir} cliPath=${cliPath}`);
			await client.start();
			this.debug(`copilot client started: workspaceDir=${workspaceDir}`);

			if (typeof client.getAuthStatus === 'function') {
				try {
					const authStatus = await client.getAuthStatus();
					this.debug(
						`copilot auth status: authenticated=${authStatus.isAuthenticated} authType=${authStatus.authType ?? '(n/a)'} login=${authStatus.login ?? '(n/a)'}`,
					);
					// if (authStatus.isAuthenticated && !this.notifiedWorkspaces.has(key)) {
					// 	this.notifiedWorkspaces.add(key);
					// 	const loginName = authStatus.login ? ` (${authStatus.login})` : '';
					// 	const message = isJapanese()
					// 		? `GitHub Copilot にログイン済みです${loginName}`
					// 		: `GitHub Copilot is already signed in${loginName}`;
					// 	this.output.appendLine(message);
					// 	vscode.window.setStatusBarMessage(message, 5000);
					// }
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.debug(`copilot auth status check failed: ${message}`);
				}
			}

			return client;
		})().catch(async (error) => {
			this.clients.delete(key);
			throw error;
		});

		this.clients.set(key, entry);
		return entry.ready;
	}

	prefetchCurrentWorkspace(): void {
		void (async () => {
			const workspaceDir = await resolveWorkspaceDirectory();
			if (!workspaceDir) {
				return;
			}
			await this.getClient(workspaceDir);
		})().catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			this.debug(`copilot prewarm failed: ${message}`);
		});
	}

	async dispose(): Promise<void> {
		const entries = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(entries.map(entry => this.stopEntry(entry)));
	}

	private async stopEntry(entry: WorkspaceClientEntry): Promise<void> {
		try {
			const client = await entry.ready;
			const errors = await client.stop();
			if (errors.length > 0) {
				this.debug(
					`copilot stop cleanup errors for workspaceDir=${entry.workspaceDir}: ${errors.map(error => error.message).join('; ')}`,
				);
				await client.forceStop?.();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.debug(`copilot stop failed for workspaceDir=${entry.workspaceDir}: ${message}`);
			try {
				await entry.client?.forceStop?.();
			} catch (stopError) {
				const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
				this.debug(`copilot fallback forceStop failed for workspaceDir=${entry.workspaceDir}: ${stopMessage}`);
			}
		}
	}
}

let clientPool: CopilotClientPool | undefined;

const M = {
	status: {
		processing: () => (isJapanese() ? '$(sync~spin) コミットメッセージを生成しています...' : '$(sync~spin) Generating commit message...'),
	},
	commitArea: {
		copilotApi: () => (isJapanese() ? 'GitHub Copilot SDK 経由でコミットメッセージをコピーしました。' : 'Copied commit message via GitHub Copilot SDK.'),
		copiedScm: () => (isJapanese() ? 'SCM inputBox にコミットメッセージをコピーしました。' : 'Copied commit message to SCM input box.'),
		warnNoAccess: () => (isJapanese() ? 'コミットメッセージ欄にアクセスできませんでした。' : 'Unable to access commit message input.'),
		errorSet: (e: string) => (isJapanese() ? `コミットメッセージの設定に失敗しました: ${e}` : `Failed to set commit message: ${e}`),
	},
	errors: {
		noResult: () => (isJapanese() ? 'GitHub Copilot から有効なコミットメッセージを受信できませんでした。' : 'No valid commit message was received from GitHub Copilot.'),
		failed: (e: string) => (isJapanese() ? `GitHub Copilot の実行に失敗しました: ${e}` : `Failed to run GitHub Copilot: ${e}`),
	},
};

export async function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('commit message gene by ghcopilot');
	const statusSpinner = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
	context.subscriptions.push(output, statusSpinner);
	const debugEnabled = process.env.COMMIT_MESSAGE_GENE_DEBUG === '1';

	const debug = (message: string) => {
		void message;
		if (!debugEnabled) {
			return;
		}
		// console.log(`[debug] ${message}`);
		// output.appendLine(`[debug] ${message}`);
	};

	clientPool = new CopilotClientPool(debug, output);
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => {
			clientPool?.prefetchCurrentWorkspace();
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			clientPool?.prefetchCurrentWorkspace();
		}),
	);
	clientPool.prefetchCurrentWorkspace();

	// Register the command that gathers git context, queries Copilot, and updates the SCM input.
	const disposable = vscode.commands.registerCommand('commit-message-gene-by-ghcopilot.runCopilotCmd', async () => {
		let session: CopilotSessionLike | undefined;

		try {
			debug(`extension start: node=${process.version} platform=${process.platform} cwd=${process.cwd()}`);
			debug(`env COPILOT_CLI_PATH=${process.env.COPILOT_CLI_PATH ?? '(unset)'}`);
			const workspaceDir = await resolveWorkspaceDirectory();
			if (!workspaceDir) {
				vscode.window.showErrorMessage('No workspace folder is open, so Git context cannot be gathered.');
				return;
			}
			debug(`workspaceDir=${workspaceDir}`);

			statusSpinner.text = M.status.processing();
			statusSpinner.show();

			const gitPath = await resolveGitPath();
			debug(`resolved gitPath=${gitPath}`);
			const [client, gitContext] = await Promise.all([
				clientPool?.getClient(workspaceDir) ?? Promise.reject(new Error('Copilot client pool is not available.')),
				collectGitContext(workspaceDir, gitPath),
			]);
			debug(`gitContext length=${gitContext.length}`);
			const prompt = buildPrompt(gitContext);
			debug(`prompt length=${prompt.length}`);

			const { approveAll } = await import('@github/copilot-sdk');
			try {
				session = await client.createSession({
					model: 'gpt-5-mini',
					reasoningEffort: 'low',
					onPermissionRequest: approveAll,
				});
			} catch {
				// If the specified model or reasoningEffort is not supported, fall back to
				// the user's default Copilot settings (no model or reasoningEffort specified).
				session = await client.createSession({
					onPermissionRequest: approveAll,
				});
			}
			if (!session) {
				throw new Error('Failed to create a GitHub Copilot session.');
			}
			debug('copilot session created');

			const result = await session.sendAndWait({ prompt });
			debug(`sendAndWait completed: ${describeResult(result)}`);
			let finalMessage = extractGeneratedMessage(result)?.trim();
			debug(`finalMessage length=${finalMessage?.length ?? 0}`);

			if (finalMessage) {
				// If the response is wrapped in triple backticks, strip them first.
				if (finalMessage.startsWith('```') && finalMessage.endsWith('```')) {
					finalMessage = finalMessage.slice(3, -3).trim();
				}
				// If the response is wrapped in single backticks, strip them first.
				else if (finalMessage.startsWith('`') && finalMessage.endsWith('`')) {
					finalMessage = finalMessage.slice(1, -1).trim();
				}
				// If the response is wrapped in bold markers, strip them first.
				else if (finalMessage.startsWith('**') && finalMessage.endsWith('**')) {
					finalMessage = finalMessage.slice(2, -2).trim();
				}

				await setCommitMessage(finalMessage, output, workspaceDir);
			} else {
				reportError(M.errors.noResult(), output);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			debug(`error: ${message}`);
			reportError(M.errors.failed(message), output);
		} finally {
			try {
				await session?.disconnect();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				output.appendLine(M.commitArea.errorSet(message));
			}
			statusSpinner.hide();
			statusSpinner.text = '';
		}
	});

	context.subscriptions.push(disposable);
}

export async function deactivate() {
	if (!clientPool) {
		return;
	}
	await clientPool.dispose();
	clientPool = undefined;
}

function resolveCopilotCliPath(): string {
	if (process.env.COPILOT_CLI_PATH?.trim()) {
		return process.env.COPILOT_CLI_PATH.trim();
	}

	const packageName = getCopilotCliPackageName();
	return require.resolve(packageName);
}

function getCopilotCliPackageName(): string {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === 'win32') {
		return '@github/copilot-win32-x64';
	}

	throw new Error(`Unsupported platform for Copilot CLI: ${platform}-${arch}`);
}


function describeResult(result: unknown): string {
	if (!result || typeof result !== 'object') {
		return typeof result;
	}
	const candidate = result as { type?: unknown; data?: { content?: unknown } };
	const type = typeof candidate.type === 'string' ? candidate.type : 'object';
	const content = typeof candidate.data?.content === 'string' ? candidate.data.content : '';
	return content ? `${type} contentLen=${content.length}` : type;
}

// Safely copy the generated message into the most relevant SCM commit input.
async function setCommitMessage(message: string, output: vscode.OutputChannel, workspaceDir?: string) {
	try {
		// Activate the SCM view so the input box is available.
		await vscode.commands.executeCommand('workbench.view.scm');
		// Retrieve the Git extension API if it exists.
		const gitApi = await getGitApi();
		if (gitApi) {
			const repos = (gitApi.repositories ?? []) as GitRepositoryLike[];
			const targetRepo = selectRepositoryForCommit(repos, workspaceDir);
			if (targetRepo?.inputBox) {
				targetRepo.inputBox.value = message;
				output.appendLine(M.commitArea.copilotApi());
				return;
			}
		}
		// Fallback: scm.inputBox
		const scmAny = vscode.scm as any;
		if (scmAny && scmAny.inputBox) {
			scmAny.inputBox.value = message;
			output.appendLine(M.commitArea.copiedScm());
			return;
		}
		output.appendLine(M.commitArea.warnNoAccess());
	} catch (e: any) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		output.appendLine(M.commitArea.errorSet(errorMessage));
	}
}

// Locate the repository whose commit input should be updated, prioritising context matches first.
function selectRepositoryForCommit(repos: GitRepositoryLike[], workspaceDir?: string) {
	if (!repos || repos.length === 0) {
		return undefined;
	}

	if (workspaceDir) {
		const byContext = findRepoByFsPath(repos, workspaceDir);
		if (byContext) {
			return byContext;
		}
	}

	const selected = repos.find(repo => repo?.ui?.selected);
	if (selected) {
		return selected;
	}

	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
		if (activeFolder?.uri?.fsPath) {
			const byActive = findRepoByFsPath(repos, activeFolder.uri.fsPath);
			if (byActive) {
				return byActive;
			}
		}
	}

	return repos[0];
}

// Prepare filesystem paths for reliable equality checks across platforms.
function normalizeFsPath(fsPath: string): string {
	const normalized = path.normalize(fsPath);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// Retrieve a repository whose root matches the provided filesystem path.
function findRepoByFsPath(repos: GitRepositoryLike[], targetFsPath: string) {
	const normalizedTarget = normalizeFsPath(targetFsPath);
	return repos.find(repo => repo?.rootUri?.fsPath && normalizeFsPath(repo.rootUri.fsPath) === normalizedTarget);
}

// Report failure to both the output channel and a toast without touching SCM text.
function reportError(message: string, output: vscode.OutputChannel) {
	output.appendLine(message);
	vscode.window.showErrorMessage(message);
}

// Fetch and return the Git extension API, activating the extension lazily if needed.
async function getGitApi(): Promise<any | undefined> {
	const gitExt = vscode.extensions.getExtension('vscode.git');
	if (!gitExt) {
		return undefined;
	}
	const exportsAny = gitExt.isActive ? (gitExt.exports as any) : await gitExt.activate();
	return typeof exportsAny?.getAPI === 'function' ? exportsAny.getAPI(1) : exportsAny;
}

// Resolve the git binary path from VS Code's Git extension to avoid PATH dependency.
async function resolveGitPath(): Promise<string> {
	const gitApi = await getGitApi();
	const resolvedPath: string | undefined = gitApi?.git?.path;
	if (resolvedPath) {
		return resolvedPath;
	}
	// Fallback: assume git is on PATH (should not normally happen in VS Code)
	return 'git';
}

// Determine which repository the extension should treat as the working directory.
async function resolveWorkspaceDirectory(): Promise<string | undefined> {
	const gitApi = await getGitApi();
	const repos = (gitApi?.repositories ?? []) as GitRepositoryLike[];
	const selectedRepo = repos.find(repo => repo?.ui?.selected);
	if (selectedRepo?.rootUri?.fsPath) {
		return selectedRepo.rootUri.fsPath;
	}

	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		// Prefer the folder that contains the active editor's file.
		const containingWorkspace = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
		if (containingWorkspace?.uri?.fsPath) {
			return containingWorkspace.uri.fsPath;
		}
	}

	if (repos.length > 0 && repos[0]?.rootUri?.fsPath) {
		return repos[0].rootUri.fsPath;
	}

	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// Run a git subcommand and return trimmed stdout or throw a descriptive error.
async function runGitCommand(args: string[], cwd: string, options?: { softLimit?: number; gitPath?: string }): Promise<string> {
	const git = options?.gitPath ?? 'git';
	if (options?.softLimit) {
		return runGitCommandWithSoftLimit(args, cwd, options.softLimit, git);
	}
	try {
		const { stdout } = await execFileAsync(git, args, { cwd, maxBuffer: 1024 * 1024 * 20 });
		return stdout.trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to run git ${args.join(' ')}: ${message}`);
	}
}

function isHeadMissingError(message: string): boolean {
	return /ambiguous argument 'HEAD'/i.test(message) || /unknown revision/i.test(message) || /does not have any commits yet/i.test(message);
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Gather the git facts the model needs to craft a conventional commit message.
async function collectGitContext(cwd: string, gitPath: string): Promise<string> {
	const opts = { gitPath };
	const gitVersion = await runGitCommand(['--version'], cwd, opts);
	const repoRoot = await runGitCommand(['rev-parse', '--show-toplevel'], cwd, opts);
	const branch = await (async () => {
		try {
			return await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, opts);
		} catch (error) {
			const message = toErrorMessage(error);
			if (isHeadMissingError(message)) {
				return 'No commits yet (HEAD not created)';
			}
			throw error;
		}
	})();
	const status = await runGitCommand(['status', '--short', '--branch'], cwd, opts);
	const stagedDiff = await runGitCommand(['diff', '--cached', '--color=never'], cwd, { softLimit: GIT_STDOUT_SOFT_LIMIT, ...opts });
	let diffSectionTitle = 'Staged diff';
	let diffBody = stagedDiff;
	if (!diffBody) {
		diffSectionTitle = 'Working tree diff (no staged changes)';
		diffBody = await runGitCommand(['diff', '--color=never'], cwd, { softLimit: GIT_STDOUT_SOFT_LIMIT, ...opts });
	}
	const untrackedFiles = await runGitCommand(['ls-files', '--others', '--exclude-standard'], cwd, opts);
	const recentCommits = await (async () => {
		try {
			return await runGitCommand(['log', '--oneline', '-5'], cwd, opts);
		} catch (error) {
			const message = toErrorMessage(error);
			if (isHeadMissingError(message)) {
				return 'No commits yet';
			}
			throw error;
		}
	})();

	return [
		formatSection('Git version', gitVersion),
		formatSection('Repository root', repoRoot),
		formatSection('Current branch', branch),
		formatSection('Status (--short --branch)', status),
		formatSection(diffSectionTitle, diffBody),
		formatSection('Untracked files', untrackedFiles),
		formatSection('Recent commits', recentCommits),
	].join('\n\n');
}

// Wrap a single git data section and ensure bounded length.
function formatSection(title: string, body: string): string {
	const safeBody = truncateForPrompt(body || 'N/A', MAX_SECTION_LENGTH);
	return `### ${title}\n${safeBody}`;
}

// Apply a hard cap to command output so the prompt remains digestible.
function truncateForPrompt(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, limit)}\n... (truncated to ${limit} chars)`;
}

// Language detection: whether the VS Code UI language is Japanese.
function isJapanese(): boolean {
	const lang = (vscode.env.language || '').toLowerCase();
	return lang === 'ja' || lang.startsWith('ja-');
}

// Craft the instruction set for the model, switching language based on UI locale.
const DEFAULT_INTRO_EN = [
	'You are an assistant that drafts commit messages using the provided Git information.',
	'All required Git data has already been collected below. Do not run additional git commands.',
	'Follow the Conventional Commits style (type(scope?): subject) for the summary line and add a body only if it helps explain the change. Write the message in English. Do not use Markdown syntax; write in plain text.',
	'Return only the final commit message proposal.'
];

const DEFAULT_INTRO_JA = [
	'あなたは収集されたGit情報でコミットメッセージを作成するアシスタントです。',
	'必要なGitデータはすべて下に用意済みです。追加のgitコマンドは実行しないでください。',
	'サマリー行はConventional Commitsスタイル（type(scope?): subject）に従い、必要な場合のみ本文を追加してください。コミットメッセージは日本語で記述してください。Markdown表記は使わずプレーンなテキストで記述してください。',
	'最終的なコミットメッセージ案だけを返してください。'
];

function buildPrompt(gitContext: string): string {
	const config = vscode.workspace.getConfiguration();
	const japanese = isJapanese();
	const configKey = japanese ? 'commitMessageGeneByGhcopilot.prompt.intro.ja' : 'commitMessageGeneByGhcopilot.prompt.intro.en';
	const defaultIntro = japanese ? DEFAULT_INTRO_JA : DEFAULT_INTRO_EN;
	const configuredIntro = config.get<string[]>(configKey);
	const resolvedIntro = Array.isArray(configuredIntro)
		? configuredIntro
			.map((line) => (typeof line === 'string' ? line.trim() : ''))
			.filter((line) => line.length > 0)
		: [];
	const introLines = resolvedIntro.length > 0 ? resolvedIntro : defaultIntro;

	return [...introLines, gitContext].join('\n\n');
}

function extractGeneratedMessage(result: unknown): string | undefined {
	if (typeof result === 'string') {
		return result;
	}
	if (!result || typeof result !== 'object') {
		return undefined;
	}

	const candidate = result as {
		finalResponse?: unknown;
		content?: unknown;
		data?: { content?: unknown };
		message?: { content?: unknown };
		messages?: Array<{ role?: string; content?: unknown }>;
	};

	if (typeof candidate.finalResponse === 'string') {
		return candidate.finalResponse;
	}
	if (typeof candidate.content === 'string') {
		return candidate.content;
	}
	if (typeof candidate.data?.content === 'string') {
		return candidate.data.content;
	}
	if (typeof candidate.message?.content === 'string') {
		return candidate.message.content;
	}
	if (Array.isArray(candidate.messages)) {
		for (let i = candidate.messages.length - 1; i >= 0; i -= 1) {
			const entry = candidate.messages[i];
			if (entry?.role === 'assistant' && typeof entry.content === 'string') {
				return entry.content;
			}
		}
	}

	return undefined;
}

// Stream git stdout while enforcing a soft character limit to prevent buffer overruns.
async function runGitCommandWithSoftLimit(args: string[], cwd: string, limit: number, gitPath: string = 'git'): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(gitPath, args, { cwd });
		let stdout = '';
		let stderr = '';
		let truncated = false;
		let settled = false;

		const finishSuccess = (value: string) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(value);
		};

		const finishFailure = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			reject(error);
		};

		const appendStdout = (chunk: Buffer | string) => {
			if (truncated) {
				return;
			}
			const text = chunk.toString();
			if (stdout.length + text.length > limit) {
				const remaining = Math.max(limit - stdout.length, 0);
				if (remaining > 0) {
					stdout += text.slice(0, remaining);
				}
				truncated = true;
				child.kill('SIGTERM');
			} else {
				stdout += text;
			}
		};

		child.stdout.on('data', appendStdout);
		child.stderr.on('data', chunk => {
			if (!truncated) {
				stderr += chunk.toString();
			}
		});

		child.on('error', err => {
			const message = err instanceof Error ? err.message : String(err);
			finishFailure(new Error(`Failed to run git ${args.join(' ')}: ${message}`));
		});

		child.on('close', (code, signal) => {
			if (truncated) {
				const suffix = `\n... (truncated to ${limit} chars)`;
				finishSuccess(`${stdout.trim()}${suffix}`.trim());
				return;
			}
			if (code === 0) {
				finishSuccess(stdout.trim());
				return;
			}
			const signalInfo = signal ? ` signal ${signal}` : '';
			const message = stderr.trim() || `exit code ${code ?? 'unknown'}${signalInfo}`;
			finishFailure(new Error(`Failed to run git ${args.join(' ')}: ${message}`));
		});
	});
}
