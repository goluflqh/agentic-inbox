import tsconfigPaths from 'vite-tsconfig-paths';
export default { plugins: [tsconfigPaths()], optimizeDeps: { esbuildOptions: { target: 'esnext' } }, server: { host: '127.0.0.1', port: 5193, strictPort: true } };
