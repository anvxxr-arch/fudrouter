import { mount } from 'svelte';
import App from './App.js';
const app = mount(App, { target: document.getElementById('app') });
export default app;
