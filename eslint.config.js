// ESLint 9 扁平配置（ESM）
// 目标：抓真实问题（未使用变量、隐式全局、可疑写法），不做风格检查（风格交给 Prettier）。
import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {
    // 第三方 / 生成物 / 前端单页（内联脚本，单独处理）不参与 lint
    ignores: [
      'node_modules/**',
      'napcat/**',
      'xiaona-mod/**',
      'data/**',
      'voice_cache/**',
      'logs/**',
      'web/**',
      'meteor-vulkan-compat/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // 允许 `try { ... } catch {}`：这里的空 catch 是刻意的「尽力而为，失败无所谓」
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 全角空格（U+3000）是字符串里的排版分隔符，不是代码里的空白
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipRegExps: true }],
    },
  },
  // 关闭所有与 Prettier 冲突的格式规则（必须放最后）
  prettier,
];