/**
 * 哪些扩展名当文本处理
 *
 * 从 handlers/fs.cjs 拆出来的（那边过 300 行了）。
 *
 * 判断方式看**扩展名**，不去读内容猜 —— 猜的办法要么慢（要读前几 KB），
 * 要么不可靠（二进制里恰好有一段可打印字符）。
 */

const path = require('node:path')

/** 判断是不是文本文件（看扩展名，读内容猜太慢） */
const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonc',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.log',
  '.csv',
  '.tsv',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.py',
  '.rb',
  '.php',
  '.java',
  '.kt',
  '.go',
  '.rs',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.swift',
  '.lua',
  '.pl',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.bat',
  '.cmd',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.vue',
  '.svelte',
  '.astro',
  '.xml',
  '.svg',
  '.sql',
  '.graphql',
  '.proto',
  '.dockerfile',
  '.gitignore',
  '.editorconfig',
])

function isTextFile(name) {
  const ext = path.extname(name).toLowerCase()
  if (TEXT_EXT.has(ext)) return true
  /* 没有扩展名的（Makefile、LICENSE、.gitignore）当成文本试试 */
  return ext === ''
}

module.exports = { TEXT_EXT, isTextFile }
