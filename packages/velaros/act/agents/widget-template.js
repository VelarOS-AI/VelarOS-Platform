// 示例函数按需选用；定义函数不会执行。放入对应入口并显式调用，将需要的返回值交给 output。
import { show } from 'velaros:widget'
// 只能在 execute 里调用；显示后立即返回，用户在对话里看到它。颜色用主题变量，暗色主题下也看得清。
async function chart() { return show({title:'本周访问量',height:260,code:'<svg viewBox="0 0 320 160" width="100%"><polyline fill="none" stroke="var(--color-text-info)" stroke-width="3" points="10,140 60,110 110,120 160,70 210,80 260,40 310,30"/></svg>'}) }
// 可交互的小工具：按钮里调 sendPrompt，把用户的选择当作一句话发回来。
async function picker() { return show({title:'选一个方案',code:'<style>button{margin:4px;padding:6px 12px;border-radius:var(--border-radius-md)}</style><button onclick="sendPrompt(\'用方案 A\')">方案 A</button><button onclick="sendPrompt(\'用方案 B\')">方案 B</button>'}) }
