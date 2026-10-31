/*
 * dsh-outside-workspace — browser half.
 *
 * Lets the operator start a session OUTSIDE every registered workspace
 * (Codex-style "projectless chat") with its cwd in a default directory under
 * the Host account's Documents folder.
 *
 * The feature is three contributions — two slot registrations and one stock
 * control takeover:
 *
 *  1. `conversation.hero.options` (list slot, session scope) — a compact
 *     "不在工作区 / Outside workspace" button in the blank-session hero row.
 *     On click it resolves the default directory, calls
 *     `ctx.sessions.create({ cwd })` (Host accepts bare `cwd`, creates the
 *     directory recursively and records `SessionHeader.cwd`), remembers the
 *     new Session id in plugin-local memory, and navigates with
 *     `ctx.uiWorkspace.openSession(id)`.
 *
 *  2. `conversation.composer` (chain slot, session scope) — the stock composer
 *     is inert for a blank Session that belongs to no Workspace
 *     (`ConversationContent`: `inert = sessionId === undefined || hero &&
 *     chipTitle === undefined`, and `chipTitle` comes from Workspace
 *     membership), so the takeover renders the stock new-session hero itself:
 *     the same hero shell, agent-preset seat, permission and model seats, and
 *     composer card, with the workspace chip replaced by a static
 *     "不在项目中 / Not in a project" label. The text surface is a plain
 *     textarea (the stock Lexical editor is bound to the opposite, inert view);
 *     the first prompt still goes through `session.prompt([...], 'queue')`.
 *     Once the first prompt is accepted the Session stops being blank, the
 *     selector declines, and the stock conversation UI takes over by itself.
 *
 *  3. Sidebar "未分组 / Ungrouped" group — its stock "+" (new session) control
 *     is inert: ui-workspace only starts a Session from a group row when the
 *     group carries a Workspace id, and the workspace-less bucket has none.
 *     A capture-phase click listener therefore takes over that one control and
 *     runs the same creation routine as the hero entry. The takeover relies on
 *     the stock sidebar DOM (the Ungrouped row is `data-row-key="workspace:"`
 *     and its last row-action button is the new-session control); it fails
 *     closed — on any other markup the stock control is left untouched.
 *
 * The first prompt is sent with the public Client Session Controller reference
 * API (`ctx.sessions.using(...)` → `binding.session.prompt([...], 'queue')`).
 *
 * Deviations / known limitations (documented here because this plugin owns its
 * own bundle and has no other doc surface):
 *  - The chain selector is required to be a pure function of the owner
 *    currency. This selector additionally consults the module-local
 *    `outsideSessions` map (the plugin's own memory of Sessions it created).
 *    The owner currency still dominates: the Session must be blank, and IDs
 *    leave the map when the first prompt is accepted, so a stale entry can
 *    only ever point at a still-blank Session.
 *  - The map lives in page memory: after a reload a previously created blank
 *    outside Session is restored by the Workspace UI but no longer gets the
 *    composer takeover (its stock composer stays inert until a message is
 *    admitted by another path). Bounded to MAX_TRACKED entries.
 *  - Only the first plain-text prompt is handled here (no attachments, no
 *    command chips, no queue/steer choice); the composer's `+` control reports
 *    that limitation. Model and permission selections are the stock seats and
 *    do work. After the first message the stock composer owns everything.
 *  - The start-page clone renders the stock control entries through the public
 *    Slots inspection API (`entriesOfSlot`/`spec`) and the standard Session kit
 *    the takeover itself receives. If a future DSH build stops exposing those
 *    entries, the seats simply render nothing; session creation and the first
 *    prompt keep working.
 *  - The sidebar takeover depends on the stock layout of the Ungrouped group
 *    row. It is diagnosed conservatively: a click only starts the outside
 *    Session when the row is the empty-workspace group row and the clicked
 *    control is that row's last, non-popup button. Any layout change without
 *    that shape leaves the stock (inert) control alone instead of creating an
 *    unexpected Session.
 *  - Default directory: `<home>/Documents/deepseek-harness/outside-workspace`
 *    as specified; when the composed directory picker cannot list directories
 *    (the native OS picker on loopback win32/darwin answers
 *    `directory-picker/unavailable`), the Host-configured documents root is
 *    recovered from the stock Workspace `<documents>/deepseek-harness/
 *    default-workspace` first, so an overridden/redirected documents root is
 *    still honored.
 */
