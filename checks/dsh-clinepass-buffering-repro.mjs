/**
 * Stream pacing check for the dsh-clinepass pin gate.
 *
 * `enforcement: off` and `strict` must pace the body the same way: the gate
 * forwards every frame as it arrives and holds back only the SSE terminator
 * until `gateway.routing` has been judged. If `strict` ever collapses to a
 * single late chunk again, someone has reintroduced "read the whole response,
 * then release it" — which restores the pin but destroys the chunk arrival
 * times dsh measures output speed (TPS) from.
 *
 * A mock upstream streams 40 SSE frames, 25 ms apart (~1 s total).
 */

// 同 dsh-clinepass/checks/dsh-clinepass-streaming-gate-check.mjs：路径是安装包（2026-09-27 起），不是
// profile 的 plugins/dsh-clinepass。
import { createFetchPin } from '/Users/breakfree/.dsh/profiles/web/node_modules/dsh-clinepass/index.js'

const GATEWAY = 'https://api.cline.bot'
const CHAT = `${GATEWAY}/api/v1/chat/completions`
const FRAMES = 40
const GAP_MS = 25

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quiet = { info() {}, warn() {}, error() {} }

const routingFrame = `data: ${JSON.stringify({
  choices: [{
    delta: {},
    provider_metadata: {
      gateway: {
        routing: {
          finalProvider: 'deepseek',
          resolvedProvider: 'deepseek',
          fallbacksAvailable: [],
          modelAttempts: [{ providerAttempts: [{ provider: 'deepseek', success: true }] }],
        },
      },
    },
  }],
})}\n\n`

function mockUpstream() {
  let sent = 0
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (sent < FRAMES) {
          const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`
          controller.enqueue(new TextEncoder().encode(frame))
          sent += 1
          await sleep(GAP_MS)
          return
        }
        controller.enqueue(new TextEncoder().encode(routingFrame))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

const init = {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk_test' },
  body: JSON.stringify({
    model: 'cline-pass/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    max_tokens: 512,
    providerOptions: { gateway: { only: ['deepseek'] } },
  }),
}

async function run(enforcement) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => mockUpstream()
  const hook = createFetchPin({ upstream: GATEWAY, enforcement }, quiet)
  hook.install()
  const t0 = Date.now()
  const response = await globalThis.fetch(CHAT, init)
  const reader = response.body.getReader()
  const arrivals = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    arrivals.push({ at: Date.now() - t0, bytes: value.byteLength })
  }
  hook.uninstall()
  globalThis.fetch = realFetch
  const span = arrivals.at(-1) ? arrivals.at(-1).at - arrivals[0].at : 0
  console.log(
    `enforcement=${enforcement.padEnd(7)} status=${response.status}  chunks=${String(arrivals.length).padStart(3)}` +
      `  first=${String(arrivals[0]?.at ?? -1).padStart(5)}ms  last=${String(arrivals.at(-1)?.at ?? -1).padStart(5)}ms` +
      `  spread=${String(span).padStart(5)}ms  upstream spread=${FRAMES * GAP_MS}ms`,
  )
  console.log('   first 5 arrivals (ms since request):', arrivals.slice(0, 5).map((a) => a.at).join(', '))
}

await run('off')
await run('strict')
