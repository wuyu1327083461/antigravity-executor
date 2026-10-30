/**
 * DSH client integration — the sidebar panel icon and the War Room iframe panel.
 *
 * WHY NOT A SECOND HAND-CRAFTED REACT UI?
 * ---------------------------------------
 * An earlier revision implemented a parallel React War Room inside `client.js`.
 * Maintaining two separate interfaces (one in `ui/index.html` and one in
 * `client.js`) caused visual and behavioral divergence: element density,
 * typography, margin, toggle styling, and specialized widgets (branding,
 * preview split pane, artifact drawer) were duplicated and drifted apart.
 * Rendering the same `ui/index.html` inside an embedded iframe ensures both
 * standalone and embedded views share identical DOM, CSS, and feature sets.
 *
 * WHY A SAME-ORIGIN IFRAME INSTEAD OF A DIRECT CROSS-PORT CONNECTION?
 * -------------------------------------------------------------------
 * The standalone dashboard server listens on http://127.0.0.1:18420. Directly
 * pointing an iframe or fetch requests from DSH (http://127.0.0.1:3080) across
 * ports to 18420 fails:
 *   1. The dashboard server enforces strict loopback Origin checks on mutating
 *      calls (REQ-04 §4.2), rejecting foreign origins.
 *   2. Cross-origin SSE (`EventSource`) and preview assets would require CORS
 *      and credential juggling.
 * DeepSeek Harness mounts a same-origin reverse proxy under the prefix
 * `/antigravity-executor/` (see `lib/proxy.mjs` and `lib/index.js`), forwarding
 * requests transparently to the backend. Using a same-origin iframe allows
 * seamless API calls, SSE streaming, and theme synchronization without CORS or
 * Origin rejection.
 *
 * WHY A SIDEBAR GLOBAL PANEL ICON INSTEAD OF THE "MORE" MENU?
 * -----------------------------------------------------------
 * Previously, the War Room entry was hidden inside the secondary "More" menu,
 * making it hard to find and requiring manual layout panel switching. By
 * contributing directly to `sidebar.panellist` with a dedicated radar/cockpit
 * icon, DSH natively manages panel selection and display in the centre column
 * via the matching `PANEL_ID`.
 *
 * @module antigravity-executor/client
 */

