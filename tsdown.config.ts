import { defineConfig } from 'tsdown'

/** 浏览器半模块 id：必须是包名，宿主模块表按它注册工厂。 */
const CLIENT_ID = 'dsh-auto-review-systemOne'

/** 浏览器半外置的宿主模块：宿主模块表提供的平台单例，其余一律打进包内。 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
]

export default defineConfig([
  // Node 半：编译产物交给 tsdown 只做打包（tsc 负责内联 FiberState 常量枚举）。
  {
    name: 'node',
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: (specifier: string): boolean => specifier.startsWith('@deepseek-ai/') && specifier !== '@deepseek-ai/schemastery',
    },
  },
  // 浏览器半：web 侧 cordis 插件，格式复刻宿主的 lazy-CJS 工厂产物。
  {
    name: `${CLIENT_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    minify: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    deps: {
      neverBundle: (specifier: string): boolean => CLIENT_EXTERNALS.includes(specifier),
      alwaysBundle: (specifier: string): boolean => !CLIENT_EXTERNALS.includes(specifier),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
