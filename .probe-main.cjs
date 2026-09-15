/* 临时探针（Electron 里跑，为了能解 safeStorage）：实测 DeepSeek strict 真实行为 */
const { app } = require('electron')
const paths = require('./electron/core/paths.cjs')
paths.markPackaged('<repo>/dist-portable/PersonalAgent')

const TOOL_STRICT = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查某个城市的天气',
    strict: true,
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
}
const TOOL_LOOSE = JSON.parse(JSON.stringify(TOOL_STRICT))
delete TOOL_LOOSE.function.strict

async function attempt(label, base, tool, model, key) {
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '北京今天天气怎么样？' }],
        tools: [tool],
        tool_choice: 'auto',
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    })
    const text = await r.text()
    if (!r.ok) {
      console.log(`\n【${label}】HTTP ${r.status} ❌ ${text.slice(0, 300).replace(/\n/g, ' ')}`)
      return
    }
    const j = JSON.parse(text)
    const tc = j?.choices?.[0]?.message?.tool_calls?.[0]
    console.log(`\n【${label}】HTTP ${r.status} ✅  model=${j.model} usage=${JSON.stringify(j.usage)}`)
    console.log('   工具调用:', tc ? `${tc.function?.name}(${tc.function?.arguments})` : '（无）')
  } catch (e) {
    console.log(`\n【${label}】异常：${e.message}`)
  }
}

app.whenReady().then(async () => {
  const creds = require('./electron/core/credentials.cjs')
  console.log('凭据状态:', JSON.stringify(creds.status()))
  let key = null
  try { key = creds.get('provider:deepseek') } catch (e) { console.log('get 抛错:', e.message, '|', e.stack.split('
')[1] || '') }
  if (!key) { console.log('还是没 key'); app.quit(); return }
  console.log('拿到 key（前 6 位）:', String(key).slice(0, 6) + '…')
  const raw = JSON.parse(require('fs').readFileSync(paths.DIRS.data + '/credentials.json','utf8'))
  const ent = raw.entries?.['provider:deepseek'] ?? raw['provider:deepseek']
  console.log('条目形状:', JSON.stringify(ent).slice(0, 160))

  await attempt('v1 + strict', 'https://api.deepseek.com/v1', TOOL_STRICT, 'deepseek-chat', key)
  await attempt('beta + strict', 'https://api.deepseek.com/beta', TOOL_STRICT, 'deepseek-chat', key)
  await attempt('v1 不标 strict（对照）', 'https://api.deepseek.com/v1', TOOL_LOOSE, 'deepseek-chat', key)
  app.quit()
})
