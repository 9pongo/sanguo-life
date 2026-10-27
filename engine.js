// 黃天之下 — 人生模擬引擎
// 瀏覽器與 Node 共用：瀏覽器掛在 window.SanguoEngine，Node 用 require。
// 引擎本身不含任何劇情；所有內容都在 data/*.json。
(function (root) {
  'use strict';

  const STATS = ['武', '文', '德', '名', '財'];
  const STEMS = '甲乙丙丁戊己庚辛壬癸';
  const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
  const CN = '〇一二三四五六七八九十';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function ganzhi(y) {
    const i = (((y - 4) % 60) + 60) % 60;
    return STEMS[i % 10] + BRANCHES[i % 12];
  }

  function cnNum(n) {
    if (n <= 10) return CN[n];
    if (n < 20) return '十' + (n % 10 ? CN[n % 10] : '');
    return CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : '');
  }

  function eraLabel(y, eras) {
    const e = eras.find((x) => y >= x.from && y <= x.to);
    if (!e) return ganzhi(y) + '年';
    const n = y - e.from + 1;
    return e.name + (n === 1 ? '元' : cnNum(n)) + '年';
  }

  function pickWeighted(R, items, w) {
    const total = items.reduce((s, it) => s + w(it), 0);
    if (total <= 0) return null;
    let r = R() * total;
    for (const it of items) { r -= w(it); if (r < 0) return it; }
    return items[items.length - 1];
  }

  // ---------------------------------------------------------------- game

  function createGame(data, seed, opts = {}) {
    if (seed == null) seed = Math.floor(Math.random() * 2 ** 31);
    const R = mulberry32(seed);
    const byId = {};
    for (const ev of data.events) byId[ev.id] = ev;
    // 沒有年份也沒有年齡的事件，只能由 later 排程叫出來（因果事件），不進每年的候選
    const scheduledPool = data.events.filter((e) => (e.kind === 'anchor' || e.kind === 'bond' || e.kind === 'stage') && (e.year || e.age));
    const flavorPool = data.events.filter((e) => e.kind === 'flavor');

    const g = { data, seed, R, byId, st: null, queue: [], pending: null, out: [], ended: null, interlude: null, succession: null };
    // 蜀、吳的人用自己的年號；其他人用漢、魏、晉的年號
    function erasFor(y) {
      const fe = data.world.factionEras || {};
      const f = g.st && g.st.faction;
      const list = f && fe[f];
      if (list && list.some((x) => y >= x.from && y <= x.to)) return list;
      return data.world.eras;
    }
    const era = (y) => eraLabel(y, erasFor(y));
    const chapters = data.world.chapters || [{ n: 1, end: data.world.chapterEnd }];
    const chapterOf = (n) => chapters.find((c) => c.n === n);

    // ---------- 狀態存取
    const S = () => g.st;
    function val(k) { return k === '健' ? S().hp : (S().stats[k] ?? 0); }

    function vars() {
      const s = S();
      return {
        name: s.name, friend: s.friend, region: s.regionName, place: s.place,
        age: s.age, year: s.year, era: era(s.year),
        ta: s.gender === 'm' ? '他' : '她', self: s.gender === 'm' ? '男兒' : '女子',
        spouse: s.spouse || '',
        child: (s.children.filter((c) => c.alive).slice(-1)[0] || {}).name || '孩子',
        // 父母：自己的父母；弟妹接班時跟前一位當家的是同一對父母。不知道名字就說「家裡的長輩」
        parent: s.parentName || '家裡的長輩',
        elder: s._elder || '家裡的長輩',
        // 前一位當家的人（可能是父母，也可能是兄姊）
        prev: (s.lineage.slice(-1)[0] || {}).name || '家裡的長輩',
        surname: s.surname, gen: cnNum(s.generation),
        son: s._son || '兒子', kid: s._kid || '孩子',
        // 夭折的是家裡最小、還在身邊的孩子（childDie 沒指定時就是這一個）
        young: (s.children.filter((c) => c.alive && !c.away).sort((x, y) => y.born - x.born)[0] || {}).name || '孩子',
      };
    }
    // 同一段話有好幾種寫法：這一局的種子決定從哪一種開始，同一家族再碰到就換下一種
    // 不動用亂數，所以加寫法不會讓舊存檔重播走樣
    function variant(list, key) {
      if (!Array.isArray(list)) return list;
      if (list.length < 2) return list[0];
      const s = S(), fam = s.familySeen || (s.familySeen = {});
      const k = '~' + key, n = fam[k] || 0;
      fam[k] = n + 1;
      let h = 2166136261 >>> 0;
      for (const ch of seed + ':' + key) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
      return list[(h + n) % list.length];
    }
    const withAlt = (base, alt) => (alt && alt.length ? [base, ...alt] : base);
    // 南方種稻：住在 regionWords 列出的地方，非史實的事件把麥換成稻（有年份的時代大事照史料寫，不換）
    let histText = false;
    function localize(t, region) {
      const words = histText ? null : (data.world.regionWords || {})[region || S().region];
      if (!words) return t;
      for (const [a, b] of words) t = t.split(a).join(b);
      return t;
    }
    function fmt(t, region) {
      if (!t) return t;
      const v = vars();
      return localize(t.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)), region);
    }

    function findKid(gender, range, unwed) {
      const s = S();
      return (s.children || [])
        .filter((c) => c.alive && !c.away && (!gender || c.gender === gender) && !(unwed && c.wed))
        .filter((c) => { const a = s.year - c.born; return a >= range[0] && a <= (range[1] ?? 200); })
        .sort((x, y) => x.born - y.born)[0] || null;
    }

    function meets(req) {
      if (!req) return true;
      const s = S();
      if (req.age && (s.age < req.age[0] || s.age > req.age[1])) return false;
      if (req.year && (s.year < req.year[0] || s.year > req.year[1])) return false;
      if (req.region && !arr(req.region).includes(s.region)) return false;
      if (req.noregion && arr(req.noregion).includes(s.region)) return false;
      if (req.notFired && arr(req.notFired).some((id) => s.fired[id])) return false; // 這輩子碰過內容相近的事
      if (req.cls && !arr(req.cls).includes(s.cls)) return false;
      if (req.gender && s.gender !== req.gender) return false;
      if (req.talent && !arr(req.talent).some((t) => s.talents.includes(t))) return false;
      if (req.flag && !arr(req.flag).every((f) => s.flags[f])) return false;
      if (req.anyFlag && !arr(req.anyFlag).some((f) => s.flags[f])) return false;
      if (req.noflag && arr(req.noflag).some((f) => s.flags[f])) return false;
      if (req.route && !arr(req.route).includes(s.route)) return false;
      // 身在官府管不到的地方（黑山的山寨）：碰不到亭長、縣吏、徭役、戶等這些事
      if (req.nofaction && arr(req.nofaction).includes(s.faction || 'civ')) return false;
      // 身在軍中陣營的女子不上陣，但她也是那片土地上的百姓：平民的劇情同樣算她一份
      if (req.faction && !arr(req.faction).includes(s.faction || 'civ') &&
        !(s.gender === 'f' && arr(req.faction).includes('civ') && s.faction !== 'sun' && s.faction !== 'liu' && s.faction !== 'heishan')) return false;
      // （孫、劉兩家後來各自成了國，那裡的百姓有自己的劇情，不該拿到北方平民的；
      //   黑山的女子住在山寨裡，里中招兵、官渡、屯田這些平民的事也輪不到她）
      if (req.chapter && !arr(req.chapter).includes(s.chapter)) return false;
      if (req.focus && !arr(req.focus).includes(s.focus)) return false;
      if (req.stat) for (const k in req.stat) if (val(k) < req.stat[k]) return false;
      if (req.statMax) for (const k in req.statMax) if (val(k) > req.statMax[k]) return false;
      if (req.bond) for (const k in req.bond) if ((s.bonds[k] || 0) < req.bond[k]) return false;
      if (req.bondMax) for (const k in req.bondMax) if ((s.bonds[k] || 0) > req.bondMax[k]) return false;
      if (req.gen && (s.generation < req.gen[0] || s.generation > (req.gen[1] ?? 99))) return false;
      // 子女：在某個年齡範圍內、還活著、沒有送走的孩子（son 只看兒子）
      // 故事線的後續：認當初用 tagKid 標記的那個孩子，不靠年齡猜（家裡有好幾個同齡上下的孩子時才不會認錯人）
      if (req.kidTag) { const c = (s.children || []).find((x) => x.alive && !x.away && x.tag === req.kidTag); if (!c) return false; s._kid = c.name; if (c.gender === 'm') s._son = c.name; }
      if (req.child) { const c = findKid(null, req.child, req.kidUnwed); if (!c) return false; s._kid = c.name; }
      if (req.son) { const c = findKid('m', req.son); if (!c) return false; s._son = c.name; }
      // 還住在小時候住的地方（沒有搬到別州去）
      if (req.home !== undefined && (s.place === homePlace()) !== req.home) return false;
      if (req.married === true && !spouseHere()) return false;
      if (req.married === false && s.spouse) return false;
      return true;
    }

    function emit(entry) {
      const s = S();
      const e = Object.assign({ age: s.age, year: s.year }, entry);
      if (e.text) e.text = fmt(e.text);
      if (e.tag) e.tag = fmt(e.tag);
      g.out.push(e);
      s.log.push(e);
      return e;
    }

    // ---------- 效果
    function chance(c) {
      if (c == null) return 1;
      if (typeof c === 'number') return c;
      let p = c.base ?? 0.5;
      if (c.stat) p += (c.k ?? 0.01) * val(c.stat);
      if (c.bond) p += (c.bk ?? 0.1) * (S().bonds[c.bond] || 0);
      return clamp(p, c.min ?? 0.03, c.max ?? 0.97);
    }

    function die(cause, entry) {
      const s = S();
      if (!s.alive) return;
      if (s.talents.includes('命硬') && !s.flags._mingying) {
        s.flags._mingying = true;
        s.hp = Math.max(10, s.hp - 25);
        emit({ type: 'event', tag: '命', text: fmt(variant(data.world.mingyingText, 'mingyingText')) });
        return;
      }
      s.alive = false;
      s.cause = cause;
      s.hp = 0; // 人走了，「健」也就沒了（否則會出現「病故、健 96」）
      if (entry) entry.death = true;
    }

    // 小時候（八歲上下）住在哪裡
    function homePlace() {
      const s = S();
      let r = null;
      for (const [y, , pl] of s.regionHist || []) if (r === null || y <= s.birthYear + 8) r = pl;
      return r || s.place;
    }
    function moveTo(id) {
      const s = S();
      const r = data.world.regions.find((x) => x.id === id);
      if (!r || s.region === id) return;
      s.region = r.id; s.regionName = r.name; s.place = r.place;
      (s.regionHist || (s.regionHist = [])).push([s.year, r.id, r.place]);
      // 搬到別國的地盤：原本跟著哪一家，到了這裡都只是新來的百姓
      if (r.faction && s.year <= (r.factionUntil ?? 9999) && s.faction && s.faction !== 'civ' && s.faction !== r.faction) s.faction = 'civ';
      emit({ type: 'note', tag: '遷居', text: `你家從此落腳在${r.name}。` });
    }

    function apply(eff, entry) {
      if (!eff) return;
      const s = S();
      const delta = {};
      for (const k of STATS) {
        if (eff[k]) {
          const before = s.stats[k];
          s.stats[k] = clamp(before + eff[k], 0, 100);
          if (s.stats[k] !== before) delta[k] = s.stats[k] - before;
        }
      }
      if (eff['健']) {
        const before = s.hp;
        s.hp = clamp(before + eff['健'], 0, 100);
        if (s.hp !== before) delta['健'] = s.hp - before;
      }
      for (const f of arr(eff.flag)) {
        if (!s.flags[f]) { (s.flagYear || (s.flagYear = {}))[f] = s.year; (s.flagRegion || (s.flagRegion = {}))[f] = s.region; }
        s.flags[f] = true;
        // 搬家：帶上這些旗標，住處就跟著換（子孫也住在新的地方）
        const to = (data.world.relocate || {})[f];
        if (to) moveTo(to);
        // 同一個州裡換了地方（例如南陽、潁川的人逃到襄陽）：地名跟著換
        const pl = (data.world.relocatePlace || {})[f];
        if (pl) { s.place = pl.place; s.regionName = pl.name; (s.regionHist || (s.regionHist = [])).push([s.year, s.region, s.place]); }
      }
      if (eff.region) moveTo(eff.region);
      for (const f of arr(eff.unflag)) delete s.flags[f];
      if (eff.route) s.route = eff.route;
      if (eff.faction) s.faction = eff.faction;
      // 屯田是曹家的制度：跟了劉、孫兩家，或搬到蜀、吳、江陵，就不再是屯田戶（子孫也不是）
      {
        const NT = data.world.noTuntian || {};
        if (arr(NT.factions).includes(s.faction) || arr(NT.regions).includes(s.region)) for (const f of arr(NT.flags)) delete s.flags[f];
      }
      if (eff.focus) s.focus = eff.focus;
      if (eff.spouse) s.spouse = eff.spouse === '@random' ? spouseName(s.gender === 'm' ? 'f' : 'm') : eff.spouse;
      if (eff.injure) {
        s.injuries.push(fmt(eff.injure));
        emit({ type: 'note', text: '你受了傷：' + fmt(eff.injure) });
      }
      if (eff.bond) {
        for (const id in eff.bond) {
          const def = data.bonds[id];
          const before = s.bonds[id] || 0;
          const after = clamp(before + eff.bond[id], 0, def.tiers.length - 1);
          s.bonds[id] = after;
          if (after > before) {
            emit({ type: 'bond', bond: id, tier: after, text: `你與${def.name}的交情到了「${def.tiers[after]}」。` });
          }
        }
      }
      if (eff.later) for (const l of arr(eff.later)) s.scheduled.push({ year: s.year + l.in, id: l.id });
      if (eff.child) {
        // 孩子跟父姓：自己是男的跟自己姓，自己是女的跟配偶姓
        const sur = s.gender === 'm' ? s.surname : (s.spouse ? s.spouse[0] : s.surname);
        const cg = R() < 0.5 ? 'm' : 'f';
        const nm = kidName(sur, cg);
        s.children.push({ name: nm, gender: cg, born: s.year, alive: true });
        s.flags.has_child = true;
      }
      // 標記剛剛條件挑中的那個兒子（或孩子），之後的消息要落在同一個人身上
      if (eff.tagKid) {
        const nm = s._son || s._kid;
        const c = s.children.find((x) => x.name === nm && x.alive);
        if (c) c.tag = eff.tagKid;
      }
      // 孩子成親：記下來，這個孩子日後接家時就是已經成了家的人
      if (eff.kidWed) {
        const c = s.children.find((x) => x.name === s._kid && x.alive);
        if (c) c.wed = true;
      }
      if (eff.childDie) {
        // 沒指定是哪一個，就是家裡年紀最小、還在身邊的那個
        const youngest = () => s.children.filter((x) => x.alive && !x.away).sort((x, y) => y.born - x.born)[0] || s.children.filter((x) => x.alive).pop();
        const c = typeof eff.childDie === 'string'
          ? (s.children.find((x) => x.alive && x.tag === eff.childDie) || youngest())
          : youngest();
        if (c) c.alive = false;
        if (!s.children.some((x) => x.alive)) delete s.flags.has_child;
      }
      if (eff.childAway) {
        const c = s.children.filter((x) => x.alive && !x.away).pop();
        if (c) c.away = true;
      }
      if (entry && Object.keys(delta).length) entry.delta = Object.assign(entry.delta || {}, delta);
      if (eff.die) die(eff.die, entry);
      if (eff.risk && s.alive) {
        const p = chance(eff.risk);
        if (R() < p) die(eff.risk.cause, entry);
      }
      if (s.hp <= 0 && s.alive) die(eff.hpCause || '傷病交加', entry);
    }

    // ---------- 事件
    function fire(ev) {
      const s = S();
      histText = !!ev.year;
      s.fired[ev.id] = (s.fired[ev.id] || 0) + 1;
      if (ev.kind !== 'flavor' && isCampaign(ev)) {
        s.campaignYear = s.year;
        if (!s.flags.served) { s.flags.served = true; (s.flagYear || (s.flagYear = {})).served = s.year; } // 這輩子上過戰場
      }
      // 祖上傳說：{elder} 指的是真正做過那件事的人
      const pf = typeof ev.req?.flag === 'string' && ev.req.flag.startsWith('p_') ? ev.req.flag.slice(2) : null;
      s._elder = pf ? (s.elders || {})[pf] || null : null;
      // 同一件小事在家族裡第二次發生時，換一種寫法
      // 同一件人生大事（接家、四十、六十）每一代都會碰到：依時代與家境換一段開場
      const tvi = (ev.textIf || []).findIndex((v) => meets(v.req));
      const text = tvi >= 0 ? variant(ev.textIf[tvi].text, ev.id + '@' + tvi) : variant(withAlt(ev.text, ev.alt), ev.id);
      // 家族記得每件事發生過幾次、最近一次是哪一年：後代少碰重複的事
      {
        const fam = s.familySeen || (s.familySeen = {});
        fam[ev.id] = (fam[ev.id] || 0) + 1;
        fam['@' + ev.id] = s.year;
      }
      const entry = emit({
        type: ev.choices ? 'decision' : 'event', id: ev.id, kind: ev.kind,
        tag: ev.tag, title: ev.title ? fmt(ev.title) : null, text, note: ev.note || null,
        who: ev.who || null,
      });
      apply(ev.eff, entry);
      if (!s.alive) return;
      if (ev.choices) {
        const opts = ev.choices
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => meets(c.show))
          .map(({ c, i }) => ({
            i, t: fmt(tOf(c, ev.id + '#' + i)), sub: fmt(subOf(c, ev.id + '#' + i)) || null,
            ok: meets(c.req), lock: c.lock ? fmt(c.lock) : null,
          }));
        if (!opts.some((o) => o.ok)) opts[opts.length - 1].ok = true; // 保底：至少一條路
        g.pending = { ev, entry, opts };
      }
    }

    // 選項本身的字：同樣可以依條件換寫法（例如本來就住在荊州的人，不說「去荊州」）
    function tOf(c, key) {
      const ti = (c.tIf || []).findIndex((v) => meets(v.req));
      return ti >= 0 ? variant(c.tIf[ti].t, key + 't' + ti) : variant(withAlt(c.t, c.tAlt), key);
    }
    // 選項底下的小字：先看有沒有依條件（例如性別）換的寫法，再從幾種寫法裡輪一種
    function subOf(c, key) {
      const si = (c.subIf || []).findIndex((v) => meets(v.req));
      return si >= 0 ? variant(c.subIf[si].sub, key + 's' + si) : variant(withAlt(c.sub, c.subAlt), key + 's');
    }
    function resolve(c, ev, label) {
      const s = S();
      const head = emit({ type: 'choice', id: ev.id, text: label || c.t, title: ev.title ? fmt(ev.title) : null });
      apply(c.eff, head);
      // 這一下沒活過去：不能再接「你第三天夜裡才爬出來」那種寫活下來的結果
      const ov = (c.outIf || []).find((v) => meets(v.req));
      const out = !s.alive && c.deathOut ? c.deathOut : ov ? variant(ov.out, ev.id + '#' + c.t + '@') : variant(withAlt(c.out, c.outAlt), ev.id + '#' + c.t);
      if (out) emit({ type: 'event', text: out });
      let branch = null;
      if (s.alive && c.chk) {
        branch = R() < chance(c.chk) ? c.ok : c.fail;
      }
      if (branch && s.alive) {
        const e = branch.out ? emit({ type: 'event', text: variant(withAlt(branch.out, branch.outAlt), ev.id + '#' + c.t + (branch === c.ok ? '+' : '-')) }) : head;
        apply(branch.eff, e);
      }
      const next = (branch && branch.next) || c.next;
      if (next && s.alive) g.queue.unshift(...arr(next).map((id) => ({ id, force: true })));
      // 「這一生的抉擇」給玩家看：沒有標題就用分類名，不要露出英文代號
      s.choices.push({ age: s.age, year: s.year, title: ev.title ? fmt(ev.title) : (ev.tag || '抉擇'), pick: label || fmt(c.t), id: ev.id });
    }

    // ---------- 出生
    function randomSurname() {
      const N = data.world.names;
      return N.surnames[Math.floor(R() * N.surnames.length)];
    }
    function randomGiven(gender) {
      const N = data.world.names;
      const pool = gender === 'm' ? N.male : N.female;
      return pool[Math.floor(R() * pool.length)];
    }
    function randomName(gender) { return randomSurname() + randomGiven(gender); }
    // 玩伴不跟自己、父母、兄弟姊妹同名（白承祖的玩伴叫徐承祖，讀起來像同一個人）。
    // 撞名時順著名冊往下挑，不動用亂數，舊存檔重播不走樣
    function unclashFriend(s) {
      const pool = data.world.names.male;
      const used = [s.name, s.parentName, ...s.siblings.map((x) => x.name)].filter(Boolean).map((n) => n.slice(1));
      let i = pool.indexOf(s.friend.slice(1));
      if (i < 0) return;
      for (let k = 0; k < pool.length && used.includes(pool[i]); k++) i = (i + 1) % pool.length;
      s.friend = s.friend[0] + pool[i];
    }
    // 弟妹也不跟自己、父母或其他兄弟姊妹同名（史禮的弟弟又叫史禮，接班時就分不清誰是誰的爹）。同樣順著名冊往下挑，不動用亂數
    function unclashSiblings(s, from, extra) {
      const N = data.world.names;
      for (let j = from; j < s.siblings.length; j++) {
        const c = s.siblings[j], pool = c.gender === 'm' ? N.male : N.female;
        const used = [s.name, s.parentName, ...(extra || []), ...s.siblings.filter((x, k) => k !== j).map((x) => x.name)].filter(Boolean).map((n) => n.slice(1));
        let i = pool.indexOf(c.name.slice(1));
        if (i < 0 || !used.includes(pool[i])) continue;
        for (let k = 0; k < pool.length && used.includes(pool[i]); k++) i = (i + 1) % pool.length;
        c.name = c.name[0] + pool[i];
      }
    }
    // 配偶（含續弦、再嫁）的名，不跟自己或家裡孩子的名重複
    function spouseName(gender) {
      const s = S();
      const used = [s.name, ...s.children.map((c) => c.name)].map((n) => n.slice(1));
      let nm = randomName(gender);
      for (let k = 0; k < 12 && used.includes(nm.slice(1)); k++) nm = randomName(gender);
      return nm;
    }
    // 孩子取名：不跟兄姊同名，也不用父母、祖上的名（古人避諱），更不能跟配偶同名同姓
    function kidName(sur, cg) {
      const s = S();
      const avoid = [s.name, s.spouse, ...(s.forbid || [])].filter(Boolean);
      const bad = (nm) => s.children.some((c) => c.name === nm) || avoid.some((n) => n === nm || n.slice(1) === nm.slice(1));
      let nm = sur + randomGiven(cg);
      for (let k = 0; k < 12 && bad(nm); k++) nm = sur + randomGiven(cg);
      return nm;
    }

    function born() {
      const W = data.world;
      const region = pickWeighted(R, W.regions, (r) => r.w);
      const cls = pickWeighted(R, W.classes, (c) => c.w);
      const gender = R() < 0.5 ? 'm' : 'f';
      const birthYear = pickWeighted(R, W.birthYears, (b) => b.w).y;
      const talents = [];
      while (talents.length < 2) {
        const t = pickWeighted(R, W.talents.filter((x) => !talents.includes(x.id)), (x) => x.w);
        talents.push(t.id);
      }
      const surname = randomSurname();
      g.st = {
        name: surname + randomGiven(gender), surname, gender, birthYear, year: birthYear, age: 0,
        children: [], siblings: [], generation: 1, lineage: [],
        region: region.id, regionName: region.name, place: region.place, regionHist: [[birthYear, region.id, region.place]],
        cls: cls.id, clsName: cls.name, talents,
        stats: Object.assign({ 武: 0, 文: 0, 德: 0, 名: 0, 財: 0 }, cls.stats),
        hp: 70, flags: {}, bonds: {}, focus: null, route: null, faction: null, chapter: 1, spouse: null,
        friend: randomName('m'), injuries: [], fired: {}, scheduled: [], choices: [], log: [],
        alive: true, cause: null, firstLife: true,
      };
      const s = g.st;
      const nSib = 1 + Math.floor(R() * 3);
      for (let i = 0; i < nSib; i++) {
        const sg = R() < 0.5 ? 'm' : 'f';
        s.siblings.push({ name: surname + randomGiven(sg), gender: sg, born: birthYear + 1 + Math.floor(R() * 8), alive: true });
      }
      unclashSiblings(s, 0);
      unclashFriend(s);
      for (const t of talents) {
        const def = W.talents.find((x) => x.id === t);
        if (def.eff) apply(def.eff, null);
      }
      s.birth = {
        era: era(birthYear), ganzhi: ganzhi(birthYear),
        region, cls, talents: talents.map((t) => W.talents.find((x) => x.id === t)),
        family: fmt(pickWeighted(R, cls.family, () => 1)),
      };
      emit({ type: 'event', tag: '降生', text: fmt(W.birthText) });
      emit({ type: 'event', text: s.birth.family });
      g.queue = buildYearQueue();
    }

    // ---------- 年度流程
    // 祖上碰過的排程抉擇，再碰到的機會：童年的卡打折少；隔得很久（曾祖那一輩）的也放寬一些
    function repeatRate(e) {
      const W = data.world;
      if (e.age[1] <= 15) return W.familyRepeatChild ?? 0.6;
      const ago = S().year - ((S().familySeen || {})['@' + e.id] ?? -999);
      if (ago >= (W.familyRepeatOldGap ?? 45)) return W.familyRepeatOld ?? 0.5;
      return W.familyRepeatStage ?? 0.3;
    }
    function buildYearQueue() {
      const s = S();
      const q = [];
      // 因果：多年前排下的事
      for (const sc of s.scheduled.filter((x) => x.year === s.year)) q.push({ id: sc.id, force: true });
      s.scheduled = s.scheduled.filter((x) => x.year !== s.year);
      // 主線、羈絆、人生階段：照順序，執行時才判斷條件
      const due = scheduledPool
        .filter((e) => !e.year || (s.year >= arr(e.year)[0] && s.year <= (arr(e.year)[1] ?? arr(e.year)[0])))
        .filter((e) => !e.age || (s.age >= e.age[0] && s.age <= e.age[1]))
        // 有年份的時代大事，家族裡有人經歷過就不再重演（familyRepeat 例外）
        .filter((e) => !e.year || e.familyRepeat || !ancestorsSaw(e.id));
      // 這一年本來就有兩張以上的大事抉擇（例如甲子年），與史實無關的人生抉擇就讓一讓
      let pTaken = due.filter((e) => e.p == null && e.choices && !s.fired[e.id] && meets(e.req)).length >= 2;
      const cand = due
        // 有 p 的人生抉擇：在年齡範圍裡每年只有 p 的機會，不會人人都在同一歲碰上；範圍的最後一年一定輪到
        // 同一年最多一張這種抉擇，其餘順延到之後的年份（接家那年常會一口氣湧上好幾張）
        .filter((e) => {
          if (e.p == null || !e.age || s.fired[e.id]) return true;
          // 排入時就要符合條件：否則年中剛成親、剛添丁，限定條件的幾張會在同一年一起湧上來
          // 家族裡有人碰過的：機會打折，最後一年也不保底；familyOnce 的一個家族只碰一次
          // 童年的抉擇打折少一點（familyRepeatChild）：小時候接家的孩子能挑的卡本來就少，再碰到也會換一種開場
          const rep = !e.familyRepeat && (s.familySeen || {})[e.id], last = !rep && s.age >= e.age[1];
          if (rep && (e.familyOnce || s.year - (s.familySeen['@' + e.id] ?? -999) < (e.age[1] <= 15 ? (data.world.familyRepeatGapChild ?? 15) : (data.world.familyRepeatGap ?? 25)))) return false;
          if (!meets(e.req) || (pTaken && !last) || (!last && R() >= e.p * (rep ? repeatRate(e) : 1))) return false;
          pTaken = true;
          return true;
        })
        .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
      for (const e of cand) q.push({ id: e.id });
      // 隨機小事：每年一到三件，多數年份兩件
      const n = R() < 0.25 ? 1 : R() < 0.7 ? 2 : 3;
      const picked = [];
      for (let i = 0; i < n; i++) {
        // 同一組的小事一年只會有一件（例如豐收和蝗災不會同一年發生）
        const pool = flavorPool.filter((e) => !picked.includes(e) && !(e.group && picked.some((x) => x.group === e.group)) && okFlavor(e));
        // 祖上經歷過的小事，接班人比較少再碰上一模一樣的
        const fam = S().familySeen || {};
        const ev = pickWeighted(R, pool, (e) => (e.w ?? 1) * (fam[e.id] ? (data.world.familyRepeatWeight ?? 0.35) : 1));
        if (ev) picked.push(ev);
      }
      for (const e of picked) q.push({ id: e.id, flavor: true });
      return q;
    }

    // 祖上（不是自己）碰過這件事：家族記錄的次數比自己這輩子的多
    function ancestorsSaw(id) {
      const s = S();
      return ((s.familySeen || {})[id] || 0) > (s.fired[id] || 0);
    }

    function okFlavor(e) {
      const s = S();
      if (!e.repeat && s.fired[e.id]) return false;
      if (e.repeat && s.fired[e.id] >= e.repeat) return false;
      // 可重複的小事：同一個人碰過以後，至少隔 repeatGap 年才會再碰到
      if (e.repeat && e.repeatGap && s.fired[e.id] && s.year - ((s.familySeen || {})['@' + e.id] ?? -999) < e.repeatGap) return false;
      // 祖上傳說這類只該說一次的小事：家族裡誰聽過了，後代就不再重複
      if (e.familyOnce && (s.familySeen || {})[e.id]) return false;
      if (e.year && !(s.year >= e.year[0] && s.year <= e.year[1])) return false;
      if (e.year && !e.familyRepeat && ancestorsSaw(e.id)) return false;
      if (e.p != null && R() >= e.p) return false; // 稀有小事：每年只有 p 的機會進候選
      return meets(e.req);
    }

    function canFire(item) {
      const ev = byId[item.id];
      if (!ev) return null;
      const s = S();
      // 排定的後續通常不再看條件；標了 recheck 的（例如幾年後再來說媒），到時候還要再確認一次
      if (item.force) return ev.recheck && !meets(ev.req) ? null : ev;
      // 出征在外的那一年，家鄉的瑣事輪不到你
      if (item.flavor && s.campaignYear === s.year) return null;
      if (ev.kind !== 'flavor' && s.fired[ev.id] && !ev.repeat) return null;
      // 要你拿主意的劇情卡，沒寫年齡就當作是給大人的（年幼的接班人不會被問要不要上陣）
      const r = ev.req || {};
      if (ev.choices && !ev.age && !r.age && !r.son && !r.child && r.married == null && s.age < (data.world.minChoiceAge ?? 14)) return null;
      return meets(ev.req) ? ev : null;
    }

    function endYear() {
      const s = S();
      const W = data.world;
      // 人生重心帶來的慢慢累積
      // 年輕時學得快：三十歲前每年累積，三十一到四十五歲隔年一次，之後不再累積
      if (s.focus && (s.age <= 30 || (s.age <= 45 && s.age % 2 === 0))) {
        const f = W.focus[s.focus];
        if (f && f.yearly) apply(f.yearly, null);
      }
      // 年紀與疫病
      const band = W.mortality.find((m) => s.age >= m.age[0] && s.age <= m.age[1]);
      let h = band ? band.p : 0.05;
      // 疫年：數字是天下大疫；{year, regions} 是只在某些地方流行的疫病
      const plague = W.plagueYears.some((y) => typeof y === 'number' ? y === s.year : y.year === s.year && (!y.regions || y.regions.includes(s.region)));
      if (plague) h *= W.plagueMult;
      h *= 1.6 - s.hp / 100;
      h *= 1 + 0.25 * s.injuries.length;
      // 第一代的主角在五歲前大多能撐過來（否則一投胎就結束）；撐過來的那一次，留下一句話
      const r = R();
      // 還沒有弟妹可以接手的時候一定撐得過去，否則一投胎就結束
      const noBackup = !s.siblings.some((c) => c.alive && c.born <= s.year);
      const spared = s.firstLife && s.age < 5 ? (noBackup ? 1 : plague ? 0 : (W.firstChildSpare ?? 0)) : 0;
      if (r < h && r >= h * (1 - spared)) {
        if (!s.nearlyLost) {
          s.nearlyLost = true;
          emit({ type: 'event', tag: '險', text: fmt(variant(W.nearlyLostText, 'nearlyLostText')) });
        }
      } else if (r < h) {
        const cause = plague ? '疫病' : band.cause;
        // 命硬的人這一次撐得過去：先寫病倒，不要先寫「沒有再醒來」再讓他活過來
        if (s.talents.includes('命硬') && !s.flags._mingying && W.mingyingIllText) {
          emit({ type: 'event', tag: '險', text: fmt(variant(W.mingyingIllText, 'mingyingIllText')) });
          die(cause, null);
        } else {
          const entry = emit({ type: 'event', tag: '終', text: fmt(plague ? variant(W.plagueDeathText, 'plagueDeathText') : variant(band.text, 'band' + band.age[0])) });
          die(cause, entry);
        }
      }
      // 配偶也會老、會病：大致跟你同齡，死亡率比照你這個年紀
      if (s.alive && spouseHere() && s.age >= 30 && band && R() < band.p * (W.spouseMortality ?? 0.9) * (plague ? W.plagueMult : 1)) {
        apply({ flag: 'spouse_dead_old', 健: -8 }, null);
        const pool = W.spouseDeathTexts || [];
        emit({ type: 'event', tag: '喪偶', text: fmt(pool[Math.floor(R() * pool.length)] || '{spouse}走了。') });
      }
      // 成了家的人，每年有一定機會添一個孩子
      if (s.alive && spouseHere() && s.age >= 16 && s.age <= 45 && s.children.length < 6 && R() < (W.childChance ?? 0.2)) {
        apply({ child: true }, null);
        emit({ type: 'event', tag: '添丁', text: fmt(variant(W.childText, 'childText')) });
      }
      if (s.alive && s.age >= 1) s.hp = clamp(s.hp + (s.age < 40 ? 2 : -1), 0, 100);
    }

    function beginYear() {
      const s = S();
      s.year += 1;
      s.age += 1;
      emit({ type: 'year', era: era(s.year), ganzhi: ganzhi(s.year) });
      g.queue = buildYearQueue();
    }

    // 誰能接下這個家：先看自己的孩子，沒有就看還活著的兄弟姊妹。
    // 孩子在背景裡長大，接手的時候才擲一次骰子決定是否平安長大。
    // 上陣打仗的劇情：黃巾、官軍、義勇的路線卡，以及各家軍中限男子的卡
    function isCampaign(ev) {
      const r = ev.req || {};
      if (ev.campaign) return true;
      if (r.route && ['huangjin', 'guanjun', 'xiangyong'].includes(r.route)) return true;
      return r.gender === 'm' && !!r.faction && !arr(r.faction).includes('civ');
    }
    // 配偶還在身邊：成了親、沒有過世、也沒有被抓走未歸
    function spouseHere() {
      const s = S(), f = s.flags;
      return !!s.spouse && !f.widowed && !f.spouse_dead_old && !(f.spouse_taken && !f.spouse_returned);
    }
    function survivors(list) {
      const s = S();
      return list.filter((c) => {
        if (!c.alive || c.away || c.born > s.year) return false;
        if (c.checked) return true;
        c.checked = true;
        const age = s.year - c.born;
        const p = age < 5 ? 0.82 : age >= 60 ? Math.max(0.05, 1 - (age - 55) * 0.07) : 0.8;
        c.alive = R() < p;
        return c.alive;
      });
    }
    function findHeirs() {
      const s = S();
      const own = survivors(s.children).sort((a, b) => a.born - b.born);
      if (own.length) {
        const list = own.map((c) => ({ ...c, rel: c.gender === 'm' ? '子' : '女' }));
        // 長子女上了年紀，也可以把家交給長孫。名字、年紀用另一條亂數算，不動主線亂數，舊存檔重播不走樣
        const W = data.world;
        if (s.year - own[0].born >= (W.grandHeirAge ?? 40)) {
          const via = own.find((c) => c.gender === 'm') || own[0];
          const lr = mulberry32((g.seed ^ Math.imul(s.year, 2654435761)) + s.generation);
          const gg = lr() < 0.5 ? 'm' : 'f', N = W.names;
          const sur = via.gender === 'm' ? via.name[0] : N.surnames[Math.floor(lr() * N.surnames.length)];
          const pool = gg === 'm' ? N.male : N.female;
          const taken = [s.name, s.spouse, ...own.map((c) => c.name)].filter(Boolean).map((x) => x.slice(1));
          let nm = sur + pool[Math.floor(lr() * pool.length)];
          for (let k = 0; k < 12 && taken.includes(nm.slice(1)); k++) nm = sur + pool[Math.floor(lr() * pool.length)];
          const born = Math.min(via.born + 20 + Math.floor(lr() * 8), s.year - 16);
          list.push({ name: nm, gender: gg, born, alive: true, rel: gg === 'm' ? '孫' : '孫女', via: via.name });
          // 列出了長孫，就等於說了這個孩子早已成家；往後輪到他以弟妹身分接家，不能變成一輩子沒成家的人
          list.find((x) => x.name === via.name).knownWed = true;
        }
        return list;
      }
      const sib = survivors(s.siblings).sort((a, b) => a.born - b.born);
      return sib.map((c) => ({ ...c, rel: c.gender === 'm' ? '弟' : '妹' }));
    }

    // 結局：死了就是這一生的結局（有後人就傳下去）；活著走到章末，若還有下一章就是「章末」，否則是最終結局
    function evaluateEnding() {
      const s = S();
      histText = false;
      const list = data.endings;
      const heirs = !s.alive ? findHeirs() : [];
      const personEnded = !s.alive || !chapterOf(s.chapter + 1);
      const last = (!s.alive && !heirs.length) || (s.alive && !chapterOf(s.chapter + 1));
      const ending = list.find((e) =>
        (e.chapter == null || e.chapter === s.chapter) &&
        (e.when === 'dead' ? !s.alive : e.when === 'alive' ? s.alive : true) &&
        (!e.cause || arr(e.cause).includes(s.cause)) &&
        meets(e.req)) || list[list.length - 1];
      const after = [];
      for (const id in s.bonds) {
        const def = data.bonds[id];
        const tier = s.bonds[id];
        if (tier > 0 && def.after && def.after[tier]) after.push({ who: def.name, tier: def.tiers[tier], text: fmt(def.after[tier]) });
      }
      // 不分章的 final 後記跟著這個人走（人死就出現）；有分章的 final 後記是整段歷史的收尾，只在真正的結局出現
      const shown = (data.world.epilogues || [])
        .filter((e) => (e.chapter == null || e.chapter === s.chapter) &&
          (!e.final || (e.chapter == null ? personEnded : last)) && meets(e.req));
      // 個人往事（不分章的 final 後記）與天下的收尾分開，介面先放往事、最後放天下
      const isMemory = (e) => e.final && e.chapter == null;
      const noKid = !s.children.some((c) => c.alive);
      // 往事只算這輩子親身經歷的：從上一代繼承來的旗標沒有取得的年份
      const fy = s.flagYear || {};
      // pri 高的排前面（故事線的結局比零碎小事更像「這一生」），同級照資料順序
      const picked = shown.filter(isMemory).sort((a, b) => (b.pri || 0) - (a.pri || 0)).map((e) => {
        const f = typeof e.req?.flag === 'string' ? e.req.flag : arr(e.req?.anyFlag).find((x) => s.flags[x] && x in fy);
        if (f && !(f in fy)) return null;
        const since = s.year - (fy[f] ?? s.year);
        let t = e.text;
        if (e.minYears && since < e.minYears) t = e.short ?? null;          // 經歷之後沒活幾年
        if (t && e.beforeYear && s.year >= e.beforeYear) t = e.lateText ?? null; // 文字說的未來，已經過去了
        if (t && s.alive && e.aliveText) t = e.aliveText;                   // 活著走到最後一章
        if (t && s.alive && /你走(的|以後|之後)/.test(t)) t = null;           // 活著的人不能說「你走以後」
        if (t && e.noKid && noKid) t = e.noKid;                              // 膝下沒有孩子
        return t ? { life: !!e.life, t: fmt(t, (s.flagRegion || {})[f]) } : null; // 麥或稻：照事情發生時住的地方
      }).filter(Boolean);
      // 日常故事（life）與歷史經歷輪流排，前三件裡兩種都看得到
      const lifeM = picked.filter((m) => m.life), histM = picked.filter((m) => !m.life), memories = [];
      for (let i = 0; i < Math.max(lifeM.length, histM.length); i++) { if (lifeM[i]) memories.push(lifeM[i].t); if (histM[i]) memories.push(histM[i].t); }
      const epilogue = shown.filter((e) => !isMemory(e)).map((e) => fmt(e.text));
      const result = {
        id: ending.id, title: fmt(ending.title), rare: !!ending.rare, text: fmt(noKid && ending.noKid ? ending.noKid : ending.text),
        alive: s.alive, cause: s.cause, age: s.age, year: s.year, chapter: s.chapter,
        chapterTitle: chapterOf(s.chapter)?.title || null,
        next: s.alive && !last ? chapterOf(s.chapter + 1) : null,
        after: personEnded ? after : [], epilogue, memories,
        name: s.name, generation: s.generation,
      };
      s.chapterEndings = (s.chapterEndings || []).concat([{ chapter: s.chapter, id: result.id, title: result.title, name: s.name }]);
      if (personEnded) s.lineage = s.lineage.concat([{ gen: s.generation, name: s.name, gender: s.gender, born: s.birthYear, died: s.alive ? null : s.year, age: s.age, cause: s.cause, title: result.title, memo: memories[0] }]); // 家譜上每一代留一句往事
      result.lineage = s.lineage;
      if (!s.alive && heirs.length) { result.heirs = heirs.map((h) => ({ name: h.name, gender: h.gender, age: s.year - h.born, rel: h.rel, via: h.via })); g.succession = { result, heirs }; return; }
      if (last) { result.extinct = !s.alive; g.ended = result; } else g.interlude = result;
    }

    // 接班：用選中的孩子建立新的一條人生，家世、勢力、住處、部分財產與名聲傳下去
    function becomeHeir(i) {
      const W = data.world;
      const p = S();
      const { heirs } = g.succession;
      const h = heirs[i] || heirs[0];
      const age = p.year - h.born;
      const cls = W.classes.find((c) => c.id === p.cls);
      // 父母當過官或很有錢，家世往上提一級
      let clsId = p.cls;
      const order = W.classes.map((c) => c.id);
      if ((p.flags.official || p.flags.official_late || p.stats['名'] >= 50) && order.indexOf(clsId) < order.indexOf('clerk')) clsId = 'clerk';
      else if (p.stats['財'] >= 40 && order.indexOf(clsId) < order.indexOf('farmer')) clsId = 'farmer';
      const ncls = W.classes.find((c) => c.id === clsId);
      const talents = [];
      if (R() < 0.5) talents.push(p.talents[Math.floor(R() * p.talents.length)]);
      while (talents.length < 2) {
        const t = pickWeighted(R, W.talents.filter((x) => !talents.includes(x.id)), (x) => x.w);
        talents.push(t.id);
      }
      const grow = Math.min(age, 25);
      const stats = Object.assign({ 武: 0, 文: 0, 德: 0, 名: 0, 財: 0 }, ncls.stats);
      stats['武'] += Math.floor(grow * 0.5);
      stats['文'] += Math.floor(grow * (clsId === 'clerk' || clsId === 'gentry' ? 0.6 : 0.25));
      stats['德'] += Math.round(p.stats['德'] * 0.3);
      stats['名'] += Math.round(p.stats['名'] * 0.35);
      stats['財'] += Math.round(p.stats['財'] * 0.6);
      for (const k of STATS) stats[k] = clamp(stats[k], 0, 100);
      const flags = { heir: true };
      if (age < 14) flags.heir_young = true; // 接手時還小，等長大了才輪到自己拿主意
      // 父母的生死：孩子接班，死去的上一代就是父或母；弟妹接班，父母狀態跟兄姊相同
      if (h.rel === '弟' || h.rel === '妹') {
        if (p.flags.father_dead) flags.father_dead = true;
        if (p.flags.mother_dead) flags.mother_dead = true;
      } else if (h.via) {
        flags.grand_heir = true; // 長孫接班：過世的是祖父母，爹娘都還在
      } else {
        flags[p.gender === 'm' ? 'father_dead' : 'mother_dead'] = true;
        // 另一位家長就是上一代的配偶
        if (p.flags.widowed || p.flags.spouse_dead_old) flags[p.gender === 'm' ? 'mother_dead' : 'father_dead'] = true;
      }
      for (const f of W.inheritFlags || []) if (p.flags[f]) flags[f] = true;
      // 祖上的事：記住是誰做的。上一任當家親自做的寫他的名字，更早以前的就只說「家裡的長輩」
      const elders = {};
      for (const f of W.parentFlags || []) {
        if (p.flags[f]) { flags['p_' + f] = true; elders[f] = p.name; }
        else if (p.flags['p_' + f]) flags['p_' + f] = true;
      }
      const siblings = h.via ? [] : heirs.filter((x) => x !== h && !x.via).map((x) => ({ name: x.name, gender: x.gender, born: x.born, alive: true, checked: false, knownWed: !!(x.wed || x.knownWed) }));
      const surname = h.name[0];
      g.st = {
        name: h.name, surname, gender: h.gender, birthYear: h.born, year: p.year, age,
        // 兄弟姊妹接班還是同一代
        children: [], siblings, generation: (h.rel === '弟' || h.rel === '妹') ? p.generation : p.generation + (h.via ? 2 : 1), lineage: p.lineage,
        region: p.region, regionName: p.regionName, place: p.place, regionHist: [...(p.regionHist || [])], // 這一家歷年住過的地方：接家的人小時候住哪裡，從這裡查
        cls: clsId, clsName: ncls.name, talents, stats, hp: 70, flags, bonds: {},
        focus: null, route: null, faction: p.faction, chapter: p.chapter, spouse: null,
        friend: randomName('m'), injuries: [], fired: {}, scheduled: [], choices: [], log: [],
        alive: true, cause: null, chapterEndings: p.chapterEndings, familySeen: { ...(p.familySeen || {}) },
        // 孩子接班：父母就是前一位；弟妹接班：父母跟前一位相同
        parentName: h.via || ((h.rel === '弟' || h.rel === '妹') ? (p.parentName || null) : p.name),
        elders,
        // 祖上幾代當家和他們的配偶：往後孩子取名都要避開
        forbid: [...(p.forbid || []), p.name, p.spouse].filter(Boolean),
      };
      const s = g.st;
      unclashFriend(s);
      for (const t of talents) { const def = W.talents.find((x) => x.id === t); if (def.eff) apply(def.eff, null); }
      s.birth = { era: era(h.born), ganzhi: ganzhi(h.born), region: W.regions.find((r) => r.id === s.region), cls: ncls, talents: talents.map((t) => W.talents.find((x) => x.id === t)), family: '' };
      // 接班時已經成年的人，大多早就成了家，這些年也添了孩子
      let wedText = null;
      // 弟妹早已成家的（成過親、或曾經被列出孩子接班）一定是成了家的人。亂數照樣抽一次，舊存檔重播不走樣
      if ((h.wed && age >= 15) || (age >= 18 && (R() < (age >= 25 ? (W.heirMarried ?? 0.9) : 0.6) || h.knownWed))) {
        s.spouse = spouseName(s.gender === 'm' ? 'f' : 'm');
        const sur = s.gender === 'm' ? s.surname : s.spouse[0];
        for (let y = h.born + 19; y < s.year && y <= h.born + 45; y++) {
          if (s.children.length >= 6 || R() >= (W.heirPastChildRate ?? 0.1)) continue;
          if (R() >= (W.heirPastChildSurvive ?? 0.7)) continue; // 沒能養大的孩子
          const cg = R() < 0.5 ? 'm' : 'f';
          const nm = kidName(sur, cg);
          s.children.push({ name: nm, gender: cg, born: y, alive: true });
          s.flags.has_child = true;
        }
        wedText = age >= 45 && W.heirWedOldText && s.children.some((c) => s.year - c.born >= 20) ? W.heirWedOldText : s.children.length > 1 ? W.heirWedKidsText : s.children.length ? W.heirWedKidText : W.heirWedText;
      }
      g.succession = null;
      g.out = [];
      emit({ type: 'heir', text: `第${cnNum(s.generation)}代　${s.name}`, gen: s.generation, rel: h.rel });
      emit({ type: 'event', tag: '傳承', text: fmt(variant(W.heirText, 'heirText')) });
      if (h.via) emit({ type: 'event', tag: '傳承', text: fmt(variant(W.heirGrandText, 'heirGrand')) });
      if (wedText) emit({ type: 'event', tag: '成家', text: fmt(variant(wedText, 'heirWed')) });
      g.queue = [];
      if (s.year >= chapterOf(s.chapter).end) evaluateEnding();
      else beginYear();
      return g.out;
    }

    // ---------- 對外介面
    function step() {
      // 一路往前跑，直到需要玩家抉擇、或這一生結束。回傳這段期間新增的紀錄。
      // 一次走一年：年紀標題和這一年發生的事一起出來，再停下來讓人看（不是先出標題、停一下才出事）
      g.out = [];
      let guard = 0, advanced = false;
      const before = g.out.length;
      while (!g.pending && !g.ended && !g.interlude && !g.succession && guard++ < 500) {
        const s = S();
        if (!s.alive) { evaluateEnding(); break; }
        if (g.queue.length) {
          const item = g.queue.shift();
          const ev = canFire(item);
          if (ev) fire(ev);
          continue;
        }
        // 這一年剩下的事都出完了：已經換過年、或這一步本來就有東西出來，就停在這裡
        // （背後跑祖上幾代時沿用舊的停法：換年後就停。後代投胎選定出生時機靠這個停點，改了舊存檔會對不上）
        if (!opts.ancestor && (advanced || g.out.length > before)) break;
        endYear();
        if (!s.alive) { evaluateEnding(); break; }
        if (s.year >= chapterOf(s.chapter).end) { evaluateEnding(); break; }
        beginYear();
        if (opts.ancestor) break;
        advanced = true;
      }
      return g.out;
    }

    function choose(i) {
      if (!g.pending) return [];
      const { ev, opts } = g.pending;
      const o = opts[i];
      if (!o || !o.ok) return [];
      g.out = [];
      g.pending = null;
      resolve(ev.choices[o.i], ev, o.t);
      if (!S().alive) evaluateEnding();
      return g.out;
    }

    // 投胎到某個家族的後代：先在背後把前幾代的人生真的跑一遍，再讓玩家出生成為這一代當家的孩子
    function bornLate() {
      const W = data.world, L = W.lateStart || {};
      const lr = mulberry32((seed ^ 0x9e3779b9) >>> 0);
      const here = (p) => !!p.spouse && !p.flags.widowed && !p.flags.spouse_dead_old && !(p.flags.spouse_taken && !p.flags.spouse_returned);
      const [y0, y1] = L.years || [190, 262];
      for (let tries = 0; tries < 30; tries++) {
        const target = y0 + Math.floor(lr() * (y1 - y0 + 1));
        const anc = createGame(data, Math.floor(lr() * 2 ** 31), { ancestor: true });
        let k = 0, P = null;
        while (!anc.ended && k++ < 20000) {
          const a = anc.state;
          if (a.year > target + 15) break;
          if (!anc.pending && !anc.interlude && !anc.succession && a.alive && a.year >= target && a.age >= 18 && a.age <= 40 && here(a)) { P = a; break; }
          if (anc.interlude) { anc.continueChapter(); continue; }
          if (anc.succession) { anc.continueAsHeir(0); continue; }
          if (anc.pending) { const ok = anc.pending.opts.filter((o) => o.ok); anc.choose(anc.pending.opts.indexOf(ok[Math.floor(lr() * ok.length)])); continue; }
          anc.step();
        }
        if (P) return bornAsChildOf(P);
      }
      born(); // 很少發生：前幾代一直沒有適合的時機，就照一般方式投胎
    }

    function bornAsChildOf(P) {
      const W = data.world;
      const gender = R() < 0.5 ? 'm' : 'f';
      const surname = P.gender === 'm' ? P.surname : P.spouse[0];
      const cls = W.classes.find((c) => c.id === P.cls);
      const talents = [];
      while (talents.length < 2) {
        const t = pickWeighted(R, W.talents.filter((x) => !talents.includes(x.id)), (x) => x.w);
        talents.push(t.id);
      }
      // 傳給後代的東西：住處與全家的決定、祖上（已過世那幾代）的傳說
      const flags = {};
      for (const f of W.inheritFlags || []) if (P.flags[f]) flags[f] = true;
      for (const f of W.parentFlags || []) if (P.flags['p_' + f]) flags['p_' + f] = true;
      const older = (P.children || []).filter((c) => c.alive && !c.away).map((c) => ({ name: c.name, gender: c.gender, born: c.born, alive: true }));
      const year = P.year;
      const stats = Object.assign({ 武: 0, 文: 0, 德: 0, 名: 0, 財: 0 }, cls.stats);
      stats['名'] = clamp(stats['名'] + Math.round((P.stats['名'] || 0) * 0.2), 0, 100);
      stats['財'] = clamp(stats['財'] + Math.round((P.stats['財'] || 0) * 0.3), 0, 100);
      g.st = {
        name: '', surname, gender, birthYear: year, year, age: 0,
        children: [], siblings: [...older], generation: P.generation + 1, lineage: P.lineage.map(({ memo, ...x }) => x), // 自動跑過的祖上不是你親身活過的，不留「你」的往事
        region: P.region, regionName: P.regionName, place: P.place, regionHist: [[year, P.region, P.place]],
        cls: cls.id, clsName: cls.name, talents, stats,
        hp: 70, flags, bonds: {}, focus: null, route: null, faction: P.faction, chapter: P.chapter, spouse: null,
        friend: randomName('m'), injuries: [], fired: {}, scheduled: [], choices: [], log: [],
        alive: true, cause: null, firstLife: true, lateStart: true,
        chapterEndings: P.chapterEndings || [], familySeen: { ...(P.familySeen || {}) },
        parentName: P.name, elders: { ...(P.elders || {}) },
        forbid: [...(P.forbid || []), P.name, P.spouse].filter(Boolean),
      };
      const s = g.st;
      // 名字：不跟兄姊同名，也不用父母的名
      const avoid = [P.name, P.spouse, ...(P.forbid || []), ...older.map((c) => c.name)].filter(Boolean);
      let nm = surname + randomGiven(gender);
      for (let k = 0; k < 12 && avoid.some((n) => n === nm || n.slice(1) === nm.slice(1)); k++) nm = surname + randomGiven(gender);
      s.name = nm;
      // 往後還會有弟妹（接家時的備援）
      const nYoung = Math.floor(R() * 3);
      for (let i = 0; i < nYoung; i++) {
        const sg = R() < 0.5 ? 'm' : 'f';
        s.siblings.push({ name: surname + randomGiven(sg), gender: sg, born: year + 1 + Math.floor(R() * 8), alive: true });
      }
      unclashSiblings(s, older.length, [P.spouse]);
      unclashFriend(s);
      for (const t of talents) { const def = W.talents.find((x) => x.id === t); if (def.eff) apply(def.eff, null); }
      const first = s.lineage[0];
      const parentRole = P.gender === 'm' ? '父親' : '母親';
      let family = `你是${surname}家的第${cnNum(s.generation)}代。${parentRole}${P.name}是這一代當家的人`;
      const n = older.length;
      family += n ? `，你上頭還有${n === 2 ? '兩' : cnNum(n)}個哥哥姊姊。` : '，你是頭一個孩子。';
      if (first) family += `祖上${first.name}那一輩「${first.title}」的事，家裡的人常常提起。`;
      s.birth = {
        era: era(year), ganzhi: ganzhi(year), region: W.regions.find((r) => r.id === s.region), cls,
        talents: talents.map((t) => W.talents.find((x) => x.id === t)), family, late: true,
        parent: { gen: P.generation, name: P.name, born: P.birthYear },
      };
      emit({ type: 'event', tag: '降生', text: fmt(W.birthText) });
      emit({ type: 'event', text: family });
      g.queue = buildYearQueue();
    }

    if (opts.late && !opts.ancestor) bornLate(); else born();

    return {
      seed,
      get state() { return g.st; },
      get pending() { return g.pending ? { title: g.pending.entry.title, tag: g.pending.ev.tag, text: g.pending.entry.text, note: g.pending.ev.note, who: g.pending.ev.who, opts: g.pending.opts } : null; },
      get ended() { return g.ended; },
      get interlude() { return g.interlude; },
      get succession() { return g.succession ? { ...g.succession.result } : null; },
      continueAsHeir(i) { return g.succession ? becomeHeir(i || 0) : []; },
      // 章末之後繼續同一條人生
      continueChapter() {
        if (!g.interlude) return [];
        g.out = [];
        g.interlude = null;
        S().chapter += 1;
        const c = chapterOf(S().chapter);
        emit({ type: 'chapter', text: c.title, n: c.n });
        beginYear();
        return g.out;
      },
      step, choose,
      eraLabel: (y) => era(y), ganzhi,
    };
  }

  // 把 data/ 底下幾個檔案合成引擎要的一份資料
  function mergeData(world, parts, endings) {
    const out = { world, events: [], bonds: {}, endings: endings.endings };
    for (const p of parts) {
      if (p.events) out.events.push(...p.events);
      if (p.bonds) Object.assign(out.bonds, p.bonds);
    }
    return out;
  }

  const api = { createGame, mergeData, STATS, ganzhi, eraLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SanguoEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
