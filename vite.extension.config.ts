import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const STATIC_EXTENSION_FILES = ['manifest.json', 'server.html', 'server.css'];

export default defineConfig({
  build: {
    outDir: 'extension/dist',
    emptyOutDir: true,
    target: 'chrome120',
    minify: false,
    rollupOptions: {
      output: { chunkFileNames: '[name]-[hash].js' },
    },
    lib: {
      entry: {
        background: path.resolve(__dirname, 'src/extension/background.ts'),
        server: path.resolve(__dirname, 'src/extension/serverTab/main.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
  },
  plugins: [
    {
      name: 'copy-extension-static-files',
      generateBundle() {
        for (const fileName of STATIC_EXTENSION_FILES) {
          this.emitFile({
            type: 'asset',
            fileName,
            source: fs.readFileSync(path.resolve(__dirname, 'extension', fileName), 'utf8'),
          });
        }
      },
    },
  ],
});
