import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      'dist/**',
      'dist-portable/**',
      'node_modules/**',
      'coverage/**',
      /* 这两个是「复制一份打包产物出来试跑」的目录，里面是压缩后的成品代码 */
      'tmp/**',
      'test-env/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    rules: {
      /* 类型安全（和 tsc 严格模式配合，双保险） */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      /* React hooks 依赖检查 */
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      /* 常见陷阱 */
      'no-debugger': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    /*
     * 内核 `.cjs`（AG-053 批④ 加）
     *
     * 为什么加：`.cjs` **不参与 tsc**，而 `node --check` 只查语法、**不查未定义的变量** ——
     * 于是「搬走一个表，调用方还引用着旧名字」这种错只能等真跑才现形。
     * 这个月就踩了两次，都是同一个形状：
     *   · `chat.cjs` 的 `pendingConfirms`（每轮结束报一次未处理拒绝）
     *   · `shell.cjs` 的 `inspectCommand`（预览终端里跑命令会抛）
     * 所以这里只开一条最具性价比的规则：**未定义的标识符**。
     *
     * ⚠️ 不加更多规则（unused-vars / eqeqeq 之类）：内核里数量多、
     *   一次全开会淹没真正有用的那几条 —— 先把这一条钉住再说。
     *   跑的方式见 `scripts/lint-kernel.mjs`（它会过滤掉允许清单，并把「清单过期」当失败）。
     */
    files: ['electron/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      /* 宿主与 Node 的全局（手写，不为一条规则引 `globals` 包） */
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        DOMException: 'readonly',
        structuredClone: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        performance: 'readonly',
        navigator: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
]
