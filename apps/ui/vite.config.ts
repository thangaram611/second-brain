import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:7430',
      '/ws': {
        target: 'ws://localhost:7430',
        ws: true,
      },
    },
  },
});
