/**
 * Moonshot / Kimi 联网搜索（Basic）作为 DSH `ctx.web` 的搜索提供方。
 *
 * 与内建的 `dsh-web-search-deepseek` 不同，这里不打 Messages 接口、不消耗模型轮次：
 * 直接把 `web_search` 工具的一次查询变成 Kimi 工具接口 `POST /v1/tools/search` 的一次调用，
 * 把返回的 `search_results[]` 映射成 seam 的 `WebSearchSource[]`。
 *
 * @module dsh-web-search-moonshot
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { WebError } from '@deepseek-ai/dsh-web';

/** 注册到 `ctx.web` 的稳定提供方 id。 */
export const PROVIDER_ID = 'moonshot';
/** Kimi 联网搜索 Basic 端点（`POST`，无 `/messages` 之类的后缀）。 */
export const DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1/tools/search';
/** 默认读取的凭据引用名。 */
export const DEFAULT_API_KEY_ENV = 'MOONSHOT_API_KEY';
/** 归属标头；随包版本更新。 */
const USER_AGENT = 'dsh-web-search-moonshot/0.1.0';
/** 接口自身的边界（见 platform.kimi.com/docs/api/tools-search）。 */
const MIN_LIMIT = 1;
const MAX_LIMIT = 20;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 60;
/** Kimi Code CLI 的配置：零配置安装时从这里兜底取 Key（只读，从不写回）。 */
const KIMI_CLI_CONFIG_FILES = ['.kimi-code/config.toml', '.kimi/config.toml'];
const KIMI_CLI_SEARCH_SECTION = 'services.moonshot_search';

/** 插件行 id，与 `cordis.patch.yml` 保持一致。 */
export const name = 'web-search-moonshot';
/** 本提供方注册进的能力接缝。 */
export const inject = ['web'];

/**
 * 按 TOML 段落读取一个字符串标量，避免为此引入 TOML 依赖。
 * 只认 `[section]` 之后、下一个段落之前、形如 `key = "value"` 的行。
 *
 * @param text - 配置文件全文。
 * @param section - 段落名，例如 `services.moonshot_search`。
 * @param key - 段落内的键名。
 * @returns 键值；段落或键不存在时为 `undefined`。
 */
export function tomlSectionValue(text, section, key) {
	const line = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
	let inSection = false;
	for (const raw of text.split(/\r?\n/u)) {
		const head = /^\s*\[([^\]]+)\]\s*$/u.exec(raw);
		if (head !== null) {
			inSection = head[1].trim() === section;
			continue;
		}
		if (!inSection) continue;
		const found = line.exec(raw);
		if (found !== null) return found[1] ?? found[2] ?? '';
	}
	return void 0;
}

/**
 * 从 Kimi Code CLI 的配置里取搜索 Key（及可选端点）。
 * 文件不存在、不可读或没有该段落时返回 `undefined`，绝不抛错。
 *
 * @returns 命中的 `{apiKey, baseURL}`，`baseURL` 可能为 `undefined`。
 */
export async function readKimiCliCredential(file = void 0) {
	for (const relative of file === void 0 ? KIMI_CLI_CONFIG_FILES : [file]) {
		let text;
		try {
			text = await readFile(join(homedir(), relative), 'utf8');
		} catch {
			continue;
		}
		const apiKey = tomlSectionValue(text, KIMI_CLI_SEARCH_SECTION, 'api_key');
		if (apiKey === void 0 || apiKey.length === 0) continue;
		const baseURL = tomlSectionValue(text, KIMI_CLI_SEARCH_SECTION, 'base_url');
		return { apiKey, ...baseURL !== void 0 && baseURL.length > 0 ? { baseURL } : {} };
	}
	return void 0;
}

/** 把结果条数夹到接口允许的范围内。 */
function clampLimit(value, fallback) {
	const numeric = Number.isInteger(value) ? value : fallback;
	if (!Number.isInteger(numeric)) return MIN_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, numeric));
}

/** 中止错误统一成 seam 的 `WEB_ABORTED`。 */
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw new WebError('Moonshot search aborted', 'WEB_ABORTED', { cause: signal.reason });
}

/** 只有绝对 http(s) 链接才进入结果；其余（空串、站内相对路径）丢弃。 */
function httpUrl(value) {
	return typeof value === 'string' && /^https?:\/\/\S+$/iu.test(value) ? value : void 0;
}

