import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), ['AMAP_SECURITY_CODE', 'VITE_AMAP_']);
  const useLocalAmap = command === 'serve' && Boolean(env.VITE_AMAP_KEY && env.AMAP_SECURITY_CODE && !env.VITE_AMAP_SERVICE_HOST);
  return {
    plugins: [vue()],
    base: './',
    build: { outDir: 'docs' },
    define: { 'import.meta.env.VITE_AMAP_LOCAL_PROXY': JSON.stringify(useLocalAmap) },
    server: useLocalAmap ? {
      proxy: {
        '^/_AMapService/(v3/assistant/inputtips|v[35]/place/detail)(?:\\?|$)': {
          target: 'https://restapi.amap.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/_AMapService/, ''),
          configure(proxy) {
            proxy.on('proxyReq', request => {
              const url = new URL(request.path, 'https://restapi.amap.com');
              url.searchParams.set('key', env.VITE_AMAP_KEY);
              url.searchParams.set('jscode', env.AMAP_SECURITY_CODE);
              request.path = url.pathname + url.search;
            });
          },
        },
      },
    } : undefined,
  };
});
