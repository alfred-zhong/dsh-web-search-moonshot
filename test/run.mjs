/**
 * 在临时目录里搭一个「只有 harness 桩模块」的沙箱，把 index.js 与 checks.mjs 复制进去后运行。
 *
 * 这样自测不需要 DSH 进程：靠桩模块提供 `@deepseek-ai/*`，靠真实网络打 Kimi 接口。
 *
 * 用法：node test/run.mjs
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);

/** 各 harness 包在本测试里需要的最小行为。 */
const STUBS = {
	'schemastery': `function builder() {
	const api = {};
	for (const m of ['role', 'volatile', 'default', 'step', 'min', 'max', 'description']) api[m] = () => api;
	return api;
}
export default { object: () => builder(), string: () => builder(), number: () => builder(), boolean: () => builder() };
`,
	'dsh-credentials': `export const credentialRef = (v) => v;
export const isCredentialRefName = (v) => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
`,
	'dsh-launch-environment': `export const launchEnvironmentOf = () => ({ get: () => undefined });
`,
	'dsh-web': `export class WebError extends Error {
	constructor(message, code, options) { super(message, options); this.name = 'WebError'; this.code = code; }
}
`
};

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-web-search-moonshot-'));
try {
	for (const [name, source] of Object.entries(STUBS)) {
		const dir = join(sandbox, 'node_modules', '@deepseek-ai', name);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.0.0', type: 'module', main: 'index.js' }, null, 2));
		await writeFile(join(dir, 'index.js'), source);
	}
	await cp(join(packageDir, 'index.js'), join(sandbox, 'index.js'));
	await cp(join(here, 'checks.mjs'), join(sandbox, 'checks.mjs'));
	const run = spawnSync(process.execPath, ['checks.mjs'], { cwd: sandbox, stdio: 'inherit' });
	process.exitCode = run.status ?? 1;
} finally {
	await rm(sandbox, { recursive: true, force: true });
}
