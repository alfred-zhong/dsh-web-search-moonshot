/**
 * dsh-web-search-moonshot 的浏览器半边：在「设置 → 插件」里给本插件挂一张配置卡，
 * 用来单独填写这把搜索用的 Moonshot / Kimi API Key。
 *
 * 挂载位置（插件管理页的三个配置槽位里，属于已安装插件的两个）：
 * - `plugins.bundle.config`，key = 本 bundle 的包名 → 「已安装 → dsh-web-search-moonshot」详情页的配置区；
 * - `plugins.row.config`，key = `<包名>#<行id>` → 该插件那一行的「配置」入口。
 *   插件管理页只有看到这个 key 才会给该行显示「配置」按钮（见 dsh-client-ui-plugin-manager 的
 *   `configure.has`），所以这个 registration 是必需的，不是可选的。
 *
 * 与宿主半边的约定（改任何一处都要一起改）：
 * - Key 写进**凭据服务**（`~/.dsh/.credentials.yaml` 的 `refs:`），引用名就是下面的
 *   `API_KEY_REF`，与 `cordis.patch.yml` 里行的 `apiKeyEnv` 必须是同一个名字；
 * - 宿主半边每次搜索都重新解析，所以这里保存后**下一次搜索立即生效**，不需要重启；
 * - 客户端半边不 import 任何 `@deepseek-ai/*`：`react`、槽位、locale、连接 API 都由 shell
 *   通过 `window.__ModuleLoader__` 的 require 提供（客户端插件的既定契约）。样式只用主题
 *   变量并带字面值兜底，主题改名也不会崩。
 *
 * 手写的 ModuleLoader 包装，无构建步骤；module id 必须是包名。
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-search-moonshot',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState } = React;

    /** 卡片所属的 locale 命名空间（与包名区分开，避免和 loader 行名混淆）。 */
    const LOCALE_NS = 'settings.plugins.moonshotSearch';
    /** 凭据引用名；必须等于 cordis.patch.yml 里行的 apiKeyEnv。 */
    const API_KEY_REF = 'MOONSHOT_API_KEY';
    /** 本 bundle 的包名：plugins.bundle.config 的 key。 */
    const BUNDLE_NAME = 'dsh-web-search-moonshot';
    /** 本插件行的 id：plugins.row.config 的 key 由 `<包名>#<行id>` 拼成。 */
    const ROW_ID = 'web-search-moonshot';
    /** Key 的申请入口。 */
    const KEY_CONSOLE_URL = 'https://platform.kimi.com/console/api-keys';

    const en = {
      title: 'Web search (Moonshot)',
      description: 'Dedicated API key for this plugin\u2019s Kimi 联网搜索 provider. Stored in the DSH credentials service, not in any settings file.',
      apiKey: 'API key',
      apiKeyPlaceholder: 'sk-\u2026',
      apiKeyHint: 'Leave blank to keep the current key. Saving here takes precedence over the Kimi Code CLI fallback on the very next search.',
      keyConfigured: 'configured',
      keyMissing: 'not configured',
      getApiKey: 'Get an API key \u2197',
      save: 'Save',
      saving: 'Saving\u2026',
      reset: 'Clear',
      saved: 'Saved.',
      saveFailed: 'Save failed.',
      resetDone: 'Cleared.',
      storageNote: `Stored as the credential reference ${API_KEY_REF} in ~/.dsh/.credentials.yaml. Clearing it falls back to ~/.kimi-code/config.toml [services.moonshot_search].`
    };

    const zh = {
      title: '网页搜索（Moonshot）',
      description: '本插件专用的 Kimi 联网搜索 API Key。写入 DSH 凭据服务，不写入任何设置文件。',
      apiKey: 'API Key',
      apiKeyPlaceholder: 'sk-…',
      apiKeyHint: '留空表示保持当前密钥。这里保存的密钥优先级高于 Kimi Code CLI 配置的兜底，且下次搜索立即生效。',
      keyConfigured: '已配置',
      keyMissing: '未配置',
      getApiKey: '获取 API Key ↗',
      save: '保存',
      saving: '保存中…',
      reset: '清空',
      saved: '已保存。',
      saveFailed: '保存失败。',
      resetDone: '已清空。',
      storageNote: `以凭据引用 ${API_KEY_REF} 存放在 ~/.dsh/.credentials.yaml。清空后回退到 ~/.kimi-code/config.toml 的 [services.moonshot_search]。`
    };

    // 沿用 shell 的主题变量；变量缺失时退回字面值。
    const column = { display: 'flex', flexDirection: 'column', gap: 'var(--dsw-spacing-3, 12px)' };
    const description = { margin: 0, color: 'var(--dsw-alias-label-tertiary, #667085)', fontSize: 'var(--dsw-font-size-sm, 13px)' };
    const field = { display: 'flex', flexDirection: 'column', gap: 'var(--dsw-spacing-1, 4px)' };
    const labelRow = { display: 'flex', alignItems: 'center', gap: 'var(--dsw-spacing-2, 8px)' };
    const label = { fontWeight: 'var(--dsw-font-weight-medium, 500)', fontSize: 'var(--dsw-font-size-sm, 13px)' };
    const hint = { color: 'var(--dsw-alias-label-caption, #98a2b3)', fontSize: 'var(--dsw-font-size-xs, 12px)' };
    const input = {
      padding: 'var(--dsw-spacing-2, 8px)',
      border: '0.5px solid var(--dsw-alias-border-l4, #d0d5dd)',
      borderRadius: 'var(--dsw-radius-md, 6px)',
      background: 'var(--dsw-alias-bg-layer-3, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      width: '100%',
      boxSizing: 'border-box'
    };
    const link = { color: 'var(--dsw-alias-brand-primary, #2970ff)', fontSize: 'var(--dsw-font-size-xs, 12px)', textDecoration: 'none' };
    const badgeOk = {
      padding: '1px 8px',
      borderRadius: '9999px',
      fontSize: 'var(--dsw-font-size-xs, 12px)',
      color: 'var(--dsw-alias-state-success-primary, #067647)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #17b26a) 12%, transparent)'
    };
    const badgeMissing = {
      padding: '1px 8px',
      borderRadius: '9999px',
      fontSize: 'var(--dsw-font-size-xs, 12px)',
      color: 'var(--dsw-alias-label-caption, #98a2b3)',
      background: 'color-mix(in srgb, var(--dsw-alias-label-caption, #98a2b3) 16%, transparent)'
    };
    const actions = { display: 'flex', alignItems: 'center', gap: 'var(--dsw-spacing-2, 8px)' };
    const primary = {
      padding: 'var(--dsw-spacing-1, 4px) var(--dsw-spacing-3, 12px)',
      borderRadius: 'var(--dsw-radius-md, 6px)',
      border: '0.5px solid var(--dsw-alias-border-l4, #d0d5dd)',
      background: 'var(--dsw-alias-state-business-primary, #2970ff)',
      color: '#ffffff',
      cursor: 'pointer',
      font: 'inherit'
    };
    const secondary = {
      padding: 'var(--dsw-spacing-1, 4px) var(--dsw-spacing-3, 12px)',
      borderRadius: 'var(--dsw-radius-md, 6px)',
      border: '0.5px solid var(--dsw-alias-border-l4, #d0d5dd)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      cursor: 'pointer',
      font: 'inherit'
    };
    const message = { color: 'var(--dsw-alias-label-tertiary, #667085)', fontSize: 'var(--dsw-font-size-xs, 12px)' };

    /**
     * 卡片主体。props = 宿主透传的 ownerProps（`view` / `form` / `entryKey`）+ 注册时 inject 的内容。
     */
    function MoonshotCard(props) {
      const state = props.useMoonshotSearchCard((snapshot) => snapshot);
      const [text, setText] = useState('');
      const disabled = state.saving || state.writable !== true;
      return h('div', { style: column, 'data-plugin-config': 'moonshot-web-search' }, [
        h('p', { key: 'description', style: description }, props.t('description')),
        h('div', { key: 'key', style: field }, [
          h('div', { key: 'label', style: labelRow }, [
            h('span', { key: 'text', style: label }, props.t('apiKey')),
            h('span', { key: 'badge', style: state.keyConfigured ? badgeOk : badgeMissing },
              props.t(state.keyConfigured ? 'keyConfigured' : 'keyMissing'))
          ]),
          h('input', {
            key: 'input',
            style: input,
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            value: text,
            placeholder: props.t('apiKeyPlaceholder'),
            disabled,
            onChange: (event) => setText(event.target.value)
          }),
          h('span', { key: 'hint', style: hint }, props.t('apiKeyHint')),
          h('a', { key: 'console', style: link, href: KEY_CONSOLE_URL, target: '_blank', rel: 'noreferrer' },
            props.t('getApiKey'))
        ]),
        h('div', { key: 'actions', style: actions }, [
          h('button', {
            key: 'save',
            type: 'button',
            style: primary,
            disabled,
            onClick: () => { void props.save(text).then(() => setText('')); }
          }, props.t(state.saving ? 'saving' : 'save')),
          h('button', {
            key: 'reset',
            type: 'button',
            style: secondary,
            disabled,
            onClick: () => { void props.reset(); }
          }, props.t('reset')),
          state.message === undefined
            ? null
            : h('span', { key: 'message', style: message }, props.t(state.message))
        ]),
        h('p', { key: 'storage', style: hint }, props.t('storageNote'))
      ]);
    }

    /**
     * keyed 槽位的渲染入口：摘要视图返回 null（让插件页回退到它自己的元数据描述），
     * 页面视图渲染卡片。
     *
     * @param props - 宿主透传的 ownerProps 与 inject 内容。
     * @returns 卡片元素或 null。
     */
    function renderCard(props) {
      return props.view === 'summary' ? null : h(MoonshotCard, props);
    }

    /** shell 必须提供的服务（`remote.credentials` 是官方凭据读写通道）。 */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials'];

    /**
     * 注册两张配置入口。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS);
      const credentials = ctx.remote.credentials;

      let snapshot = { saving: false, message: undefined, keyConfigured: false, writable: true };
      const listeners = new Set();
      const store = {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        }
      };
      const setSnapshot = (patch) => {
        snapshot = { ...snapshot, ...patch };
        for (const listener of listeners) listener();
      };

      /** 问凭据服务这把引用当前是否已配置（以及是否可写）。 */
      const refresh = async () => {
        if (credentials === undefined || credentials.describe === undefined) {
          setSnapshot({ keyConfigured: false, writable: false });
          return;
        }
        try {
          const response = await credentials.describe([API_KEY_REF]);
          if (!response || response.ok !== true) {
            setSnapshot({ keyConfigured: false, writable: false });
            return;
          }
          const view = response.value ? response.value[API_KEY_REF] : undefined;
          setSnapshot({
            keyConfigured: view ? view.configured === true : false,
            writable: view ? view.writable !== false : true
          });
        } catch {
          // 传输层偶发失败：保留上一状态，不谎报“未配置”。
        }
      };

      let timer;
      const flash = (value) => {
        setSnapshot({ saving: false, message: value });
        if (timer !== undefined) clearTimeout(timer);
        if (value !== undefined) timer = setTimeout(() => setSnapshot({ message: undefined }), 4000);
      };

      /** 保存：空白表示保持现状；写入后立刻回读徽标。 */
      const save = async (value) => {
        const next = (value || '').trim();
        if (next.length === 0) {
          flash(undefined);
          return;
        }
        if (credentials === undefined || credentials.set === undefined) return;
        setSnapshot({ saving: true });
        try {
          const response = await credentials.set(API_KEY_REF, next);
          if (!response || response.ok !== true) {
            throw new Error(response && response.error ? String(response.error.message) : 'credential write rejected');
          }
          flash('saved');
        } catch {
          flash('saveFailed');
        }
        await refresh();
      };

      /** 清空这把引用（之后回退到 Kimi Code CLI 兜底）。 */
      const reset = async () => {
        if (credentials === undefined || credentials.unset === undefined) return;
        setSnapshot({ saving: true });
        try {
          const response = await credentials.unset(API_KEY_REF);
          if (!response || response.ok !== true) throw new Error('credential clear rejected');
          flash('resetDone');
        } catch {
          flash('saveFailed');
        }
        await refresh();
      };

      /** 组装 keyed 槽位的注册选项；inject 的内容会与 ownerProps 合并后传给 renderCard。 */
      const optionsFor = (name, key) => ({
        name,
        key,
        locale: LOCALE_NS,
        inject: () => ({
          hooks: { moonshotSearchCard: store },
          save,
          reset,
          t
        })
      });

      // bundle 详情页的配置区：key = 包名。
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
        optionsFor('plugins.bundle.config', BUNDLE_NAME),
        renderCard
      ));

      // 行详情页的配置区：key = `<包名>#<行id>`；也决定该行是否显示「配置」入口。
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
        optionsFor('plugins.row.config', `${BUNDLE_NAME}#${ROW_ID}`),
        renderCard
      ));

      ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'moonshot-search: dictionaries');
      ctx.effect(() => ctx.remote.$on('credentials/reference-updated', (ref) => {
        if (ref === API_KEY_REF) void refresh();
      }), 'moonshot-search: credential invalidations');
      void refresh();
    }

    return { inject, apply };
  }
});
