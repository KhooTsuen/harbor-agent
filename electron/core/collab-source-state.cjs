/** Execution success and usable information are independent facts. */
function describeRun(run) {
  const output = String(run.output ?? '')
  const kind = run.name === 'search_web' ? 'search'
    : ['browse', 'browse_nav', 'edge_read_page'].includes(run.name) ? 'page'
      : run.name === 'read_file' ? 'file' : run.name === 'run_shell' ? 'command' : 'other'
  const lines = output.replace(/\[退出码 \d+\]/g, '').trim().split(/\r?\n/).filter(line => line.trim())
  const queryEcho = lines.length > 0 && lines.every(line => /^===\s|^-+\s*(?:total:\s*0)?$/.test(line))
  const forbidden = /(?:^|\n)(?:标题[：:]\s*)?(?:403\s+Forbidden|Access Denied|访问被拒绝)\s*(?:$|\n)|<title>\s*403\b/i.test(output)
  const empty = !output.replace(/\[退出码 \d+\]/g, '').trim() ||
    /^(?:没有结果|未找到结果)[。.!\s]*$/.test(output.trim()) || /没有可读的正文/.test(output) ||
    (kind === 'search' && /^搜索「[^\r\n]*」没有结果。/.test(output))
  return { kind, status: run.pending ? 'pending' : run.ok !== true ? 'failed'
    : forbidden ? 'forbidden' : empty ? 'empty' : queryEcho ? 'query_echo' : 'readable',
    truncated: /正文被截断|输出已截断|还有 \d+ 字没有返回/.test(output), outputChars: output.length }
}

module.exports = { describeRun }
