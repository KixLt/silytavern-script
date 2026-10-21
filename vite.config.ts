import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  build: {
    // 联调产物与发布产物分开, 避免 pnpm dev 覆盖掉要发布/提交的构建
    outDir: mode === 'development' ? 'dist/dev' : 'dist/build',
    emptyOutDir: true,
    target: 'es2022',
    // 联调产物保留原样方便断点, 发布产物用 Vite 内建的 esbuild 压缩
    minify: mode === 'development' ? false : 'esbuild',
    esbuild: { drop: ['debugger'] },
    // 联调 (mode=development) 时输出 sourcemap, 方便在浏览器里直接看 TS 源码、打断点
    sourcemap: mode === 'development',
    lib: {
      entry: 'src/index.ts',
      name: 'PlotProgressBar',
      formats: ['iife'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true, extend: true },
      // zod 的 JSDoc 正文里提到了 `@__PURE__` 字样, Rollup 会当成注解解析失败并刷屏告警;
      // 只影响注释, 产物无变化, 因此只对 node_modules 里的这类告警静默.
      onwarn(warning, warn) {
        if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules')) {
          return;
        }
        warn(warning);
      },
    },
  },
}));
