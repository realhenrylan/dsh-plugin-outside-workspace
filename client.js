/*
 * dsh-outside-workspace — browser half.
 *
 * Lets the operator start a session OUTSIDE every registered workspace
 * (Codex-style "projectless chat") with its cwd in a default directory under
 * the Host account's Documents folder.
 *
 * The feature is two slot contributions:
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
 *     membership), so a first-message composer card is taken over only for a
 *     blank Session this plugin just created. Once the first prompt is
 *     accepted the Session stops being blank, the selector declines, and the
 *     stock conversation UI takes over by itself.
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
 *    command chips, no queue/steer choice). After the first message the stock
 *    composer owns everything.
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

    /** Locale namespace shared by both slot contributions. */
    const NS = 'dsh-outside-workspace';
    const LOG_PREFIX = '[dsh-outside-workspace]';
    /** Slot keys this plugin contributes to (declared by ui-conversation). */
    const HERO_SLOT = 'conversation.hero.options';
    const COMPOSER_SLOT = 'conversation.composer';
    /** Path segments below the Documents folder of the Host account. */
    const OUTSIDE_SEGMENTS = ['deepseek-harness', 'outside-workspace'];
    /** Upper bound for the plugin-local created-Session memory. */
    const MAX_TRACKED = 50;
    /** Inline style element identity (also used for HMR/teardown cleanup). */
    const STYLE_PLUGIN_ID = 'dsh-outside-workspace';
    const STYLE_MARKER = 'outside-workspace-styles';

    // ---------------------------------------------------------------------
    // Locale dictionaries (registered untyped: one register per language).
    // ---------------------------------------------------------------------

    const ZH = {
      'entry.label': '不在工作区',
      'entry.title': '在默认目录新建一个不属于任何工作区的会话',
      'entry.busy': '创建中…',
      'entry.error': '无法创建会话：{message}',
      'entry.unavailable': '会话服务不可用',
      'composer.title': '工作区外会话',
      'composer.placeholder': '输入第一条消息，就开始在这个目录里工作…',
      'composer.hint': 'Enter 发送 · Shift+Enter 换行',
      'composer.send': '发送',
      'composer.sending': '发送中…',
      'composer.sendFailed': '发送失败：{message}',
      'composer.unknownDirectory': '目录未知',
    };

    const EN = {
      'entry.label': 'Outside workspace',
      'entry.title': 'Start a session outside every workspace, in the default directory',
      'entry.busy': 'Creating…',
      'entry.error': 'Could not create the session: {message}',
      'entry.unavailable': 'Session service unavailable',
      'composer.title': 'Outside workspace',
      'composer.placeholder': 'Type the first message to start working in this directory…',
      'composer.hint': 'Enter to send · Shift+Enter for a new line',
      'composer.send': 'Send',
      'composer.sending': 'Sending…',
      'composer.sendFailed': 'Send failed: {message}',
      'composer.unknownDirectory': 'Unknown directory',
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
   descendant: the seat fills the scroll area and centers our card in both the
   hero and the engaging phase (the stock fallback is hidden while elected). */
[data-composer-seat]:has([data-dsh-outside-workspace="composer"]) {
  flex: 1 1 auto;
  min-height: 0;
  justify-content: center;
}
.dsh-outside-ws-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(calc(var(--dsh-composer-card-max-width, 712px) + 2 * var(--dsh-composer-side-clearance, 16px)), 100%);
  margin: 0 auto 32px;
  padding: 12px 14px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
.dsh-outside-ws-card:focus-within {
  border-color: var(--dsw-alias-border-l3);
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary);
}
.dsh-outside-ws-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.dsh-outside-ws-title {
  flex: none;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-outside-ws-cwd {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code, monospace);
  font-size: 12px;
  line-height: 18px;
}
.dsh-outside-ws-textarea {
  box-sizing: border-box;
  display: block;
  width: 100%;
  min-height: 66px;
  max-height: 240px;
  padding: 2px 0;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
}
.dsh-outside-ws-textarea::placeholder {
  color: var(--dsw-alias-label-caption);
}
.dsh-outside-ws-textarea:disabled {
  opacity: 0.7;
}
.dsh-outside-ws-error {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dsh-outside-ws-foot {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dsh-outside-ws-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  line-height: 18px;
}
.dsh-outside-ws-send {
  box-sizing: border-box;
  flex: none;
  height: 30px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  cursor: pointer;
}
.dsh-outside-ws-send:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}
.dsh-outside-ws-send:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}
.dsh-outside-ws-send:disabled {
  opacity: 0.45;
  cursor: default;
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

      const [text, setText] = React.useState('');
      const [sending, setSending] = React.useState(false);
      const [error, setError] = React.useState(null);
      const textareaRef = React.useRef(null);
      const sendingRef = React.useRef(false);
      const mountedRef = React.useRef(true);

      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      // Focus the empty first-message editor on mount and after a failed send.
      React.useEffect(() => {
        if (sending) return;
        const node = textareaRef.current;
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus();
      }, [sending]);

      const submit = React.useCallback(() => {
        if (sendingRef.current) return;
        if (sessionId === undefined) return;
        if (text.trim() === '') return;
        if (typeof send !== 'function') {
          setError(t('composer.sendFailed', { message: t('entry.unavailable') }));
          return;
        }
        sendingRef.current = true;
        setSending(true);
        setError(null);
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
            setError(t('composer.sendFailed', { message: errorText(reason) }));
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

      const cwdLabel = cwd === undefined ? t('composer.unknownDirectory') : cwd;
      const canSend = !sending && text.trim() !== '';

      return h('div', {
        className: 'dsh-outside-ws-card',
        'data-dsh-outside-workspace': 'composer',
      },
        h('div', { className: 'dsh-outside-ws-head' },
          h('span', { className: 'dsh-outside-ws-title' }, t('composer.title')),
          h('span', { className: 'dsh-outside-ws-cwd', title: cwdLabel }, cwdLabel),
        ),
        h('textarea', {
          ref: textareaRef,
          className: 'dsh-outside-ws-textarea',
          'data-dsh-outside-workspace': 'input',
          rows: 3,
          value: text,
          placeholder: t('composer.placeholder'),
          'aria-label': t('composer.placeholder'),
          spellCheck: false,
          disabled: sending,
          onChange,
          onKeyDown,
        }),
        error === null ? null : h('div', {
          className: 'dsh-outside-ws-error',
          'data-dsh-outside-workspace': 'send-error',
          role: 'alert',
        }, error),
        h('div', { className: 'dsh-outside-ws-foot' },
          h('span', { className: 'dsh-outside-ws-hint' }, t('composer.hint')),
          h('button', {
            type: 'button',
            className: 'dsh-outside-ws-send',
            'data-dsh-outside-workspace': 'send',
            disabled: !canSend,
            'aria-busy': sending ? 'true' : 'false',
            onClick: (event) => {
              if (event !== null && typeof event.preventDefault === 'function') event.preventDefault();
              submit();
            },
          }, sending ? t('composer.sending') : t('composer.send')),
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
      installComposerTakeover(ctx);
    }

    return {
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'locale', 'remote'],
      apply,
    };
  },
});
