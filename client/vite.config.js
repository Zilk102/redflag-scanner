import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    ssr: {
        noExternal: ['react-helmet-async'],
    },
    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            '/api': {
                target: 'http://server:5000',
                changeOrigin: true,
            },
        },
    },
});