/**
 * 把 Kimi 的 `search_results[]` 映射成 `WebSearchSource[]`：URL 必填且去重，
 * `title` / `snippet` / `publishedAt`（取自 `date`）为空时省略字段而不是塞空串。
 *
 * @param payload - 接口返回的 JSON。
 * @returns 归一化后的来源列表。
 */
export function mapSearchResults(payload) {
	const rows = Array.isArray(payload?.search_results) ? payload.search_results : [];
	const seen = new Set();
	const sources = [];
	for (const row of rows) {
		const url = httpUrl(row?.url);
		if (url === void 0 || seen.has(url)) continue;
		seen.add(url);
		const title = typeof row.title === 'string' ? row.title.trim() : '';
		const snippet = typeof row.snippet === 'string' ? row.snippet.trim() : '';
		const date = typeof row.date === 'string' ? row.date.trim() : '';
		sources.push({
			url,
			...title.length > 0 ? { title } : {},
			...snippet.length > 0 ? { snippet } : {},
			...date.length > 0 ? { publishedAt: date } : {}
		});
	}
	return sources;
}

/**
 * Kimi 联网搜索提供方：每次搜索 = 一次工具接口调用，没有辅助模型轮次。
 */
export class MoonshotSearchProvider {
	id = PROVIDER_ID;
	/**
	 * @param resolveOptions - 取「本次操作」的选项快照；用函数是为了让设置改动对下一次搜索立刻生效。
	 */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}

	/** 端点可解析、上限合法即视为可用；缺 Key 会推迟到调用时报凭据错误。 */
	available() {
		const options = this.resolveOptions();
		return URL.canParse(options.baseURL) && Number.isInteger(options.timeoutSeconds) && Number.isInteger(options.defaultLimit);
	}

	/**
	 * 执行一次搜索。
	 *
	 * @param request - `{query, maxResults?}`。
	 * @param signal - 调用方的取消信号。
	 * @returns `{sources, truncated}`；`maxResults` 由接缝收敛，这里恒为 `false`。
	 */
	async search(request, signal) {
		const options = this.resolveOptions();
		const apiKey = await this.resolveApiKey(options, signal);
		const limit = clampLimit(request.maxResults, options.defaultLimit);
		const body = {
			text_query: request.query,
			limit,
			timeout_seconds: Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, options.timeoutSeconds))
		};
		if (options.includeContent) body.include_content = true;
		throwIfAborted(signal);
		options.recordRequest?.({ endpoint: options.baseURL, body });
		let response;
		try {
			response = await fetch(options.baseURL, {
				method: 'POST',
				redirect: 'error',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': 'application/json',
					accept: 'application/json',
					'user-agent': USER_AGENT
				},
				body: JSON.stringify(body),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (signal?.aborted === true || error?.name === 'AbortError') throw new WebError('Moonshot search aborted', 'WEB_ABORTED', { cause: error });
			throw searchEndpointError(options.baseURL, `Moonshot search request failed: ${String(error)}`, error);
		}
		if (!response.ok) {
			let detail = '';
			try {
				const parsed = await response.json();
				detail = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message ?? '';
			} catch {
				// 错误响应体不是 JSON：保留下面的状态码即可。
			}
			if (signal?.aborted === true) throw new WebError('Moonshot search aborted', 'WEB_ABORTED');
			if (response.status === 401) throw new WebError(`Moonshot search credential was rejected (HTTP 401)${detail.length > 0 ? `: ${detail}` : ''}; check the key resolved for "${options.apiKeyEnv}"`, 'WEB_PROVIDER_CREDENTIAL_MISSING');
			throw searchEndpointError(options.baseURL, `Moonshot search error (HTTP ${response.status})${detail.length > 0 ? `: ${detail}` : ''}`);
		}
		let payload;
		try {
			payload = await response.json();
		} catch (error) {
			if (signal?.aborted === true) throw new WebError('Moonshot search aborted', 'WEB_ABORTED', { cause: error });
			throw searchEndpointError(options.baseURL, `Moonshot returned an unprocessable response body: ${String(error)}`, error);
		}
		return { sources: mapSearchResults(payload), truncated: false };
	}

	/**
	 * 按链条解析一次搜索用的 Key：字面值 → 凭据服务 → 启动环境 → Kimi Code CLI 配置。
	 * 每次搜索都重新解析，因此轮换 Key 不需要重启。
	 *
	 * @param options - 本次操作的选项快照。
	 * @param signal - 取消信号。
	 * @returns 解析到的 Key。
	 * @throws {@link WebError} `WEB_PROVIDER_CREDENTIAL_MISSING`，链条全部落空时。
	 */
	async resolveApiKey(options, signal) {
		throwIfAborted(signal);
		if (options.apiKey !== void 0 && options.apiKey.length > 0) return options.apiKey;
		const resolved = await options.resolveApiKey();
		if (resolved !== void 0 && resolved.length > 0) return resolved;
		const cli = options.readKimiCliCredential === false ? void 0 : await options.resolveKimiCliCredential();
		if (cli !== void 0 && cli.apiKey.length > 0) return cli.apiKey;
		throw new WebError(`Moonshot search has no API key for "${options.apiKeyEnv}"; store it through the credentials service, export it in the launching environment, set a literal "apiKey" in the web-search-moonshot config, or keep [services.moonshot_search] in ~/.kimi-code/config.toml`, 'WEB_PROVIDER_CREDENTIAL_MISSING');
	}
}

