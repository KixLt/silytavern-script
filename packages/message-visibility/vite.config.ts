import { defineConfig, type UserConfig } from 'vite';

const config: UserConfig = {
  esbuild: { drop: ['debugger'] },
  build: {
    // 产物与其它脚本并列放在仓库根 dist/ 下, jsDelivr 直接读取该路径.
    outDir: '../../dist/message-visibility',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    lib: {
      entry: 'src/index.ts',
      name: 'MessageVisibility',
      formats: ['iife'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true, extend: true },
    },
  },
};

export default defineConfig(config);
