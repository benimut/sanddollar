/**
 * @file main.ts
 * @description Sanddollar 記帳應用程式主進入點
 * 負責初始化 Vue 應用程式實例、載入全域樣式表 (TailwindCSS) 並掛載根元件至 DOM。
 * 同時作為 PWA (Progressive Web App) 與全域外掛的裝配中心。
 */

import { createApp } from 'vue';
import './style.css';
import App from './App.vue';

// 建立 Vue 應用程式實例並掛載至 HTML 中的 #app 節點
createApp(App).mount('#app');

