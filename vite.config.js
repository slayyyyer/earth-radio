import { defineConfig } from 'vite';

// Relative base keeps the built site portable: it works at
// https://<user>.github.io/<repo>/ as well as at a custom domain.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
  },
});
