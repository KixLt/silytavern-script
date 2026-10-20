import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/剧情进度状态栏',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
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
});
