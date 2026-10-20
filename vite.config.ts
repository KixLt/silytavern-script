import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  build: {
    outDir: 'dist/',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
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
    },
  },
}));
