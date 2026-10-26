// 讀 data/ 底下的檔案，合成引擎要的一份資料。sim.js 與 build.js 共用。
// 新增劇情檔時，加進 EVENT_FILES 就好。
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const EVENT_FILES = ['events_main.json', 'events_bonds.json', 'events_flavor.json', 'events_ch2.json', 'events_ch3.json', 'events_ch4.json', 'events_ch5.json', 'events_ch6.json', 'events_ch7.json', 'events_ch8.json', 'events_life_child.json', 'events_life_adult.json', 'events_life_old.json', 'events_life_choice.json'];

function readJson(f) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8'));
}

function loadData() {
  const world = readJson('world.json');
  const endings = readJson('endings.json');
  const parts = EVENT_FILES.map(readJson);
  return { world, endings, parts, data: E.mergeData(world, parts, endings) };
}

module.exports = { loadData, EVENT_FILES };
