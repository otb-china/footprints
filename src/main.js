import { initializeStorage } from "./utils/toolStorage"
import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

void initializeStorage().then(() => {
  createApp(App).mount('#app');
}).catch((error) => {
  console.error("Failed to initialize tool storage", error)
  const root = document.querySelector("#app")
  if (root) root.textContent = "无法打开本地数据，请关闭其他同工具页面后刷新重试。"
})