window.__ModuleLoader__.load({
  id: 'dsh-outside-workspace',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    /**
     * Shared UI primitives (an implicit baseline external for Module Loader
     * bundles). Optional: the hero chrome degrades to text without them.
     */
    let primitives;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      warn('UI primitives are unavailable; the outside-session hero degrades', error);
    }

    /** Locale namespace shared by all contributions. */
    const NS = 'dsh-outside-workspace';
    const LOG_PREFIX = '[dsh-outside-workspace]';
    /** Slot keys this plugin contributes to (declared by ui-conversation). */
    const HERO_SLOT = 'conversation.hero.options';
    const COMPOSER_SLOT = 'conversation.composer';
    /** Stock conversation locale namespace (hero copy + composer placeholder). */
    const CONVERSATION_NS = 'conversation';
    /** Stock control slots rendered inside the outside-session hero. */
    const STOCK_AGENT_PRESET_SLOT = 'conversation.hero.agentPreset';
    const STOCK_PERMISSION_SLOT = 'conversation.input.permission';
    const STOCK_PLAN_SLOT = 'conversation.input.plan';
    const STOCK_MODEL_SLOT = 'conversation.input.model';
    /** Path segments below the Documents folder of the Host account. */
    const OUTSIDE_SEGMENTS = ['deepseek-harness', 'outside-workspace'];
    /** Upper bound for the plugin-local created-Session memory. */
    const MAX_TRACKED = 50;
    /** Inline style element identity (also used for HMR/teardown cleanup). */
    const STYLE_PLUGIN_ID = 'dsh-outside-workspace';
    const STYLE_MARKER = 'outside-workspace-styles';
    /** How long a transient plugin notice stays on screen. */
    const NOTICE_HOLD_MS = 6000;
    /** Copy of stock conversation strings, used when the host locale has none. */
    const STOCK_COPY = {
      zh: {
        'hero.headline': '探索未至之境',
        'hero.preview': '预览版',
        'placeholder.hero': '描述你想要构建的内容, / 调用指令, @ 文件或对话',
        'input.send': '发送消息',
        'input.commands': '添加文件或调用指令',
      },
      en: {
        'hero.headline': 'Into the Unknown',
        'hero.preview': 'Preview',
        'placeholder.hero': 'Describe what you want to build, / commands, @ files or sessions',
        'input.send': 'Send message',
        'input.commands': 'Add files or run commands',
      },
    };

    // ---------------------------------------------------------------------
    // Locale dictionaries (registered untyped: one register per language).
    // ---------------------------------------------------------------------

    const ZH = {
      'entry.label': '不在工作区',
      'entry.title': '在默认目录新建一个不属于任何工作区的会话',
      'entry.busy': '创建中…',
      'entry.error': '无法创建会话：{message}',
      'entry.unavailable': '会话服务不可用',
      'entry.outsideProject': '不在项目中',
      'sidebar.createFailed': '无法在「未分组」中新建会话：{message}',
      'composer.sendFailed': '发送失败：{message}',
      'composer.limit': '工作区外会话的首条消息暂不支持添加文件或指令，发送后会恢复标准输入框',
    };

    const EN = {
      'entry.label': 'Outside workspace',
      'entry.title': 'Start a session outside every workspace, in the default directory',
      'entry.busy': 'Creating…',
      'entry.error': 'Could not create the session: {message}',
      'entry.unavailable': 'Session service unavailable',
      'entry.outsideProject': 'Not in a project',
      'sidebar.createFailed': 'Could not start a new session in Ungrouped: {message}',
      'composer.sendFailed': 'Send failed: {message}',
      'composer.limit': 'Files and commands are not available for the first message outside a workspace; the standard composer returns after sending',
    };

    // ---------------------------------------------------------------------
    // Styles: one <style> in <head>, installed inside apply() through
    // ctx.effect so plugin unload removes it. Only host theme tokens are used
    // for containers and controls.
    // ---------------------------------------------------------------------

    const CSS = `
.dsh-outside-ws-hero {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-outside-ws-hero:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-outside-ws-hero:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}
.dsh-outside-ws-hero:disabled {
  opacity: 0.55;
  cursor: default;
}
.dsh-outside-ws-hero-icon {
  flex: none;
  display: block;
}
.dsh-outside-ws-hero-error {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
/* The chain outlet renders under a display:contents anchor, so match a
   descendant: the seat fills the scroll area and centers the stock-styled hero
   in both the hero and the engaging phase (the stock fallback is hidden while
   elected). */
[data-composer-seat]:has([data-dsh-outside-workspace="composer"]) {
  flex: 1 1 auto;
  min-height: 0;
  justify-content: center;
}
/* The project chip of an outside Session is informational, not a picker. */
.dsh-outside-ws-chip,
.dsh-outside-ws-chip:not(:disabled):hover {
  background: transparent;
  cursor: default;
}
/* A plain textarea standing in for the stock contenteditable surface. */
.dsh-outside-ws-input {
  box-sizing: border-box;
  display: block;
  width: 100%;
  min-height: 52px;
  max-height: var(--dsh-composer-text-max-height, 336px);
  padding: 4px 8px 0 14px;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  caret-color: var(--dsw-alias-state-business-primary);
  font-family: var(--dsw-font-family);
  font-size: inherit;
  line-height: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  overflow-y: auto;
}
.dsh-outside-ws-input::placeholder {
  color: var(--dsw-alias-label-caption);
}
.dsh-outside-ws-input:disabled {
  opacity: 0.7;
}
/* The stock Ungrouped new-session control while this plugin creates the Session. */
[data-dsh-outside-workspace-creating="true"] {
  opacity: 0.55;
  cursor: progress;
}
/* Transient failure notice for a sidebar creation (the sidebar has no card). */
.dsh-outside-ws-toast {
  position: fixed;
  top: 18px;
  left: 50%;
  z-index: 2300;
  box-sizing: border-box;
  max-width: min(520px, calc(100vw - 32px));
  padding: 10px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
  transform: translateX(-50%);
  pointer-events: none;
}
`;

    // ---------------------------------------------------------------------
    // Plugin-local memory and small helpers (all inside the factory closure so
    // they never leak into the page/global scope).
    // ---------------------------------------------------------------------

    /** Session ids created by this plugin and still awaiting their first prompt. */
    const outsideSessions = new Map();
    /** Resolved default outside-workspace directory, cached after first success. */
    let cachedDirectory;
    /** Currently visible transient notice and its hold timer. */
    let noticeNode;
    let noticeTimer = 0;

    /** Remove the transient notice (idempotent). */
    function hidePluginNotice() {
      if (noticeTimer !== 0) {
        try {
          clearTimeout(noticeTimer);
        } catch (_ignored) {
          /* noop */
        }
        noticeTimer = 0;
      }
      if (noticeNode !== undefined) {
        try {
          noticeNode.remove();
        } catch (_ignored) {
          /* noop */
        }
        noticeNode = undefined;
      }
    }

    /** Show one transient top-center notice, replacing any previous one. */
    function showPluginNotice(message) {
      try {
        if (typeof document === 'undefined' || document === null || document.body === null) return;
        hidePluginNotice();
        const node = document.createElement('div');
        node.className = 'dsh-outside-ws-toast';
        node.setAttribute('data-dsh-outside-workspace', 'notice');
        node.setAttribute('role', 'alert');
        node.textContent = message;
        document.body.appendChild(node);
        noticeNode = node;
        noticeTimer = setTimeout(() => {
          noticeTimer = 0;
          hidePluginNotice();
        }, NOTICE_HOLD_MS);
      } catch (error) {
        warn('could not show the plugin notice', error);
      }
    }

    /** console.warn that can never throw (supervision-safe logging). */
    function warn(message, error) {
      try {
        if (error === undefined) console.warn(`${LOG_PREFIX} ${message}`);
        else console.warn(`${LOG_PREFIX} ${message}`, error);
      } catch (_ignored) {
        /* logging must never break a plugin */
      }
    }

    /** Read one optional Cordis service from the plugin context. */
    function serviceOf(ctx, name) {
      try {
        if (ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function') return ctx.get(name);
      } catch (error) {
        warn(`service lookup failed for "${name}"`, error);
      }
      return undefined;
    }

    /** Human-readable text for a thrown value or a folded Remote error. */
    function errorText(error) {
      try {
        if (error === null || error === undefined) return 'unknown error';
        const rpc = error.rpcError;
        if (rpc !== null && typeof rpc === 'object') {
          const code = typeof rpc.code === 'string' ? rpc.code : '';
          const message = typeof rpc.message === 'string' ? rpc.message : '';
          if (code !== '' && message !== '') return `${code}: ${message}`;
          if (message !== '') return message;
          if (code !== '') return code;
        }
        if (typeof error.message === 'string' && error.message !== '') return error.message;
        return String(error);
      } catch (_ignored) {
        return 'unknown error';
      }
    }

    /** Fallback translator used only if a slot registration somehow misses `t`. */
    function fallbackT(key, params) {
      let dict = EN;
      try {
        const language = typeof navigator === 'object' && navigator !== null ? navigator.language : undefined;
        if (typeof language === 'string' && language.toLowerCase().indexOf('zh') === 0) dict = ZH;
      } catch (_ignored) {
        /* keep English */
      }
      const template = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
      if (params === null || params === undefined) return template;
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ));
    }

    /** The localized `t` seat a registration with `locale: NS` supplies. */
    function translatorOf(props) {
      if (props !== null && typeof props === 'object' && typeof props.t === 'function') return props.t;
      return fallbackT;
    }

    // ---------------------------------------------------------------------
    // Default outside directory resolution.
    //
    // Preferred source: `ctx.remote.$host.home` (Host home dir). The Documents
    // folder itself may be redirected (OneDrive, localized names), so when the
    // Host home listing is reachable the real `Documents` entry path is
    // preferred over a joined segment. The target directory does not have to
    // exist: Host `session.create({ cwd })` runs mkdir(cwd, { recursive: true }).
    //
    // The shipped desktop compositions mount the *native* directory picker on
    // loopback win32/darwin hosts, where `directoryPicker/list` answers
    // `directory-picker/unavailable`. In that case the Host-configured
    // documents root is recovered from the existing stock Workspace
    // `<documents>/deepseek-harness/default-workspace` (same config
    // `documentsDirectory` the Host used), so an overridden documents root is
    // still honored; the plain `<home>/Documents` construction remains the
    // last resort.
    // ---------------------------------------------------------------------

    function basename(path) {
      const cleaned = stripTrailingSeparators(path);
      const slash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
      return slash === -1 ? cleaned : cleaned.slice(slash + 1);
    }

    /** Parent of an absolute path, keeping filesystem roots intact. */
    function parentDirectory(path) {
      const cleaned = stripTrailingSeparators(path);
      const slash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
      if (slash === -1) return undefined;
      if (slash === 0) return cleaned.slice(0, 1);
      return cleaned.slice(0, slash);
    }

    function stripTrailingSeparators(path) {
      let end = path.length;
      while (end > 1) {
        const ch = path[end - 1];
        if (ch !== '/' && ch !== '\\') break;
        // Keep a Windows drive root ("C:\") and a POSIX root ("/").
        if (end === 3 && /^[A-Za-z]:[\\/]$/.test(path.slice(0, 3))) break;
        end -= 1;
      }
      return end === path.length ? path : path.slice(0, end);
    }

    /** Join path segments with the separator the base path already uses. */
    function joinPath(base, ...parts) {
      const sep = base.indexOf('\\') !== -1 ? '\\' : '/';
      let result = base;
      for (const part of parts) {
        if (typeof part !== 'string' || part === '') continue;
        if (result.endsWith('/') || result.endsWith('\\')) result += part;
        else result += sep + part;
      }
      return result;
    }

    /** Absolute `Documents` child path from a Host home listing, if present. */
    function documentsEntryOf(entries) {
      if (!Array.isArray(entries)) return undefined;
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue;
        if (entry.hidden === true) continue;
        const path = typeof entry.path === 'string' ? entry.path : '';
        if (path === '') continue;
        const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : basename(path);
        if (name.toLowerCase() === 'documents') return stripTrailingSeparators(path);
      }
      return undefined;
    }

    /**
     * Host-configured documents root, recovered from the stock first-use
     * Workspace path `<documents>/deepseek-harness/default-workspace`. This is
     * the directory the Host itself used (honoring its `documentsDirectory`
     * config), which the client cannot read directly.
     */
    function hostDocumentsRootOf(ctx) {
      try {
        const workspaces = serviceOf(ctx, 'workspaces');
        const list = workspaces === undefined ? undefined : workspaces.list;
        const snapshot = list !== null && typeof list === 'object' && typeof list.getSnapshot === 'function'
          ? list.getSnapshot()
          : undefined;
        const items = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.items)
          ? snapshot.items
          : undefined;
        if (items === undefined) return undefined;
        for (const item of items) {
          if (item === null || typeof item !== 'object') continue;
          const path = typeof item.path === 'string' ? item.path : '';
          if (path === '') continue;
          const cleaned = stripTrailingSeparators(path);
          if (basename(cleaned).toLowerCase() !== 'default-workspace') continue;
          const harnessParent = parentDirectory(cleaned);
          if (harnessParent === undefined || basename(harnessParent).toLowerCase() !== 'deepseek-harness') continue;
          const documentsRoot = parentDirectory(harnessParent);
          if (documentsRoot !== undefined && documentsRoot !== '') return documentsRoot;
        }
      } catch (error) {
        warn('workspace-derived documents root lookup failed', error);
      }
      return undefined;
    }

    /** List one directory through ui-workspace; failures degrade to undefined. */
    async function listDirectorySafe(ctx, path) {
      const workspaceUi = serviceOf(ctx, 'uiWorkspace');
      if (workspaceUi === undefined || typeof workspaceUi.listDirectory !== 'function') return undefined;
      try {
        return await workspaceUi.listDirectory(path);
      } catch (error) {
        warn(`directory listing failed for "${String(path)}"`, error);
        return undefined;
      }
    }

    /** Resolve (and cache) the default outside-workspace directory. */
    async function resolveOutsideDirectory(ctx) {
      if (typeof cachedDirectory === 'string' && cachedDirectory !== '') return cachedDirectory;

      const remote = serviceOf(ctx, 'remote');
      let home;
      try {
        const host = remote === undefined ? undefined : remote.$host;
        if (host !== null && typeof host === 'object' && typeof host.home === 'string' && host.home !== '') {
          home = host.home;
        }
      } catch (error) {
        warn('Host home directory is unavailable', error);
      }

      let listing;
      if (home !== undefined) {
        listing = await listDirectorySafe(ctx, home);
      } else {
        // No $host facts: an absent path lists the Host account's home level,
        // whose listing carries `home` (and an absolute crumb chain) anyway.
        listing = await listDirectorySafe(ctx, undefined);
        if (listing !== null && typeof listing === 'object') {
          if (typeof listing.home === 'string' && listing.home !== '') {
            home = listing.home;
          } else if (Array.isArray(listing.crumbs) && listing.crumbs.length > 0) {
            const last = listing.crumbs[listing.crumbs.length - 1];
            if (last !== null && typeof last === 'object' && typeof last.path === 'string' && last.path !== '') home = last.path;
          }
        }
      }

      if (home === undefined) {
        throw new Error('the Host home directory could not be determined');
      }

      const documents = listing !== null && typeof listing === 'object'
        ? documentsEntryOf(listing.entries)
        : undefined;
      // With the native picker composed, the listing is unavailable and the
      // Documents entry cannot be discovered; recover the Host-configured
      // documents root from the stock default Workspace before guessing.
      const hostDocumentsRoot = documents === undefined ? hostDocumentsRootOf(ctx) : undefined;
      const target = documents !== undefined
        ? joinPath(documents, ...OUTSIDE_SEGMENTS)
        : hostDocumentsRoot !== undefined
          ? joinPath(stripTrailingSeparators(hostDocumentsRoot), ...OUTSIDE_SEGMENTS)
          : joinPath(stripTrailingSeparators(home), 'Documents', ...OUTSIDE_SEGMENTS);

      cachedDirectory = target;
      return target;
    }

    // ---------------------------------------------------------------------
    // Session creation + first-prompt sending.
    // ---------------------------------------------------------------------

    /** Remember one outside Session so the composer takeover can elect it. */
    function rememberOutsideSession(sessionId, cwd) {
      outsideSessions.set(sessionId, typeof cwd === 'string' ? cwd : '');
      while (outsideSessions.size > MAX_TRACKED) {
        const oldest = outsideSessions.keys().next();
        if (oldest.done === true || oldest.value === sessionId) break;
        outsideSessions.delete(oldest.value);
      }
    }

    /** Drop one outside Session from plugin memory (first prompt accepted). */
    function forgetOutsideSession(sessionId) {
      outsideSessions.delete(sessionId);
    }

    /** cwd shown in the takeover card: plugin memory first, catalog summary second. */
    function cwdOfSession(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;
      const tracked = outsideSessions.get(sessionId);
      if (typeof tracked === 'string' && tracked !== '') return tracked;
      try {
        const sessions = serviceOf(ctx, 'sessions');
        const list = sessions === undefined ? undefined : sessions.list;
        const snapshot = list !== null && typeof list === 'object' && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined;
        const byId = snapshot !== null && typeof snapshot === 'object' ? snapshot.byId : undefined;
        const summary = byId !== null && typeof byId === 'object' ? byId[sessionId] : undefined;
        if (summary !== null && typeof summary === 'object' && typeof summary.cwd === 'string' && summary.cwd !== '') return summary.cwd;
      } catch (error) {
        warn('session cwd lookup failed', error);
      }
      return undefined;
    }

    /**
     * Create the outside Session and navigate to it.
     * @returns the created Session id.
     */
    async function createOutsideSession(ctx) {
      const sessions = serviceOf(ctx, 'sessions');
      if (sessions === undefined || typeof sessions.create !== 'function') {
        throw new Error('the session service is unavailable');
      }
      const workspaceUi = serviceOf(ctx, 'uiWorkspace');
      if (workspaceUi === undefined || typeof workspaceUi.openSession !== 'function') {
        throw new Error('workspace navigation is unavailable');
      }

      const cwd = await resolveOutsideDirectory(ctx);
      const sessionId = await sessions.create({ cwd });
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('the session service returned no session id');
      }
      // Remember BEFORE navigating: the conversation may render on the next frame.
      rememberOutsideSession(sessionId, cwd);
      try {
        workspaceUi.openSession(sessionId);
      } catch (error) {
        warn('the outside-workspace session was created but could not be opened', error);
        throw new Error(`the new session could not be opened: ${errorText(error)}`);
      }
      return sessionId;
    }

    /**
     * Send the first plain-text prompt through a retained Session reference.
     * Business failures are folded into a thrown Error so the card can show them.
     */
    async function sendFirstPrompt(ctx, sessionId, text) {
      const sessions = serviceOf(ctx, 'sessions');
      if (sessions === undefined || typeof sessions.using !== 'function') {
        throw new Error('the session service is unavailable');
      }
      let accepted = false;
      await sessions.using(sessionId, { source: 'outsideWorkspaceComposer' }, async (reference) => {
        const binding = reference === null || reference === undefined ? undefined : reference.binding;
        const session = binding === null || binding === undefined ? undefined : binding.session;
        if (session === undefined || typeof session.prompt !== 'function') {
          throw new Error('the session is not open');
        }
        const result = await session.prompt([{ type: 'text', text }], 'queue');
        if (result !== null && typeof result === 'object' && result.ok === false) {
          throw new Error(errorText(result.error));
        }
        accepted = true;
      });
      if (accepted) {
        // The Session stopped being blank: the takeover selector no longer
        // needs this id; leaving it would only grow module memory.
        forgetOutsideSession(sessionId);
      }
    }

    // ---------------------------------------------------------------------
    // Sidebar "Ungrouped / 未分组" group: the stock "+" (new session) control
    // there is inert. ui-workspace starts a Session from a group row only when
    // the group carries a Workspace id (`onCreate` checks `workspaceId !==
    // undefined`), and the workspace-less bucket has none, so a click does
    // nothing at all — no navigation, no request, no error. This plugin already
    // owns "create a Session outside every Workspace", so it takes that control
    // over: a capture-phase click listener spots the Ungrouped row's last row
    // action button and runs the same routine as the hero entry.
    //
    // The DOM contract is deliberately narrow and fails closed: a different
    // DSH sidebar markup (another row key, a moved button) simply leaves the
    // stock control alone rather than starting an unexpected Session.
    // ---------------------------------------------------------------------

    /** Sidebar row of the workspace-less bucket (its group key is the empty string). */
    const UNGROUPED_ROW_SELECTOR = '[role="treeitem"][data-row-key="workspace:"]';

    /** Locale-bound translator for code outside a slot component. */
    function translatorFor(ctx) {
      try {
        const locale = serviceOf(ctx, 'locale');
        if (locale !== undefined && typeof locale.bind === 'function') {
          const bound = locale.bind(NS);
          if (typeof bound === 'function') return bound;
        }
      } catch (error) {
        warn('locale binding failed; sidebar notices fall back to English', error);
      }
      return fallbackT;
    }

    /**
     * Resolve the stock new-session button of the Ungrouped sidebar row from a
     * click target. Returns undefined for every other click.
     */
    function ungroupedNewSessionButton(target) {
      if (target === null || typeof target !== 'object' || typeof target.closest !== 'function') return undefined;
      let row;
      try {
        row = target.closest(UNGROUPED_ROW_SELECTOR);
      } catch (_ignored) {
        return undefined;
      }
      if (row === null || row === undefined || typeof row.querySelectorAll !== 'function') return undefined;
      let button;
      try {
        button = target.closest('button');
      } catch (_ignored) {
        return undefined;
      }
      if (button === null || button === undefined || row.contains(button) !== true) return undefined;
      // Popup controls (the Workspace "..." menu) are never the new-session action.
      if (button.getAttribute('aria-haspopup') !== null) return undefined;
      if (button.getAttribute('aria-expanded') !== null) return undefined;
      const buttons = row.querySelectorAll('button');
      if (buttons.length === 0) return undefined;
      // The stock layout renders the new-session control last in the row actions.
      if (buttons[buttons.length - 1] !== button) return undefined;
      return button;
    }

    /**
     * Take over the inert Ungrouped "+" control. The listener is installed once
     * per activation and removed with the plugin fiber.
     */
    function installSidebarEntry(ctx) {
      try {
        if (typeof document === 'undefined' || document === null) return;
        const t = translatorFor(ctx);
        ctx.effect(() => {
          let creating = false;

          const reportFailure = (reason) => {
            showPluginNotice(t('sidebar.createFailed', { message: errorText(reason) }));
          };

          const onClick = (event) => {
            if (creating) return;
            if (event === null || typeof event !== 'object') return;
            if (event.defaultPrevented === true) return;
            if (typeof event.button === 'number' && event.button !== 0) return;
            if (event.ctrlKey === true || event.metaKey === true || event.shiftKey === true || event.altKey === true) return;
            const button = ungroupedNewSessionButton(event.target);
            if (button === undefined) return;
            // The stock handler is a no-op; still stop the click so the row does
            // not toggle and no other handler acts on it twice.
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (typeof event.stopPropagation === 'function') event.stopPropagation();
            creating = true;
            try {
              button.setAttribute('aria-busy', 'true');
              button.setAttribute('data-dsh-outside-workspace-creating', 'true');
            } catch (_ignored) {
              /* attribute updates are cosmetic */
            }
            Promise.resolve()
              .then(() => createOutsideSession(ctx))
              .catch((reason) => {
                warn('could not create the outside-workspace session from the sidebar', reason);
                reportFailure(reason);
              })
              .finally(() => {
                creating = false;
                try {
                  button.removeAttribute('aria-busy');
                  button.removeAttribute('data-dsh-outside-workspace-creating');
                } catch (_ignored) {
                  /* the row may already be gone after navigation */
                }
              });
          };

          document.addEventListener('click', onClick, true);
          return () => {
            document.removeEventListener('click', onClick, true);
            hidePluginNotice();
          };
        }, 'dsh-outside-workspace: ungrouped new session');
      } catch (error) {
        warn('sidebar new-session takeover failed', error);
      }
    }

    // ---------------------------------------------------------------------
    // Stock-styled "new session" hero for the outside Session.
    //
    // DSH marks its composer inert for a blank Session without Workspace
    // membership, so this takeover supplies the composer. To keep the
    // outside-session start page indistinguishable from a normal start page, the
    // takeover renders the stock hero chrome (headline, project chip, agent
    // preset seat, composer card, permission/model seats) with the same CSS and
    // the same control entries the host uses. Only the text surface is a plain
    // textarea and only the project chip differs — "不在项目中" instead of a
    // Workspace name — because an outside Session has no Workspace to pick.
    // ---------------------------------------------------------------------

    /** Bound selector Hooks per observable source (identity-stable). */
    const sourceHookCache = new WeakMap();
    /** Cached entry inject results per (entry, session). */
    const entryInjectCache = new WeakMap();

    /** Language used by the stock-copy fallback. */
    function currentLanguage() {
      try {
        const language = typeof navigator === 'object' && navigator !== null ? navigator.language : undefined;
        if (typeof language === 'string' && language.toLowerCase().indexOf('zh') === 0) return 'zh';
      } catch (_ignored) {
        /* fall through to English */
      }
      return 'en';
    }

    /** Bind the stock conversation namespace, falling back to the shipped copy. */
    function stockTranslator(localeFace) {
      let bound;
      try {
        if (localeFace !== undefined && localeFace !== null && typeof localeFace.bind === 'function') {
          bound = localeFace.bind(CONVERSATION_NS);
        }
      } catch (error) {
        warn('conversation locale binding failed; stock copy falls back', error);
      }
      const dict = STOCK_COPY[currentLanguage()];
      return (key) => {
        if (typeof bound === 'function') {
          try {
            const value = bound(key);
            if (typeof value === 'string' && value !== '' && value !== key) return value;
          } catch (_ignored) {
            /* fall through */
          }
        }
        return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
      };
    }

    /** Bind a bare observable source to an identity-stable selector Hook. */
    function sourceHook(source) {
      let hook = sourceHookCache.get(source);
      if (hook !== undefined) return hook;
      const subscribe = (listener) => source.subscribe(listener);
      const getSnapshot = () => source.getSnapshot();
      function useSelector(selector, isEqual) {
        const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
        const selected = selector(snapshot);
        const equal = typeof isEqual === 'function' ? isEqual : Object.is;
        const ref = React.useRef(null);
        if (ref.current !== null && equal(ref.current.value, selected)) return ref.current.value;
        ref.current = { value: selected };
        return selected;
      }
      sourceHookCache.set(source, useSelector);
      return useSelector;
    }

    /** The `use<Name>` prop a slot entry's injected Hook source is bound to. */
    function hookPropName(name) {
      return `use${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    }

    /** Cached `entry.inject(sessionId)` result with its Hook sources bound. */
    function injectedPropsOf(entry, sessionId) {
      if (typeof entry.inject !== 'function') return {};
      let perEntry = entryInjectCache.get(entry);
      if (perEntry === undefined) {
        perEntry = new Map();
        entryInjectCache.set(entry, perEntry);
      }
      if (perEntry.has(sessionId)) return perEntry.get(sessionId);
      let face;
      try {
        face = entry.inject(sessionId);
      } catch (error) {
        warn('stock control injection failed', error);
        face = {};
      }
      const props = {};
      if (face !== null && typeof face === 'object') {
        for (const key of Object.keys(face)) {
          if (key === 'hooks' || key === 'keyedHooks') continue;
          props[key] = face[key];
        }
        const hooks = face.hooks;
        if (hooks !== null && typeof hooks === 'object') {
          for (const name of Object.keys(hooks)) {
            if (hooks[name] !== undefined) props[hookPropName(name)] = sourceHook(hooks[name]);
          }
        }
      }
      perEntry.set(sessionId, props);
      return props;
    }

    /**
     * Build a small renderer for the stock control slots placed inside the
     * outside-session hero. Entries receive exactly the standard Session kit
     * this takeover is given, their own injected face, their locale seat, and
     * the owner props the stock parent would pass.
     */
    function makeStockRenderer(slotsApi, standard, sessionId, localeFace, fallbackT) {
      const translatorCache = new Map();
      const translatorForNs = (namespace) => {
        if (typeof namespace !== 'string' || namespace === '') return fallbackT;
        if (translatorCache.has(namespace)) return translatorCache.get(namespace);
        let bound;
        try {
          if (localeFace !== undefined && localeFace !== null && typeof localeFace.bind === 'function') bound = localeFace.bind(namespace);
        } catch (error) {
          warn(`stock locale binding failed for "${namespace}"`, error);
        }
        const seat = typeof bound === 'function'
          ? (key, params) => bound(key, params)
          : fallbackT;
        translatorCache.set(namespace, seat);
        return seat;
      };
      const renderEntry = (entry, ownerProps) => {
        const component = entry.component;
        if (component === null || (typeof component !== 'function' && typeof component !== 'object')) return null;
        const kit = { ...standard };
        if (typeof entry.locale === 'string' && entry.locale !== '') kit.t = translatorForNs(entry.locale);
        if (entry.children !== undefined) kit.renderSlot = renderSlot;
        return React.createElement(component, {
          ...kit,
          sessionId,
          ...injectedPropsOf(entry, sessionId),
          ...ownerProps,
        });
      };
      const renderSlot = (slotKey, ownerProps) => {
        if (slotsApi === undefined || slotsApi === null) return null;
        let spec;
        try {
          spec = slotsApi.spec(slotKey);
        } catch (error) {
          return null;
        }
        if (spec === undefined) return null;
        if (spec.scope === 'session' && sessionId === undefined) return null;
        let entries;
        try {
          entries = slotsApi.entriesOfSlot(slotKey);
        } catch (error) {
          return null;
        }
        if (entries === undefined || entries.length === 0) return null;
        if (spec.kind === 'single') return renderEntry(entries[0], ownerProps);
        if (spec.kind !== 'list') return null;
        const ordered = entries.slice().sort((left, right) => (left.options.order ?? 0) - (right.options.order ?? 0));
        return ordered.map((entry, index) => h(
          React.Fragment,
          { key: entry.options.id ?? `stock-${index}` },
          renderEntry(entry, ownerProps),
        ));
      };
      return renderSlot;
    }

    /** Stock hero fish, when the UI primitives expose the logo path. */
    function heroFish() {
      const viewBox = primitives === undefined || primitives === null ? undefined : primitives.FISH_LOGO_VIEWBOX;
      const path = primitives === undefined || primitives === null ? undefined : primitives.FISH_LOGO_PATH;
      if (typeof path !== 'string' || viewBox === undefined || viewBox === null) return null;
      return h('svg', {
        className: 'WOwLGG_fish',
        width: 34,
        height: 34 * viewBox.height / viewBox.width,
        viewBox: `0 0 ${viewBox.width} ${viewBox.height}`,
        fill: 'none',
        'aria-hidden': 'true',
      }, h('path', { d: path, fill: 'currentColor' }));
    }

    // ---------------------------------------------------------------------
    // Slot components. Pure at render; timers/refs cleaned up in effects.
    // ---------------------------------------------------------------------

    /** Compact hero-row entry that creates and opens the outside Session. */
    function OutsideWorkspaceButton(props) {
      const t = translatorOf(props);
      const create = props === null || props === undefined ? undefined : props.createOutsideSession;
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const busyRef = React.useRef(false);
      const timerRef = React.useRef(0);
      const mountedRef = React.useRef(true);

      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          if (timerRef.current !== 0) {
            try {
              clearTimeout(timerRef.current);
            } catch (_ignored) {
              /* noop */
            }
            timerRef.current = 0;
          }
        };
      }, []);

      const fail = React.useCallback((reason) => {
        if (!mountedRef.current) return;
        setError(t('entry.error', { message: errorText(reason) }));
        if (timerRef.current !== 0) {
          try {
            clearTimeout(timerRef.current);
          } catch (_ignored) {
            /* noop */
          }
        }
        timerRef.current = setTimeout(() => {
          timerRef.current = 0;
          if (mountedRef.current) setError(null);
        }, 6000);
      }, [t]);

      const onClick = React.useCallback(() => {
        if (busyRef.current) return;
        if (typeof create !== 'function') {
          fail(new Error(t('entry.unavailable')));
          return;
        }
        busyRef.current = true;
        setBusy(true);
        setError(null);
        if (timerRef.current !== 0) {
          try {
            clearTimeout(timerRef.current);
          } catch (_ignored) {
            /* noop */
          }
          timerRef.current = 0;
        }
        Promise.resolve()
          .then(() => create())
          .catch((reason) => {
            warn('could not create the outside-workspace session', reason);
            fail(reason);
          })
          .finally(() => {
            busyRef.current = false;
            if (mountedRef.current) setBusy(false);
          });
      }, [create, fail, t]);

      const icon = h('svg', {
        className: 'dsh-outside-ws-hero-icon',
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', {
          d: 'M4 2.5h8A1.5 1.5 0 0 1 13.5 4v5A1.5 1.5 0 0 1 12 10.5H8.5L5.5 13v-2.5H4A1.5 1.5 0 0 1 2.5 9V4A1.5 1.5 0 0 1 4 2.5Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8 5v3.5M6.25 6.75h3.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
      );

      const label = busy ? t('entry.busy') : t('entry.label');
      const button = h('button', {
        type: 'button',
        className: 'dsh-outside-ws-hero',
        'data-dsh-outside-workspace': 'open',
        title: t('entry.title'),
        // Accessible name mirrors the visible label (the E2E tree reads names);
        // the longer explanation rides `title` as the tooltip.
        'aria-label': label,
        'aria-busy': busy ? 'true' : 'false',
        disabled: busy || typeof create !== 'function',
        onClick,
      }, icon, h('span', null, label));

      if (error === null) return button;
      return h(React.Fragment, null, button, h('span', {
        className: 'dsh-outside-ws-hero-error',
        'data-dsh-outside-workspace': 'error',
        title: error,
        role: 'status',
      }, error));
    }

    /** First-message composer takeover for a blank outside-workspace Session. */
    function FirstMessageComposer(props) {
      const input = props !== null && typeof props === 'object' ? props : {};
      const t = translatorOf(input);
      const matched = input.matched;
      const matchedId = matched !== null && typeof matched === 'object' ? matched.sessionId : undefined;
      const sessionId = typeof matchedId === 'string' && matchedId !== ''
        ? matchedId
        : (typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : undefined);
      const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : undefined;
      const send = input.sendFirstPrompt;
      const slotsApi = input.slotsApi;
      const localeFace = input.localeFace;
      const stockT = React.useMemo(() => stockTranslator(localeFace), [localeFace]);

      const [text, setText] = React.useState('');
      const [sending, setSending] = React.useState(false);
      const textareaRef = React.useRef(null);
      const sendingRef = React.useRef(false);
      const mountedRef = React.useRef(true);

      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      // Focus the first-message editor on mount and after a failed send.
      React.useEffect(() => {
        if (sending) return;
        const node = textareaRef.current;
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus();
      }, [sending]);

      // Grow the plain textarea the way the stock contenteditable grows.
      React.useEffect(() => {
        const node = textareaRef.current;
        if (node === null || node === undefined) return;
        node.style.height = 'auto';
        node.style.height = `${node.scrollHeight}px`;
      }, [text]);

      const submit = React.useCallback(() => {
        if (sendingRef.current) return;
        if (sessionId === undefined) return;
        if (text.trim() === '') return;
        if (typeof send !== 'function') {
          showPluginNotice(t('composer.sendFailed', { message: t('entry.unavailable') }));
          return;
        }
        sendingRef.current = true;
        setSending(true);
        Promise.resolve()
          .then(() => send(sessionId, text))
          .then(() => {
            if (!mountedRef.current) return;
            setText('');
            setSending(false);
          })
          .catch((reason) => {
            warn('the first prompt was not accepted', reason);
            if (!mountedRef.current) return;
            setSending(false);
            showPluginNotice(t('composer.sendFailed', { message: errorText(reason) }));
          })
          .finally(() => {
            sendingRef.current = false;
          });
      }, [send, sessionId, t, text]);

      const onKeyDown = React.useCallback((event) => {
        if (event === null || typeof event !== 'object') return;
        if (event.key !== 'Enter') return;
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
        const native = event.nativeEvent !== null && typeof event.nativeEvent === 'object' ? event.nativeEvent : event;
        // Never submit while an IME composition is being confirmed.
        if (native.isComposing === true || native.keyCode === 229) return;
        event.preventDefault();
        submit();
      }, [submit]);

      const onChange = React.useCallback((event) => {
        if (event === null || typeof event !== 'object') return;
        setText(typeof event.target.value === 'string' ? event.target.value : '');
      }, []);

      if (sessionId === undefined) return null;

      const canSend = !sending && text.trim() !== '';
      const outsideLabel = t('entry.outsideProject');
      const headline = stockT('hero.headline');
      const preview = stockT('hero.preview');
      const placeholder = stockT('placeholder.hero');
      const sendLabel = stockT('input.send');
      const addLabel = stockT('input.commands');

      // Standard Session kit for the stock control entries: everything this
      // entry received except the plugin's own inject and chain share.
      const standard = {};
      for (const key of Object.keys(input)) {
        if (key === 'cwd' || key === 'sendFirstPrompt' || key === 'matched' || key === 'slotsApi' || key === 'localeFace' || key === 't') continue;
        standard[key] = input[key];
      }
      const renderStock = makeStockRenderer(slotsApi, standard, sessionId, localeFace, t);
      const agentPreset = renderStock(STOCK_AGENT_PRESET_SLOT, {});
      const permission = renderStock(STOCK_PERMISSION_SLOT, { locked: sending });
      const plan = renderStock(STOCK_PLAN_SLOT, { locked: sending });
      const model = renderStock(STOCK_MODEL_SLOT, { locked: sending });
      // Keep the hero row identical to a normal start page, including the
      // plugin's own "outside workspace" entry on the right.
      const heroOptions = renderStock(HERO_SLOT, {});

      const folderIcon = h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        strokeWidth: 1,
      },
        h('path', {
          d: 'M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z',
          fill: 'currentColor',
          opacity: 0.16,
        }),
        h('path', {
          d: 'M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z',
          fill: 'currentColor',
        }),
      );
      const plusIcon = h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        strokeWidth: 1.3,
      },
        h('path', { d: 'M8 2V14', stroke: 'currentColor' }),
        h('path', { d: 'M2 8H14', stroke: 'currentColor' }),
      );
      const sendIcon = h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': 'true',
      }, h('path', {
        d: 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z',
        fill: 'currentColor',
      }));

      return h('div', {
        className: 'an3WzG_composerStack an3WzG_composerHero',
        'data-dsh-outside-workspace': 'composer',
      },
        h('div', { className: 'WOwLGG_root' },
          h('div', { className: 'WOwLGG_stack' },
            h('div', { className: 'WOwLGG_headline' },
              h('span', { className: 'WOwLGG_fishHitbox' }, heroFish()),
              h('span', { className: 'WOwLGG_titleGroup' },
                h('span', null, headline),
                h('span', { className: 'WOwLGG_previewBadge' }, preview),
              ),
            ),
            h('div', { className: 'WOwLGG_body' }),
          ),
        ),
        h('div', { className: 'an3WzG_heroWorkspaceRow' },
          h('span', {
            className: 'WOwLGG_workspace dsh-outside-ws-chip',
            title: cwd === undefined ? outsideLabel : cwd,
          },
            folderIcon,
            h('span', { className: 'WOwLGG_workspaceLabel' }, outsideLabel),
          ),
          agentPreset,
          h('div', { className: 'an3WzG_heroOptions' }, heroOptions),
        ),
        h('div', { className: 'GRgSLq_root GRgSLq_hero' },
          h('div', {
            className: 'GRgSLq_card',
            'data-composer-card': 'true',
            'data-dsh-outside-workspace': 'card',
          },
            h('div', { className: 'GRgSLq_scroll', 'data-input-scroll': 'true' },
              h('div', { className: 'GRgSLq_grow' },
                h('textarea', {
                  ref: textareaRef,
                  className: 'GRgSLq_input dsh-outside-ws-input',
                  'data-dsh-outside-workspace': 'input',
                  rows: 1,
                  value: text,
                  placeholder,
                  'aria-label': placeholder,
                  spellCheck: false,
                  disabled: sending,
                  onChange,
                  onKeyDown,
                }),
              ),
            ),
            h('div', { className: 'GRgSLq_row' },
              h('div', { className: 'GRgSLq_tools' },
                h('button', {
                  type: 'button',
                  className: 'GRgSLq_add',
                  'aria-label': addLabel,
                  title: addLabel,
                  onClick: (event) => {
                    if (event !== null && typeof event.preventDefault === 'function') event.preventDefault();
                    showPluginNotice(t('composer.limit'));
                  },
                }, plusIcon),
                h('div', { className: 'GRgSLq_modes' }, permission, plan),
              ),
              h('div', { className: 'GRgSLq_trailing' },
                h('div', { className: 'GRgSLq_standardControls' }, model),
                h('button', {
                  type: 'button',
                  className: 'GRgSLq_primary',
                  'data-dsh-outside-workspace': 'send',
                  'aria-label': sendLabel,
                  title: sendLabel,
                  'aria-busy': sending ? 'true' : 'false',
                  disabled: !canSend,
                  onClick: (event) => {
                    if (event !== null && typeof event.preventDefault === 'function') event.preventDefault();
                    submit();
                  },
                }, sendIcon),
              ),
            ),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Chain selector.
    //
    // Contract: pure function of the owner currency. It additionally consults
    // the plugin-local `outsideSessions` map — the documented pattern for a
    // temporary business-owned takeover, noted here deliberately. The owner
    // currency still dominates (the Session must be blank), ids are removed as
    // soon as the first prompt is accepted, and the map is bounded, so stale
    // memory can only ever elect the takeover over a still-blank Session this
    // plugin created.
    // ---------------------------------------------------------------------

    function selectOutsideComposer(owner) {
      if (owner === null || typeof owner !== 'object') return null;
      const sessionId = owner.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      const session = owner.session;
      if (session === null || session === undefined || typeof session !== 'object') return null;
      if (session.blank !== true) return null;
      if (!outsideSessions.has(sessionId)) return null;
      return { sessionId };
    }

    // ---------------------------------------------------------------------
    // Plugin wiring.
    // ---------------------------------------------------------------------

    /** Install the single plugin stylesheet; removed with the plugin fiber. */
    function installStyles(ctx) {
      try {
        if (typeof document === 'undefined' || document === null || document.head === null) return;
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-plugin', STYLE_PLUGIN_ID);
          style.setAttribute('data-outside-workspace', STYLE_MARKER);
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => {
            style.remove();
          };
        }, 'dsh-outside-workspace: styles');
      } catch (error) {
        warn('stylesheet installation failed; the plugin keeps working unstyled', error);
      }
    }

    /** Register zh/en dictionaries (untyped single-locale form). */
    function installLocale(ctx) {
      try {
        const locale = serviceOf(ctx, 'locale');
        if (locale === undefined || typeof locale.register !== 'function') {
          warn('locale service missing; entries will fall back to their copy');
          return;
        }
        ctx.effect(() => {
          const disposers = [];
          for (const [id, dict] of [['zh', ZH], ['en', EN]]) {
            try {
              disposers.push(locale.register(NS, id, dict));
            } catch (error) {
              warn(`locale "${id}" registration failed`, error);
            }
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch (error) {
                warn('locale disposer failed', error);
              }
            }
          };
        }, 'dsh-outside-workspace: dictionaries');
      } catch (error) {
        warn('locale installation failed', error);
      }
    }

    /** Hero-row list entry: the "Outside workspace" button. */
    function installHeroEntry(ctx) {
      try {
        ctx.slots.inject(HERO_SLOT, () => {
          try {
            return ctx.slots.register({
              name: HERO_SLOT,
              id: 'outside-workspace.open',
              order: 60,
              label: 'Outside workspace',
              locale: NS,
              inject: () => ({
                createOutsideSession: () => createOutsideSession(ctx),
              }),
            }, OutsideWorkspaceButton);
          } catch (error) {
            warn('hero entry registration failed', error);
            return () => {};
          }
        });
      } catch (error) {
        warn('hero entry slot injection failed', error);
      }
    }

    /** Chain takeover: the first-message composer for a blank outside Session. */
    function installComposerTakeover(ctx) {
      try {
        const localeFace = serviceOf(ctx, 'locale');
        ctx.slots.inject(COMPOSER_SLOT, () => {
          try {
            return ctx.slots.register({
              name: COMPOSER_SLOT,
              priority: 40,
              locale: NS,
              select: selectOutsideComposer,
              inject: (sessionId) => ({
                cwd: cwdOfSession(ctx, sessionId),
                sendFirstPrompt: (id, text) => sendFirstPrompt(ctx, id, text),
                slotsApi: ctx.slots,
                localeFace,
              }),
            }, FirstMessageComposer);
          } catch (error) {
            warn('composer takeover registration failed', error);
            return () => {};
          }
        });
      } catch (error) {
        warn('composer takeover slot injection failed', error);
      }
    }

    /**
     * Client plugin body. Cordis holds activation until the declared services
     * exist; each registration additionally degrades to a warning instead of
     * breaking the rest of the client.
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      if (ctx === null || typeof ctx !== 'object') {
        warn('apply received no client context');
        return;
      }
      installStyles(ctx);
      installLocale(ctx);
      installHeroEntry(ctx);
      installSidebarEntry(ctx);
      installComposerTakeover(ctx);
    }

    return {
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'locale', 'remote'],
      apply,
    };
  },
});
