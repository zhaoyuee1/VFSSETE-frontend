import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          echarts: ['echarts', 'echarts-for-react']
        }
      }
    }
  },
  define: {
    // 确保环境变量在构建时可用
    'process.env': {}
  }
})