/** 请求已经发出之后的失败：附上端点与恢复指引。 */
function searchEndpointError(endpoint, message, cause) {
	return new WebError(`${message}\n\nThe web search request used endpoint ${JSON.stringify(endpoint)}. Configure it with web-search-moonshot.baseURL (or the row config in the bundle patch) when the endpoint is not the intended one.`, 'WEB_PROVIDER_ERROR', cause === void 0 ? void 0 : { cause });
}

/** 提供方配置；`volatile()` 字段支持改完立即生效。 */
export const Config = z.object({
	apiKey: z.string().role('secret').volatile(),
	apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
	baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
	timeoutSeconds: z.number().step(1).min(MIN_TIMEOUT_SECONDS).max(MAX_TIMEOUT_SECONDS).default(30).volatile(),
	includeContent: z.boolean().default(false).volatile(),
	defaultLimit: z.number().step(1).min(MIN_LIMIT).max(MAX_LIMIT).default(10).volatile(),
	readKimiCliConfig: z.boolean().default(true).volatile()
});

/**
 * 把当前配置段投影成一次搜索的选项。环境与兜底读取都收敛在这里，
 * 于是提供方读到的每个值都已经是最终值。
 *
 * @param ctx - 插件上下文，用于取凭据服务与启动环境。
 * @param config - 当前生效的配置值。
 * @returns churn-free 的一次性选项。
 */
export function resolveOptions(ctx, config) {
	const apiKeyEnv = isCredentialRefName(config.apiKeyEnv) ? credentialRef(config.apiKeyEnv) : credentialRef(DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== void 0 && config.apiKey.length > 0 ? config.apiKey : void 0;
	return {
		...literalApiKey === void 0 ? {} : { apiKey: literalApiKey },
		apiKeyEnv,
		baseURL: config.baseURL ?? DEFAULT_BASE_URL,
		timeoutSeconds: config.timeoutSeconds,
		includeContent: config.includeContent === true,
		defaultLimit: config.defaultLimit,
		readKimiCliCredential: config.readKimiCliConfig !== false,
		resolveApiKey: async () => {
			const credentials = ctx.get('credentials');
			if (credentials !== void 0) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
		},
		resolveKimiCliCredential: async () => {
			const cli = await readKimiCliCredential();
			if (cli === void 0) return void 0;
			return { apiKey: cli.apiKey };
		},
		recordRequest: (entry) => {
			ctx.get('agents')?.currentInitiator()?.session.append('web/moonshot-search-request', entry);
		}
	};
}

/** 注册提供方。 */
export function apply(ctx, config) {
	ctx.web.registerSearchProvider(new MoonshotSearchProvider(() => resolveOptions(ctx, {
		apiKey: config.apiKey.get(),
		apiKeyEnv: config.apiKeyEnv.get(),
		baseURL: config.baseURL.get(),
		timeoutSeconds: config.timeoutSeconds.get(),
		includeContent: config.includeContent.get(),
		defaultLimit: config.defaultLimit.get(),
		readKimiCliConfig: config.readKimiCliConfig.get()
	})));
}