window.__ModuleLoader__.load({
  id: 'antigravity-executor',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Panel id; also the `main` slot key and the sidebar entry id. */
    const PANEL_ID = 'antigravity-warroom'

    // -----------------------------------------------------------------------
    // URL Resolution
    // -----------------------------------------------------------------------

    const PLACEHOLDER_ORIGIN = 'http://dsh.internal/'
    function directoryBase(baseUrl) {
      const url = new URL(baseUrl === '' ? PLACEHOLDER_ORIGIN : baseUrl, PLACEHOLDER_ORIGIN)
      url.search = ''; url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      return url.href
    }
    function hostRouteUrl(path, baseUrl = (typeof document !== 'undefined' ? document.baseURI : '')) {
      return new URL(path.replace(/^\/+/, ''), directoryBase(baseUrl))
    }

    const PANEL_SRC = hostRouteUrl('antigravity-executor/').href

    // -----------------------------------------------------------------------
    // Theme Detection
    // -----------------------------------------------------------------------

    function getHostBody() {
      try {
        if (typeof window !== 'undefined' && window.parent && window.parent.document && window.parent.document.body) {
          return window.parent.document.body
        }
        if (typeof document !== 'undefined' && document.body) {
          return document.body
        }
      } catch {
        if (typeof document !== 'undefined' && document.body) {
          return document.body
        }
      }
      return null
    }

    function readHostTheme() {
      try {
        const body = getHostBody()
        if (body) {
          return body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
        }
      } catch {
        /* cross-origin fallback */
      }
      return 'dark'
    }

    // -----------------------------------------------------------------------
    // Styles
    // -----------------------------------------------------------------------

    const CSS = `
.agy-frame-wrap {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.agy-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
}
`

    /**
     * Install this plugin's stylesheet.
     *
     * WHY NOT THE `styles` BUILTIN
     * ---------------------------
     * `styles.insert` exists only for dynamic cordis plugins where the runner
     * passes it into the evaluated module as a global. A static bundle like this
     * one runs through `__ModuleLoader__` and receives only `require`, so
     * `typeof styles` is `"undefined"`. A plain `<style data-plugin-css>` tag
     * works in all hosts, and the returned disposer cleans it up on unload.
     */
    const installStyles = () => {
      if (typeof document === 'undefined') return () => {}
      const tagId = 'antigravity-executor/panel.css'
      const existing = document.querySelector(`style[data-plugin-css="${tagId}"]`)
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'antigravity-executor'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        try {
          tag.remove()
        } catch {
          /* already detached */
        }
      }
    }

    // -----------------------------------------------------------------------
    // UI Components
    // -----------------------------------------------------------------------

    /**
     * Radar / cockpit icon for the global sidebar panel list.
     * Only currentColor is used; active toggles line thickness.
     */
    function WarRoomIcon({ size, active }) {
      const sw = active ? 2 : 1.6
      return h(
        'svg',
        {
          width: size || 20,
          height: size || 20,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: sw,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M12 7a5 5 0 0 1 5 5' }),
        h('line', { x1: 12, y1: 3, x2: 12, y2: 21 }),
        h('line', { x1: 3, y1: 12, x2: 21, y2: 12 }),
        h('circle', { cx: 12, cy: 12, r: 1.5, fill: 'currentColor' }),
      )
    }

    /**
     * Fallback localization dictionary when ctx.locale is unavailable.
     */
    const COPY = {
      'panel.title': 'Antigravity 驾驶舱',
    }

    let t = (key) => COPY[key] || key

    /**
     * Centre column panel embedding the dashboard via same-origin iframe.
     */
    function WarRoomPanel() {
      const [theme, setTheme] = React.useState(() => ({ colorScheme: readHostTheme() }))

      React.useEffect(() => {
        function syncTheme() {
          setTheme({ colorScheme: readHostTheme() })
        }
        syncTheme()

        let observer = null
        try {
          const body = getHostBody()
          if (body && typeof MutationObserver !== 'undefined') {
            observer = new MutationObserver(syncTheme)
            observer.observe(body, {
              attributes: true,
              attributeFilter: ['data-ds-dark-theme', 'style'],
            })
          }
        } catch {
          /* cross-origin fallback */
        }

        return () => {
          if (observer) {
            observer.disconnect()
          }
        }
      }, [])

      return h(
        'div',
        {
          className: 'agy-frame-wrap',
          style: {
            height: '100%',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            colorScheme: theme.colorScheme,
          },
        },
        h('iframe', {
          src: PANEL_SRC,
          title: t('panel.title'),
          className: 'agy-frame',
          style: {
            display: 'block',
            width: '100%',
            height: '100%',
            border: 0,
            background: 'transparent',
            colorScheme: theme.colorScheme,
          },
        }),
      )
    }

    // -----------------------------------------------------------------------
    // Activation & Registration
    // -----------------------------------------------------------------------

    function activateClientHalf(ctx) {
      ctx.effect(installStyles, 'antigravity-executor: panel styles')

      const contribute = (tag, register) => {
        try {
          ctx.slots.inject(tag, register)
        } catch (error) {
          console.warn(`[antigravity-executor] slot "${tag}" unavailable:`, error)
        }
      }

      try {
        ctx.effect(
          () =>
            ctx.locale.register('antigravityExecutor', {
              zh: { name: COPY['panel.title'], 'panel.title': COPY['panel.title'] },
              en: {
                name: 'Antigravity War Room',
                'panel.title': 'Antigravity War Room',
              },
            }),
          'antigravity-executor: locale',
        )
        t = ctx.locale.bind('antigravityExecutor')
      } catch (error) {
        console.warn('[antigravity-executor] locale service unusable, using built-in copy:', error)
      }

      contribute('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: () => t('panel.title'),
            locale: 'antigravityExecutor',
          },
          WarRoomIcon,
        ),
      )

      contribute('main', () =>
        ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: 'antigravityExecutor' },
          WarRoomPanel,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          activateClientHalf(ctx)
        } catch (error) {
          console.error('[antigravity-executor] client activation failed', error)
        }
      },
    }
  },
})
