/**
 * End-to-end check of the streamed pin gate against the REAL reader.
 *
 * The plugin's own tests read the response body by hand. The part that can
 * silently break is the interaction with the OpenAI SDK (which is what
 * `@earendil-works/pi-ai` uses): if withholding `data: [DONE]` until the verdict
 * confuses the SDK, messages would stop assembling. So drive the real SDK
 * through the installed hook, on a mock gateway that streams like the real one.
 */
import OpenAI from '/Users/breakfree/.dsh/profiles/web/node_modules/openai/index.mjs'
// 装在 node_modules 里的安装包（自 2026-09-27 起；此前是 profile 的 plugins/dsh-clinepass，
// 那条路径已经不存在了 —— 别把这里改回去）。手动安装路线才会落在 plugins/ 下。
import { createFetchPin } from '/Users/breakfree/.dsh/profiles/web/node_modules/dsh-clinepass/index.js'

const GATEWAY = 'https://api.cline.bot'
const CHAT = `${GATEWAY}/api/v1/chat/completions`
const enc = (text) => new TextEncoder().encode(text)
const quiet = { info() {}, warn() {}, error() {} }

const delta = (index) => `data: ${JSON.stringify({
  id: 'gen_test', object: 'chat.completion.chunk', created: 1, model: 'deepseek/deepseek-v4.1-flash',
  choices: [{ index: 0, delta: { content: `tok${index}` }, finish_reason: null }],
})}\n\n`

const flushFrame = `data: ${JSON.stringify({
  id: 'gen_test', object: 'chat.completion.chunk', created: 1, model: 'deepseek/deepseek-v4.1-flash',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
})}\n\n`

const routingFrame = (provider) => `data: ${JSON.stringify({
  id: 'gen_test', object: 'chat.completion.chunk', created: 1, model: 'deepseek/deepseek-v4.1-flash',
  choices: [{
    index: 0, delta: {
      provider_metadata: {
        gateway: {
          routing: {
            finalProvider: provider,
            resolvedProvider: provider,
            fallbacksAvailable: [],
            modelAttempts: [{ providerAttempts: [{ provider, success: true }] }],
          },
        },
      },
    }, finish_reason: null,
  }],
})}\n\n`

/** A mock gateway that streams like the real one: deltas, a flush frame, routing, then [DONE]. */
function mockGateway(provider, { gapMs = 10, deltas = 6, holdMs = 150 } = {}) {
  return async () => {
    const stream = new ReadableStream({
      async start(controller) {
        for (let index = 0; index < deltas; index += 1) {
          controller.enqueue(enc(delta(index)))
          await new Promise((r) => setTimeout(r, gapMs))
        }
        controller.enqueue(enc(flushFrame))
        await new Promise((r) => setTimeout(r, holdMs))
        controller.enqueue(enc(routingFrame(provider)))
        controller.enqueue(enc('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}

async function run(label, provider, enforcement) {
  const realFetch = globalThis.fetch
  globalThis.fetch = mockGateway(provider)
  const hook = createFetchPin({ upstream: GATEWAY, enforcement }, quiet)
  hook.install()
  const client = new OpenAI({ apiKey: 'sk_test', baseURL: `${GATEWAY}/api/v1` })
  const arrivals = []
  let assembled = ''
  let failure = null
  let completed = false
  try {
    const stream = await client.chat.completions.create(
      { model: 'cline-pass/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { signal: undefined },
    )
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? ''
      if (text !== '') { assembled += text; arrivals.push({ text, at: Date.now() }) }
    }
    completed = true
  } catch (error) {
    failure = error
  }
  hook.uninstall()
  globalThis.fetch = realFetch
  const spread = arrivals.length > 1 ? arrivals.at(-1).at - arrivals[0].at : 0
  console.log(
    `${label.padEnd(26)} assembled=${JSON.stringify(assembled)}  chunks=${arrivals.length}` +
      `  spread=${String(spread).padStart(4)}ms  error=${failure === null ? 'none' : JSON.stringify(failure.message.slice(0, 60))}` +
      `  blocked=${hook.counters.blocked}`,
  )
  return { assembled, failure, completed }
}

const ok = await run('strict + deepseek', 'deepseek', 'strict')
const foreign = await run('strict + alibaba', 'alibaba', 'strict')
const warned = await run('warn + alibaba', 'alibaba', 'warn')

const spread = (r) => (r.arrivals ?? []).length
const checks = [
  ['a verified stream completes through the SDK', ok.completed && ok.assembled === 'tok0tok1tok2tok3tok4tok5'],
  ['…with no SDK error', ok.failure === null],
  ['a foreign stream makes the SDK throw instead of completing', !foreign.completed && foreign.failure !== null],
  ['…so no completed assistant message reaches the caller', !foreign.completed],
  ['…while its deltas were already delivered (the documented tradeoff)', foreign.assembled.length > 0],
  ['warn streams to completion regardless', warned.completed && warned.assembled === 'tok0tok1tok2tok3tok4tok5' && warned.failure === null],
]
let failed = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}`)
  if (!pass) failed += 1
}
console.log(failed === 0 ? '\nE2E OK' : `\nE2E FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
