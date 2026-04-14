import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	test('command populates commit message input', async function () {
		this.timeout(120000);

		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		assert.ok(workspaceFolders.length > 0, 'expected at least one workspace folder');

		await vscode.commands.executeCommand('commit-message-gene-by-ghcopilot.runCopilotCmd');

		const scmInputValue = (vscode.scm as { inputBox?: { value?: string } }).inputBox?.value ?? '';
		const gitInputValue = await getGitCommitInputValue();
		console.log(`[test] scm input length=${scmInputValue.length}`);
		console.log(`[test] scm input value=${scmInputValue}`);
		console.log(`[test] git input length=${gitInputValue.length}`);
		console.log(`[test] git input value=${gitInputValue}`);

		assert.ok(Math.max(scmInputValue.length, gitInputValue.length) > 0, 'expected the SCM input box to be populated');
	});
});

async function getGitCommitInputValue(): Promise<string> {
	const gitExtension = vscode.extensions.getExtension('vscode.git');
	if (!gitExtension) {
		return '';
	}

	const exportsAny = gitExtension.isActive ? (gitExtension.exports as any) : await gitExtension.activate();
	const gitApi = typeof exportsAny?.getAPI === 'function' ? exportsAny.getAPI(1) : exportsAny;
	const repositories = (gitApi?.repositories ?? []) as Array<{ inputBox?: { value?: string } }>;
	return repositories.find(repo => typeof repo?.inputBox?.value === 'string')?.inputBox?.value ?? '';
}
