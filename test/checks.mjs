/**
 * 沙箱验证：桩掉 harness 包，真实调用 Kimi 联网搜索接口，检查 provider 的行为。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apply, readKimiCliCredential, tomlSectionValue, mapSearchResults, PROVIDER_ID } from './index.js';

let failures = 0;
function check(label, ok, extra = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
	if (!ok) failures += 1;
}

function makeCtx(credentials) {
	const captured = {};
	return {
		captured,
		ctx: {
			get: (name) => {
				if (name === 'credentials') return credentials;
				return undefined;
			},
			web: { registerSearchProvider: (p) => { captured.provider = p; } }
		}
	};
}

function makeConfig(overrides = {}) {
	const values = {
		apiKey: undefined,
		apiKeyEnv: 'MOONSHOT_API_KEY',
		baseURL: 'https://api.moonshot.cn/v1/tools/search',
		timeoutSeconds: 20,
		includeContent: false,
		defaultLimit: 10,
		readKimiCliConfig: true,
		...overrides
	};
	const wrap = {};
	for (const [k, v] of Object.entries(values)) wrap[k] = { get: () => v };
	return wrap;
}

// 1. TOML 段落读取（真实文件）
const kimiConfigPath = join(homedir(), '.kimi-code/config.toml');
let raw = '';
try { raw = await readFile(kimiConfigPath, 'utf8'); } catch {}
if (raw.length > 0) {
	const key = tomlSectionValue(raw, 'services.moonshot_search', 'api_key');
	const url = tomlSectionValue(raw, 'services.moonshot_search', 'base_url');
	check('从 ~/.kimi-code/config.toml 读出 search api_key', typeof key === 'string' && key.startsWith('sk-'), `len=${key?.length}`);
	check('读出 base_url', url === 'https://api.moonshot.cn/v1/tools/search', url);
	check('不会串到其它段落的键', tomlSectionValue(raw, 'services.moonshot_fetch', 'base_url') === 'https://api.moonshot.cn/v1/tools/fetch');
	check('不存在的段落返回 undefined', tomlSectionValue(raw, 'services.nope', 'api_key') === undefined);
} else {
	console.log('SKIP  ~/.kimi-code/config.toml 不存在');
}

// 2. 结果映射：去重 / 过滤非 http(s) / 省略空字段
const mapped = mapSearchResults({ search_results: [
	{ url: 'https://a.example/1', title: ' T1 ', snippet: 's1', date: '2026-01-01' },
	{ url: 'https://a.example/1', title: 'dup', snippet: 'x', date: '' },
	{ url: '/relative', title: 'bad', snippet: '', date: '' },
	{ url: '', title: 'empty', snippet: '', date: '' },
	{ url: 'https://b.example/2', title: '', snippet: '', date: '' }
] });
check('映射去重 + 丢弃非 http(s)', mapped.length === 2, JSON.stringify(mapped));
check('title 去空格、date → publishedAt', mapped[0].title === 'T1' && mapped[0].publishedAt === '2026-01-01');
check('空 title/snippet/date 不产生字段', Object.keys(mapped[1]).join(',') === 'url', Object.keys(mapped[1]).join(','));

// 3. 真实搜索（凭据服务为空 → 走 kimi-code 兜底）
const { ctx, captured } = makeCtx({ resolve: async () => undefined });
apply(ctx, makeConfig());
const provider = captured.provider;
check('已注册提供方且 id 正确', provider !== undefined && provider.id === PROVIDER_ID, provider?.id);
check('available() 为真', provider.available() === true);

const result = await provider.search({ query: 'DeepSeek Harness 插件市场', maxResults: 3 });
check('真实搜索返回 3 条来源', result.sources.length === 3, `got=${result.sources.length}`);
check('来源字段形状符合 seam', result.sources.every((s) => typeof s.url === 'string' && /^https?:\/\//.test(s.url)), JSON.stringify(result.sources.map((s) => s.url)));
check('truncated 为 false（截断由接缝负责）', result.truncated === false);
console.log('     示例来源:', JSON.stringify(result.sources[0]).slice(0, 220));

// 4. 凭据优先级：字面值优先
const lit = makeCtx(undefined);
apply(lit.ctx, makeConfig({ apiKey: 'sk-not-a-real-key' }));
const litProvider = lit.captured.provider;
let literalOutcome = 'error';
try {
	await litProvider.search({ query: 'x', maxResults: 1 });
	literalOutcome = 'ok';
} catch (error) {
	literalOutcome = `${error.code}`;
}
check('字面值 Key 被送去鉴权（预期 401 而不是缺凭据）', literalOutcome === 'WEB_PROVIDER_CREDENTIAL_MISSING', literalOutcome);

// 5. 缺凭据：读不到 kimi 配置时给出凭据错误
const noKey = makeCtx({ resolve: async () => undefined });
apply(noKey.ctx, makeConfig({ readKimiCliConfig: false }));
let noKeyOutcome = 'ok';
try {
	await noKey.captured.provider.search({ query: 'x' });
} catch (error) {
	noKeyOutcome = error.code;
}
check('无任何 Key 时报 WEB_PROVIDER_CREDENTIAL_MISSING', noKeyOutcome === 'WEB_PROVIDER_CREDENTIAL_MISSING', noKeyOutcome);

// 6. 端点错误：指向不存在的路径时是 WEB_PROVIDER_ERROR 且带端点说明
const badUrl = makeCtx({ resolve: async () => undefined });
apply(badUrl.ctx, makeConfig({ baseURL: 'https://api.moonshot.cn/v1/tools/search-pro' }));
let badOutcome = { code: 'ok', message: '' };
try {
	await badUrl.captured.provider.search({ query: 'x' });
} catch (error) {
	badOutcome = { code: error.code, message: error.message };
}
check('错误端点报 WEB_PROVIDER_ERROR', badOutcome.code === 'WEB_PROVIDER_ERROR', badOutcome.code);
check('错误信息里带上了实际端点', badOutcome.message.includes('https://api.moonshot.cn/v1/tools/search-pro'));
console.log('     错误正文:', badOutcome.message.split('\n')[0]);

// 7. 取消：已中止的信号不该发起请求
const aborted = new AbortController();
aborted.abort(new Error('test abort'));
let abortCode = 'ok';
try {
	await provider.search({ query: 'x' }, aborted.signal);
} catch (error) {
	abortCode = error.code;
}
check('已中止的信号报 WEB_ABORTED', abortCode === 'WEB_ABORTED', abortCode);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
