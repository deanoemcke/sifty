import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

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
    lib: {
      entry: { background: path.resolve(__dirname, 'src/extension/background.ts') },
      formats: ['es'],
      // Chrome loads the service worker by the name in manifest.json.
      fileName: (_format, entryName) => `${entryName}.js`,
    },
  },
  plugins: [
    {
      name: 'copy-extension-manifest',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'manifest.json',
          source: fs.readFileSync(path.resolve(__dirname, 'extension/manifest.json'), 'utf8'),
        });
      },
    },
  ],
});
