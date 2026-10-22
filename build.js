// 打包：node build.js → dist/index.html（引擎與資料內嵌成單一頁面）
// 打包前先跑一次靜態檢查；資料有錯就不產出。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

try {
  execFileSync(process.execPath, [path.join(__dirname, 'sim.js'), '2000'], { stdio: 'inherit' });
} catch (e) {
  console.error('稽核沒過，停止打包。');
  process.exit(1);
}

const { data } = require('./load.js').loadData();
const engine = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');

const json = JSON.stringify(data).replace(/</g, '\\u003c');
const html = ui
  .replace('/*__ENGINE__*/', () => engine.replace(/<\/script/gi, '<\\/script'))
  .replace('/*__DATA__*/', () => json)
  .replace('約八十張事件卡', () => `${data.events.length} 張事件卡`)
  .replace('{ENDINGS}', () => `${data.endings.length} `);

// 頁面裡的每一段腳本先編譯一次：有語法錯誤就不產生檔案，免得發佈出一個打不開的頁面
const vm = require('vm');
for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
  try { new vm.Script(m[1]); } catch (err) {
    console.error(`頁面腳本有語法錯誤：${err.message}`);
    process.exit(1);
  }
}

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
// 開頭宣告 UTF-8：直接用本機伺服器打開 index.html 時，瀏覽器才不會用錯編碼變成亂碼
fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), '<meta charset="utf-8">\n' + html, 'utf8');
// 本機預覽用：補上發佈平台會自動加的外殼（doctype、charset、viewport）
// 這也是 GitHub Pages 的首頁：分享連結時，聊天軟體會讀 <head> 裡的標題、簡介和封面圖
const SITE = 'https://9pongo.github.io/sanguo-life/';
const desc = `投胎到東漢末年，從黃巾起事活到八王之亂（184–306），一代一代傳下去。${data.events.length} 張事件卡、${data.endings.filter((e) => !e.fallback).length} 種結局。`;
const icon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="6" fill="#9a2f22"/><text x="32" y="47" font-size="44" text-anchor="middle" fill="#f0eee2" font-family="serif" font-weight="900">黃</text></svg>');
const head = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<title>黃天之下</title>',
  `<meta name="description" content="${desc}">`,
  '<meta property="og:type" content="website">',
  '<meta property="og:title" content="黃天之下：東漢末年人生模擬">',
  `<meta property="og:description" content="${desc}">`,
  `<meta property="og:url" content="${SITE}">`,
  `<meta property="og:image" content="${SITE}cover.png">`,
  '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">',
  '<meta name="twitter:card" content="summary_large_image">',
  `<link rel="icon" href="${icon}">`,
].join('');
fs.writeFileSync(path.join(__dirname, 'dist', 'dev.html'),
  '<!doctype html><html lang="zh-Hant"><head>' + head + '</head><body>' + html + '</body></html>', 'utf8');
console.log(`dist/index.html：${data.events.length} 張事件卡、${data.endings.length} 種結局、${(html.length / 1024).toFixed(0)} KB`);
