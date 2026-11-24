import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// Files in extension/ that are copied into the build unchanged.
const STATIC_EXTENSION_FILES = ['manifest.json', 'server.html', 'server.css'];

// Builds the Sifty Server extension into extension/dist, ready to load
// unpacked in Chrome. Separate from vite.config.ts, which is the webapp's dev
// server. Run with: npm run extension:build
export default defineConfig({
  build: {
    outDir: 'extension/dist',
    emptyOutDir: true,
    target: 'chrome120',
    // Left readable: this is a personal extension, and a stack trace in
    // chrome://extensions should point at real code.
    minify: false,
    rollupOptions: {
      // Code shared by the service worker and the tab goes in a chunk; like the
      // entries it must end in .js for Chrome to serve it as JavaScript.
      output: { chunkFileNames: '[name]-[hash].js' },
    },
    lib: {
      entry: {
        background: path.resolve(__dirname, 'src/extension/background.ts'),
        server: path.resolve(__dirname, 'src/extension/serverTab/main.ts'),
      },
      formats: ['es'],
      // Chrome loads the service worker by the name in manifest.json.
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
