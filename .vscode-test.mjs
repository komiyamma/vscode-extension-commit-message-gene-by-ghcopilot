import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	extensionDevelopmentPath: process.cwd(),
	workspaceFolder: process.cwd(),
});
