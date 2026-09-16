/**
 * dsh-clinepass —— 浏览器半边：**设置 → 模型 → Cline Pass** 卡片上的用量条。
 *
 * 为什么手写：dsh 的客户端插件通常用 tsdown + 共享 preset 构建，而那需要一份
 * dsh 源码 checkout；本机只有已安装的 profile，所以这里直接产出客户端模块系统
 * 要求的形状（契约见文件末尾）。产物只有 Node 内置模块之外的 **React**，而
 * React 由 web shell 的静态模块表提供，因此不需要写进 `dsh.client.external`。
 *
 * 挂载点：dsh 的 Models 设置页专门给外部插件留了
 * `settings.models.provider-card` 这个 slot（keyed，按 provider 所属的 settings
 * 命名空间派发）。本插件注册到 `llm-pi-ai` 这个 key 上，于是能拿到**每一条**
 * pi-ai 路由的卡片，再自己筛出 `cline-pass` —— 其它 provider 的卡片直接返回
 * null，一个字节都不多渲染。这是官方文档明确支持的扩展点
 * （`@deepseek-ai/dsh-client-ui-settings-models/lib/types/client/slot-contract.d.ts`），
 * 不是补丁，所以 dsh 升级不会把它打散。
 *
 * 数据从哪来：**不在浏览器里取**。dsh 的凭据设计是「密钥只能写、不能读」
 * （`credentials/set` 单向，没有任何 read 路径），所以浏览器拿不到 API key，
 * 也就无法直接请求 Cline。宿主半边把 key 从凭据库取出来、请求网关，再把**只有
 * 用量数字**的 JSON 挂在本文件读取的那条同源路径上。这条路径注册在 dsh 自己
 * 已经跑着的 HTTP 服务上（`ctx.connection.fetch.register`），**不是新端口、
 * 不是新监听**，而且走 dsh 自己的 Host/Origin 信任栅栏与浏览器 cookie 认证。
 *
 * 刻意不做的事：不缓存密钥、不把密钥写进 DOM、不引入任何第三方依赖、不改动
 * 卡片本身的结构（只在卡片内部追加一段只读信息）。
 *
 * @module dsh-clinepass/client
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load({
    id: 'dsh-clinepass',
    factory: function (require) {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      var React = require('react')

      // ═══════════════════════════ 常量 ═══════════════════════════

      /** 卡片所属的 settings 命名空间：slot 的 key。 */
      var SETTINGS_NS = 'llm-pi-ai'

      /** 只在这条路由的卡片上渲染。 */
      var PROVIDER = 'cline-pass'

      /** 宿主半边的默认路径；宿主会通过 index 注入把真实值送到这个全局。 */
      var DEFAULT_ROUTE = '/api/clinepass.usage'

      /** 宿主注入的路由表（`webServer/index-inject` 的 global 行）。 */
      var BOOT_GLOBAL = '__DSH_CLINEPASS__'

      /** 三个窗口，按显示顺序；`type` 就是网关返回的那个字符串。 */
      var WINDOWS = ['five_hour', 'weekly', 'monthly']

      /** 倒计时刷新间隔：窗口以小时/天计，30 秒足够准，也不会一直重渲染。 */
      var TICK_MS = 30 * 1000

      /** 浏览器到 dsh 这一段的超时；宿主那一段另有 usageTimeoutMs。 */
      var CLIENT_TIMEOUT_MS = 20 * 1000

      // 主题 token 取自 dsh 自己的设计变量，各带一个回退值：token 改名时
      // 样子会退回中性灰，而不是变成透明或黑块。
      var LABEL_PRIMARY = 'var(--dsw-alias-label-primary, #1f2329)'
      var LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, #6b7280)'
      var LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary, #9ca3af)'
      var BORDER = 'var(--dsw-alias-border-l2, #e5e7eb)'
      var TRACK = 'var(--dsw-alias-bg-layer-3, #eceef1)'
      var OK = 'var(--dsw-alias-state-success-primary, #12a150)'
      var WARN = 'var(--dsw-alias-state-warn-primary, #d97706)'
      var DANGER = 'var(--dsw-alias-state-error-primary, #dc2626)'
      var LINK = 'var(--dsw-alias-link, #2563eb)'

      // ═══════════════════════════ 文案 ═══════════════════════════
      // 刻意只在文件里放中英两套，而不去 locale 注册表里占一个命名空间：本插件
      // 的文本量是十几个 key，注册一个命名空间会让「重复注册」成为一次热重载
      // 的失败点，而收益只是少两行字典。当前语言仍然读 dsh 自己的 locale 服务，
      // 所以「设置 → 通用 → 语言」切到英文时这里会跟着切。

      var TEXT = {
        zh: {
          // 标题里点明是「剩余」：右边那个百分比是裸数字，不写清楚就只能靠猜
          // 它到底是已用还是剩余 —— 这正是这次改动要消掉的不确定性。
          title: 'ClinePass 剩余用量',
          refresh: '刷新',
          loading: '读取中…',
          updated: '更新于 {time}',
          left: '剩余 {percent}%',
          resetsIn: '{when} 后重置',
          resetsAt: '{time} 重置',
          resetting: '即将重置',
          noKey: '还没填 API 密钥 —— 在下面「API 密钥」里填入后保存。',
          unauthorized: '网关拒绝了这把 API 密钥，请重新填写。',
          rateLimited: '网关正在限流，稍后再试。',
          unavailable: '网关暂时不可用。',
          timeout: '读取用量超时了。',
          network: '连不上网关。',
          parse: '网关返回了读不懂的内容。',
          noCredentials: '这个 dsh 没有可读的凭据库。',
          internal: '读取失败，细节见 dsh 日志。',
          unmounted: '这个 dsh 没有挂载用量路由（`usage: false`？）。',
          empty: '网关没有返回任何窗口。',
          retry: '重试',
          five_hour: '5 小时',
          weekly: '每周',
          monthly: '每月',
        },
        en: {
          title: 'ClinePass remaining usage',
          refresh: 'Refresh',
          loading: 'Loading…',
          updated: 'updated {time}',
          left: '{percent}% left',
          resetsIn: 'resets in {when}',
          resetsAt: 'resets {time}',
          resetting: 'resetting now',
          noKey: 'No API key yet — enter one under “API key” below and save.',
          unauthorized: 'The gateway rejected this API key; enter it again.',
          rateLimited: 'The gateway is rate limiting; try again shortly.',
          unavailable: 'The gateway is temporarily unavailable.',
          timeout: 'The usage read timed out.',
          network: 'Could not reach the gateway.',
          parse: 'The gateway answered with something unreadable.',
          noCredentials: 'This dsh has no readable credential store.',
          internal: 'The read failed; see the dsh log.',
          unmounted: 'This dsh is not serving the usage route — is the feature disabled?',
          empty: 'The gateway reported no windows.',
          retry: 'Retry',
          five_hour: '5-hour',
          weekly: 'Weekly',
          monthly: 'Monthly',
        },
      }

      /** 取一套文案并把 `{name}` 占位替换掉。 */
      function fill(template, values) {
        return String(template).replace(/\{(\w+)\}/g, function (whole, name) {
          return values !== undefined && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
        })
      }

      // ═══════════════════════════ 纯函数 ═══════════════════════════

      /** 宿主注入的用量路径，拿不到就用默认值（静态部署等边缘情况）。 */
      function usageRoute() {
        var boot = window[BOOT_GLOBAL]
        if (boot !== null && typeof boot === 'object' && typeof boot.usageRoute === 'string' && boot.usageRoute.length > 0) return boot.usageRoute
        return DEFAULT_ROUTE
      }

      /**
       * 宿主是否挂载了用量路由。
       *
       * `usage: false` 只让宿主不注册路由，**不会**把浏览器半边从页面上拿掉
       * （bundle 是从 package.json 发现并加载的，跟配置无关）。所以宿主会显式
       * 广播 `enabled: false`，让这张卡片干脆不渲染 —— 否则它会去请求一条不存在的
       * 路径、拿到 404 页面，然后一直显示"连不上网关"，而那只刷新按钮永远修不好它。
       * 老宿主没有这个字段时按"挂载了"处理，保持旧行为。
       */
      function usageEnabled() {
        var boot = window[BOOT_GLOBAL]
        if (boot !== null && typeof boot === 'object' && boot.enabled === false) return false
        return true
      }

      /**
       * 请求 URL。用 `URL` 而不是字符串拼 `?refresh=1`：`usageRoute` 是可配置的，
       * 一个已经带查询串的路径（`/api/x?token=y`）拼出来就是个坏 URL。
       */
      function usageUrl(force) {
        var route = usageRoute()
        if (force !== true) return route
        try {
          var url = new URL(route, window.location.origin)
          url.searchParams.set('refresh', '1')
          return url.pathname + url.search
        } catch (error) {
          return route
        }
      }

      /**
       * 不是宿主那封信的响应 → 失败原因。
       *
       * 按状态码分，而不是一律 `network`：404 是"宿主没挂这条路由"，5xx 是
       * "dsh 自己出问题了"，两者都不该把用户引去查本机到网关的网络。
       */
      function statusReason(status) {
        if (status === 401 || status === 403) return 'unauthorized'
        if (status === 404) return 'unmounted'
        if (status === 429) return 'rateLimited'
        if (status >= 500) return 'unavailable'
        return 'http'
      }

      /**
       * 把剩余毫秒说成人话。窗口最长一个月，所以「天」一定要有；
       * 超过一天时不再显示分，避免一行数字读不过来。
       *
       * @param ms - 距离重置的毫秒数。
       * @param zh - 是否用中文单位。
       */
      function remainingText(ms, zh) {
        if (!isFinite(ms)) return ''
        if (ms <= 0) return ''
        var minutes = Math.floor(ms / 60000)
        var hours = Math.floor(minutes / 60)
        var days = Math.floor(hours / 24)
        if (days > 0) return days + (zh ? ' 天 ' : 'd ') + (hours % 24) + (zh ? ' 小时' : 'h')
        if (hours > 0) return hours + (zh ? ' 小时 ' : 'h ') + (minutes % 60) + (zh ? ' 分' : 'm')
        return minutes + (zh ? ' 分钟' : 'm')
      }

      /**
       * 网关只给 `percentUsed`（响应里没有绝对额度字段），所以「剩余」只能是
       * `100 - 已用`。先按一位小数收口再取差：直接 `100 - 82.4` 会得到
       * `17.599999999999994` 这种浮点尾巴，而那不是「剩余 17.6%」。
       */
      function remainingPercent(used) {
        var value = Math.round((100 - used) * 10) / 10
        return Math.max(0, Math.min(100, value))
      }

      /**
       * 一条窗口记录，读不懂就返回 null。
       *
       * 这不是多余的谨慎。宿主侧的 `normalizeUsage` 已经筛过一遍，但
       * `usageRoute` 是可配置的 —— 指向别的东西时，`limits` 里一个 `null` 元素
       * 就会在渲染里对 `limit.type` 抛异常，而 slot 的 error boundary 会把它吞成
       * 一个**不可见的空 div**，并且这一格 keyed slot 就此作废：整张卡片在本次
       * 页面会话里再也不会出现，界面上没有任何解释。宁可少画一行。
       *
       * 顺带挡住 `NaN`：`Math.min(100, Math.max(0, NaN))` 还是 `NaN`，那会画成一条
       * 0 宽、**绿色**、写着 `NaN%` 的条 —— 一个看起来完全健康的坏值。
       * `percentUsed: null` 更糟：`100 - null` 是 100，会显示成「剩余 100%」。
       */
      function normalizeLimit(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
        var used = value.percentUsed
        if (typeof used !== 'number' || isFinite(used) !== true) return null
        var at = typeof value.resetsAt === 'string' ? new Date(value.resetsAt) : null
        return {
          remaining: remainingPercent(used),
          resetsAt: at !== null && isNaN(at.getTime()) === false ? at : null,
        }
      }

      /** 剩余量分档：决定进度条的颜色。剩余 ≤10% 是红，≤30% 是黄。 */
      function severityColor(remaining) {
        if (remaining <= 10) return DANGER
        if (remaining <= 30) return WARN
        return OK
      }

      /**
       * 宿主失败原因 → 文案 key。
       *
       * 宿主说的是连字符形式（`no-key`），文案表用的是驼峰，所以这里必须有一张
       * 显式的表：靠字符串变形去猜（连字符转驼峰）会在加一个原因时静默退回
       * 「读取失败」，而那正是最难查的一类 bug。认不出的原因一律 `internal`。
       */
      var REASON_KEY = {
        'no-key': 'noKey',
        unmounted: 'unmounted',
        'no-credentials': 'noCredentials',
        unauthorized: 'unauthorized',
        'rate-limited': 'rateLimited',
        unavailable: 'unavailable',
        timeout: 'timeout',
        network: 'network',
        parse: 'parse',
        http: 'internal',
        internal: 'internal',
      }

      /** 失败原因 → 一句人话；认不出的原因退回「读取失败」。 */
      function reasonText(reason, t) {
        var key = typeof reason === 'string' ? REASON_KEY[reason] : undefined
        return key !== undefined ? t[key] : t.internal
      }

      // ═══════════════════════════ 组件 ═══════════════════════════

      /** 读 dsh 当前语言（'zh' / 'en'），拿不到就按英文。 */
      function useLanguage(ctx) {
        var locale = ctx.locale
        var usable = locale !== undefined && typeof locale.subscribe === 'function' && typeof locale.getSnapshot === 'function'
        // 两个回调的身份必须稳定，否则每次渲染都会退订再订阅一次。三个 hook 都
        // 无条件调用 —— 拿不到 locale 时退化成"永远英文"，而不是少调一个 hook。
        var subscribe = React.useCallback(
          function (notify) {
            return usable ? locale.subscribe(notify) : function () {}
          },
          [locale, usable],
        )
        var snapshot = React.useCallback(
          function () {
            if (!usable) return 'en'
            var current = locale.getSnapshot()
            return current !== null && typeof current === 'object' ? String(current.active) : 'en'
          },
          [locale, usable],
        )
        var active = React.useSyncExternalStore(subscribe, snapshot)
        return active.indexOf('zh') === 0 ? 'zh' : 'en'
      }

      /** 每 TICK_MS 变一次的时钟，只为让倒计时自己走。 */
      /**
       * 倒计时用的「现在」。`ticking` 为假时**不排定时器**。
       *
       * 这个 hook 在每一条 llm-pi-ai 卡片上都会被调用（hook 不能有条件），但
       * 只有本路由那张卡片真的需要它 —— 于是把"要不要跑"作为参数传进来。否则
       * 每多一个 provider 就多一个每 30 秒空转一次、只为了返回 null 的定时器。
       */
      function useNow(ticking) {
        var pair = React.useState(function () {
          return Date.now()
        })
        var now = pair[0]
        var setNow = pair[1]
        React.useEffect(
          function () {
            if (ticking !== true) return undefined
            var timer = window.setInterval(function () {
              setNow(Date.now())
            }, TICK_MS)
            return function () {
              window.clearInterval(timer)
            }
          },
          [ticking],
        )
        return now
      }

      /**
       * 一条窗口：标签 / 进度条 / **剩余**百分比 / 重置时间。
       *
       * 进度条画的是剩余量（油表：越满 = 剩得越多，快见底变红），和右边那个
       * 数字是同一个量 —— 数字说「剩 18%」而条子填了 82% 会自相矛盾。
       * @param props - `{ type, row, now, t, zh, locale }`，`row` 是 `normalizeLimit` 的产物。
       */
      function UsageRow(props) {
        var t = props.t
        var row = props.row
        var remaining = row.remaining
        var label = Object.prototype.hasOwnProperty.call(t, props.type) ? t[props.type] : String(props.type)
        var reset = row.resetsAt
        var resetMs = reset === null ? Number.NaN : reset.getTime() - props.now
        return React.createElement(
          'div',
          { style: { marginTop: 6 } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement(
              'span',
              { style: { flex: '0 0 52px', fontSize: 12, color: LABEL_SECONDARY } },
              label,
            ),
            React.createElement(
              'div',
              {
                style: { flex: '1 1 auto', height: 6, borderRadius: 3, background: TRACK, overflow: 'hidden' },
                role: 'progressbar',
                'aria-valuenow': remaining,
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                'aria-label': label + ' ' + fill(t.left, { percent: remaining }),
              },
              React.createElement('div', {
                style: {
                  width: remaining + '%',
                  height: '100%',
                  borderRadius: 3,
                  background: severityColor(remaining),
                  transition: 'width .3s ease',
                },
              }),
            ),
            React.createElement(
              'span',
              {
                style: {
                  flex: '0 0 auto',
                  minWidth: 34,
                  textAlign: 'right',
                  fontSize: 12,
                  color: LABEL_PRIMARY,
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              remaining + '%',
            ),
          ),
          reset === null
            ? null
            : React.createElement(
                'div',
                { style: { marginLeft: 60, fontSize: 11, color: LABEL_TERTIARY } },
                resetMs <= 0
                  ? t.resetting
                  : fill(t.resetsIn, { when: remainingText(resetMs, props.zh) }) +
                      ' · ' +
                      fill(t.resetsAt, { time: reset.toLocaleString(props.locale) }),
              ),
        )
      }

      /**
       * 卡片上追加的用量区。
       *
       * 收到的 owner props 是 `{ provider, configured, keyConfigured }`；本组件
       * 在**每一条** llm-pi-ai 卡片上都会被调用，所以第一件事就是把非本路由的
       * 卡片原样放过（返回 null）。
       */
      function UsageCard(props) {
        var ctx = props.ctx
        var entry = props.provider
        var isOurs = entry !== null && typeof entry === 'object' && entry.provider === PROVIDER
        var enabled = usageEnabled()
        var keyConfigured = props.keyConfigured
        var language = useLanguage(ctx)
        var zh = language === 'zh'
        var t = TEXT[language]
        var pair = React.useState({ status: 'loading', body: null })
        var state = pair[0]
        var setState = pair[1]
        // 只有本路由、且真的挂载了，才需要这个每 30 秒的定时器。
        var now = useNow(isOurs && enabled)
        // 手动刷新与自动刷新共用一个代次：后发的结果覆盖先发的，卸载后不回写。
        var generation = React.useRef(0)
        // 区分「刚挂载」与「key 变了」：前者走宿主缓存，后者强制绕过。
        var firstRead = React.useRef(true)

        var load = React.useCallback(
          function (force) {
            var mine = generation.current + 1
            generation.current = mine
            // 函数式 setState：刷新时保留上一次的数（避免整块闪成"读取中"），
            // 而且不需要把 state 放进依赖里 —— 那会让 load 每次渲染都换身份。
            setState(function (previous) {
              return { status: 'loading', body: previous.body }
            })
            // 自己也要有超时：宿主只保证它到网关那一段（默认 15 秒）。没有这个，
            // 一个卡住的 dsh 会让卡片永远停在"读取中"，而刷新按钮在 loading 时是
            // 禁用的 —— 用户没有任何可点的东西。
            var controller = typeof AbortController === 'function' ? new AbortController() : null
            var timer =
              controller === null
                ? null
                : window.setTimeout(function () {
                    controller.abort()
                  }, CLIENT_TIMEOUT_MS)
            window
              .fetch(usageUrl(force), {
                headers: { accept: 'application/json' },
                credentials: 'same-origin',
                signal: controller === null ? undefined : controller.signal,
              })
              .then(function (response) {
                return response.json().then(
                  function (body) {
                    return { response: response, body: body }
                  },
                  function () {
                    return { response: response, body: null }
                  },
                )
              })
              .then(function (result) {
                if (generation.current !== mine) return
                if (result.body !== null && typeof result.body === 'object' && typeof result.body.ok === 'boolean') {
                  setState({ status: 'ready', body: result.body })
                  return
                }
                // 不是宿主那封信（404 页面、HTML 错误页、代理的 502……）。按状态码
                // 说人话，别一律报"连不上网关" —— 那会把用户引去查网络，而网关
                // 根本没被联系过。
                setState({ status: 'ready', body: { ok: false, reason: statusReason(result.response.status) } })
              })
              .catch(function (error) {
                if (generation.current !== mine) return
                var aborted = error !== null && typeof error === 'object' && (error.name === 'AbortError' || error.name === 'TimeoutError')
                setState({ status: 'ready', body: { ok: false, reason: aborted ? 'timeout' : 'network' } })
              })
              .then(
                function () {
                  if (timer !== null) window.clearTimeout(timer)
                },
                function () {
                  if (timer !== null) window.clearTimeout(timer)
                },
              )
          },
          [],
        )

        // 挂载时读一次（走宿主缓存，不白打一次网关）；之后 key 的「已配置」状态
        // 一变（用户在下面保存了新 key）就**强制**再读一次 —— 强制是必要的：宿主
        // 对失败也有一小段短期缓存，不强制的话「填好新 key，下一次看就是新的」会被
        // 那几秒挡掉。首读与"key 变了"要分开，所以用一个 ref 记住是不是第一次。
        React.useEffect(
          function () {
            if (!isOurs || !enabled) return undefined
            var force = firstRead.current !== true
            firstRead.current = false
            load(force)
            return function () {
              generation.current += 1
            }
          },
          [isOurs, enabled, load, keyConfigured],
        )

        if (!isOurs || !enabled) return null

        var body = state.body
        var failed = body !== null && body.ok !== true
        // 逐条收窄再渲染：一个坏元素不值得让整张卡片（连同 keyed slot 的那一格）
        // 消失。而且这里**按 `WINDOWS` 取值**而不是遍历响应数组：顺序因此固定，
        // 网关的实验性窗口不会被画上来，重复的 type 也只取第一条 —— 和宿主侧
        // `normalizeUsage` 是同一套规则，所以那条响应换个顺序、多几个字段都不会
        // 改变这张卡片的样子。
        var byType = Object.create(null)
        if (body !== null && body.ok === true && Array.isArray(body.limits)) {
          for (var index = 0; index < body.limits.length; index += 1) {
            var candidate = body.limits[index]
            if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
            if (typeof candidate.type !== 'string' || byType[candidate.type] !== undefined) continue
            byType[candidate.type] = candidate
          }
        }
        var limits = []
        for (var position = 0; position < WINDOWS.length; position += 1) {
          var type = WINDOWS[position]
          if (byType[type] === undefined) continue
          var row = normalizeLimit(byType[type])
          if (row !== null) limits.push({ type: type, row: row })
        }
        var updated = body !== null && typeof body.fetchedAt === 'string' ? new Date(body.fetchedAt) : null
        var localeId = zh ? 'zh-CN' : 'en'

        return React.createElement(
          'div',
          {
            style: {
              marginTop: 10,
              paddingTop: 8,
              borderTop: '1px solid ' + BORDER,
              fontSize: 12,
              lineHeight: 1.5,
              color: LABEL_PRIMARY,
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            React.createElement('span', { style: { fontWeight: 600, color: LABEL_SECONDARY } }, t.title),
            React.createElement('span', { style: { flex: '1 1 auto' } }),
            updated !== null && !Number.isNaN(updated.getTime())
              ? React.createElement('span', { style: { color: LABEL_TERTIARY, fontSize: 11 } }, fill(t.updated, { time: updated.toLocaleTimeString(localeId) }))
              : null,
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  load(true)
                },
                disabled: state.status === 'loading',
                style: {
                  border: 'none',
                  background: 'none',
                  padding: 0,
                  cursor: state.status === 'loading' ? 'default' : 'pointer',
                  color: state.status === 'loading' ? LABEL_TERTIARY : LINK,
                  font: 'inherit',
                  fontSize: 11,
                },
              },
              state.status === 'loading' ? t.loading : t.refresh,
            ),
          ),
          failed
            ? React.createElement(
                'div',
                { style: { marginTop: 6, color: LABEL_SECONDARY } },
                reasonText(body.reason, t),
                body.ok !== true && body.reason !== 'no-key'
                  ? React.createElement(
                      'button',
                      {
                        type: 'button',
                        onClick: function () {
                          load(true)
                        },
                        disabled: state.status === 'loading',
                        style: {
                          border: 'none',
                          background: 'none',
                          padding: '0 0 0 8px',
                          cursor: state.status === 'loading' ? 'default' : 'pointer',
                          color: state.status === 'loading' ? LABEL_TERTIARY : LINK,
                          font: 'inherit',
                        },
                      },
                      t.retry,
                    )
                  : null,
              )
            : null,
          !failed && state.status === 'ready' && limits.length === 0
            ? React.createElement('div', { style: { marginTop: 6, color: LABEL_SECONDARY } }, t.empty)
            : null,
          !failed && limits.length === 0 && state.status === 'loading'
            ? React.createElement('div', { style: { marginTop: 6, color: LABEL_TERTIARY } }, t.loading)
            : null,
          limits.map(function (item) {
            return React.createElement(UsageRow, { key: item.type, type: item.type, row: item.row, now: now, zh: zh, locale: localeId, t: t })
          }),
        )
      }

      // ═══════════════════════════ 插件本体 ═══════════════════════════

      /**
       * 需要注入的客户端服务。
       *
       * **`locale` 必须写在这里**：cordis 的可追踪代理对未声明的服务属性是**抛错**
       * （`cannot get property "locale" without inject`），而不是返回 undefined ——
       * 所以「不注入、拿不到就退英文」这条路根本走不通，漏声明只会让整个 slot
       * 静默崩成 `<div data-slot-error>`（这个坑真踩过一次）。dsh 自己的 API 目录
       * 也把两种写法分得很清：硬依赖是 `inject: ["locale"]` + `ctx.locale`，
       * 可选访问是 `ctx.get("locale")`。这里选硬依赖 —— web shell 必然提供 locale，
       * 其它客户端插件也都这么写；`useLanguage` 里的 `usable` 兜底只服务于测试的假 ctx。
       */
      var inject = ['slots', 'locale']

      /**
       * 注册卡片扩展。
       *
       * `slots.inject(name, cb)` 会等到 `settings.models.provider-card` 这个
       * slot 的声明进了账本再注册，所以本插件与 Models 设置页的加载顺序无关。
       * key 用 settings 命名空间（`llm-pi-ai`），派发时的 entryKey 也是它。
       *
       * @param ctx - 客户端根上下文。
       */
      function apply(ctx) {
        ctx.slots.inject('settings.models.provider-card', function () {
          return ctx.slots.register(
            {
              name: 'settings.models.provider-card',
              key: SETTINGS_NS,
            },
            function Card(props) {
              return React.createElement(UsageCard, Object.assign({ ctx: ctx }, props))
            },
          )
        })
      }

      exports.inject = inject
      exports.apply = apply
      return module.exports
    },
  })
}
