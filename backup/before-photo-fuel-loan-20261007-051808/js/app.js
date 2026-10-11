/* Local-first garage. No network requests, telemetry, or external dependencies. */
(function () {
  'use strict';
  const G = window.Garage;
  const $ = selector => document.querySelector(selector);
  const KEY = 'maiteng.garage.v2';
  const RECOVERY = KEY + '.before-import';
  const seed = G.normalize(JSON.parse($('#initial-data').textContent));
  const names = {overview:'用车总览',fuel:'加油账本',maintenance:'保养记录',profile:'车辆档案',documents:'资料与备份'};
  let data = G.clone(seed), page = 'overview', editor = null, importData = null, undoAction = null, timer = null;
  let storageAvailable = true, corruptedStorage = false, stale = false;
  let fuelQuery = '', fuelYear = '';
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (value,digits=0) => G.num(value) ? value.toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
  const money = value => G.num(value) ? '¥ ' + fmt(value,2) : '待填写';
  const label = value => value == null || value === '' ? '待填写' : esc(value);
  const dateLabel = value => value ? esc(value) : '日期待补充';
  const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  function warning(text) { $('#storage-warning').hidden = !text; $('#storage-warning').textContent = text; }
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      try { data = G.normalize(JSON.parse(saved)); }
      catch { corruptedStorage = true; warning('浏览器中的旧记录无法读取，已保留原内容。当前显示初始档案。请先到“资料与备份”下载原始存储副本，再导入有效备份。'); }
    }
    const probe = KEY + '.probe'; localStorage.setItem(probe,'1'); localStorage.removeItem(probe);
  } catch { storageAvailable = false; warning('浏览器未允许本地保存。本次修改仅在当前页面有效，请离开前导出备份。'); }

  function updateSaveLabel() {
    $('#save-state').textContent = !storageAvailable ? '仅本次会话 · 请导出备份' : corruptedStorage ? '旧数据待恢复' : data.updatedAt ? '已保存在当前浏览器' : '初始档案 · 尚未修改';
  }
  function persist(next, {importing=false} = {}) {
    if (stale) throw Error('另一窗口已更新车库。请刷新本页后再编辑，以免覆盖新记录。');
    if (corruptedStorage && !importing) throw Error('请先下载原始存储副本并导入有效备份，再保存修改。');
    next = G.normalize(next);
    next.updatedAt = new Date().toISOString();
    if (storageAvailable) {
      try { localStorage.setItem(KEY,JSON.stringify(next)); }
      catch { storageAvailable = false; warning('浏览器保存失败，可能是存储空间不足。本次修改仍在页面中，请立即导出备份。'); }
    }
    data = next;
    if (importing) { corruptedStorage = false; if (storageAvailable) warning(''); }
    updateSaveLabel();
  }
  function notify(text, undo=null) {
    clearTimeout(timer); undoAction = undo;
    $('#message-text').textContent = text; $('#message').hidden = false; $('#undo').hidden = !undo;
    if (!undo) timer = setTimeout(()=>$('#message').hidden=true,6500);
  }
  function btn(text,action,attrs='',primary=false) { return `<button class="button ${primary?'primary':''}" data-action="${action}" ${attrs}>${text}</button>`; }
  function header(title,description,actions='') { return `<div class="page-head"><div><h1>${title}</h1><p>${description}</p></div><div class="actions">${actions}</div></div>`; }
  function unverifiedNotice() {
    if (data.vehicle.verified && data.purchase.verified) return '';
    return '<div class="notice">车型和购车账本沿用历史对话，尚未核对。请在 <a href="#profile">车辆档案</a> 中核对并保存；保养与质保日期需以车辆手册和实际凭证为准。</div>';
  }
  function stat(title,value,unit,caption) { return `<div class="stat"><div class="label">${title}</div><div class="number">${value}<span class="unit">${unit}</span></div><div class="caption">${caption}</div></div>`; }
  function empty(title,description,action,text) { return `<div class="empty"><span class="empty-symbol" aria-hidden="true">◇</span><h3>${title}</h3><p>${description}</p>${action?btn(text,action):''}</div>`; }
  function totalDays() { if (!G.validDate(data.vehicle.deliveryDate)) return null; return Math.floor((Date.parse(localDate()+'T12:00:00Z') - Date.parse(data.vehicle.deliveryDate+'T12:00:00Z'))/86400000); }
  function reminderView(s) {
    const r = data.reminders;
    if (!r.date && r.mileage == null) return empty('下次保养，提前记下','按保养手册或门店确认的信息设置提醒。','edit-reminder','设置保养提醒');
    let rows = '';
    if (r.date) {
      const days = Math.round((Date.parse(r.date+'T12:00:00Z')-Date.parse(localDate()+'T12:00:00Z'))/86400000);
      rows += `<p class="reminder-title">${esc(r.date)}</p><p class="muted">${days<0?'已超过计划日期 '+Math.abs(days)+' 天':days===0?'今天到计划日期':'距计划日期 '+days+' 天'}</p>`;
    }
    if (r.mileage != null) rows += `<p>计划里程 <strong>${fmt(r.mileage)} km</strong><br><span class="caption">${s.mileage==null?'补充当前里程后显示剩余公里数。':s.mileage>=r.mileage?'已达到计划里程':'还差 '+fmt(r.mileage-s.mileage)+' 公里'}</span></p>`;
    return rows + (r.note?`<p class="caption">${esc(r.note)}</p>`:'') + btn('调整提醒','edit-reminder');
  }
  function recentFuel() {
    if (!data.fuelRecords.length) return empty('还没有加油记录','记下金额、升数和里程，开始建立用车账本。','add-fuel','记一笔加油');
    return '<ul class="record-list">'+[...data.fuelRecords].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,4).map(r=>`<li><div><strong>${dateLabel(r.date)}</strong> ${r.full?'<span class="tag good">已加满</span>':''}<p class="caption">${r.station?esc(r.station):'加油站待补充'} · ${G.num(r.liters)?fmt(r.liters,2)+' L':'升数待补充'}</p></div><div><div class="amount">${money(r.amount)}</div><button class="button quiet" data-action="edit-fuel" data-id="${esc(r.id)}">${r.date&&r.liters!=null?'编辑':'补充记录'}</button></div></li>`).join('')+'</ul>';
  }
  function overview() {
    const s = G.stats(data), days = totalDays();
    const daysText = days==null ? '提车日期待填写' : days<0 ? '计划提车日期' : `相伴 ${days+1} 天`;
    return header('用车总览','车辆信息、日常花费和下一次保养，都在这里。',btn('导出备份','export')+btn('＋ 记一笔加油','add-fuel','',true))+
      unverifiedNotice()+`<section class="hero" aria-label="车辆摘要"><div class="vehicle-summary"><p class="eyebrow">我的座驾 · ${daysText}</p><h2>迈腾</h2><p class="model muted">${label(data.vehicle.model)} ${data.vehicle.verified?'':'<span class="tag">待核对</span>'}</p><dl class="hero-facts"><div><dt>提车日期</dt><dd>${label(data.vehicle.deliveryDate)}</dd></div><div><dt>生产月份</dt><dd>${label(data.vehicle.productionMonth)}</dd></div><div><dt>车架号后四位</dt><dd>${label(data.vehicle.vinSuffix)}</dd></div></dl></div><div class="odometer"><p class="caption">最近记录里程</p><div class="reading"><strong>${fmt(s.mileage)}</strong><span>km</span></div><p class="caption">${s.mileage==null?'补充一次仪表盘读数，开始记录每一程。':'取车辆档案、加油和保养记录中的最高里程。'}</p>${btn('更新车辆信息','edit-profile')}</div></section>`+
      `<section class="stat-strip" aria-label="用车统计">${stat('累计加油支出',fmt(s.fuelCost,2),'元',data.fuelRecords.length+' 笔记录；仅统计已填金额')}${stat('平均油耗',fmt(s.economy.value,2),'L/100km',s.economy.value==null?'待补齐满箱记录':'满箱法 · '+s.economy.segments+' 个区间')}${stat('累计保养支出',fmt(s.maintenanceCost,2),'元',data.maintenanceRecords.length+' 笔保养记录')}${stat('购车落地合计',fmt(s.purchaseTotal),'元',data.purchase.verified?'未扣除补贴':'历史对话数据 · 待核对')}</section>`+
      `<div class="split"><section class="panel"><div class="section-heading"><h2>最近加油</h2><a class="button quiet" href="#fuel">全部记录 →</a></div>${recentFuel()}</section><section class="panel"><div class="section-heading"><h2>下次保养</h2><span class="caption">自行设置</span></div>${reminderView(s)}</section></div>`;
  }
  function fuelRows() {
    const q = fuelQuery.trim().toLowerCase();
    const rows = [...data.fuelRecords].sort((a,b)=>b.date.localeCompare(a.date)||(b.mileage??-1)-(a.mileage??-1)).filter(r=>(!fuelYear||r.date.startsWith(fuelYear))&&(!q||[r.date,r.station,r.grade,r.note].some(v=>v.toLowerCase().includes(q))));
    if (!rows.length) return empty(data.fuelRecords.length?'没有匹配的记录':'还没有加油记录',data.fuelRecords.length?'试试其他关键词或选择全部年份。':'每次加油后，记下金额、升数和仪表盘里程。',data.fuelRecords.length?null:'add-fuel','记一笔加油');
    return `<table class="data-table"><thead><tr>${['日期 / 加油站','里程 km','金额 / 元','油量 / L','单价 / 元/L','状态','操作'].map(t=>'<th scope="col">'+t+'</th>').join('')}</tr></thead><tbody>`+rows.map(r=>`<tr><td data-label="日期 / 加油站"><div>${dateLabel(r.date)}<small>${esc(r.station||'加油站待补充')}${r.grade?' · '+esc(r.grade):''}</small>${r.note?`<small title="${esc(r.note)}">${esc(r.note)}</small>`:''}</div></td><td data-label="里程 km">${fmt(r.mileage)}</td><td data-label="金额 / 元">${fmt(r.amount,2)}</td><td data-label="油量 / L">${fmt(r.liters,2)}</td><td data-label="单价 / 元/L">${fmt(G.num(r.amount)&&r.liters>0?r.amount/r.liters:null,2)}</td><td data-label="状态"><span class="tag ${r.full?'good':''}">${r.full?'已加满':'未加满 / 未知'}</span></td><td data-label="操作"><div class="table-actions"><button class="button quiet" data-action="edit-fuel" data-id="${esc(r.id)}">编辑</button><button class="button quiet danger" data-action="delete-fuel" data-id="${esc(r.id)}">删除</button></div></td></tr>`).join('')+'</tbody></table>';
  }
  function fuel() {
    const s = G.stats(data), years = [...new Set(data.fuelRecords.filter(r=>r.date).map(r=>r.date.slice(0,4)))].sort().reverse();
    return header('加油账本','记下每一次加油，让花费和油耗有据可查。',btn('导出表格','csv')+btn('＋ 记一笔加油','add-fuel','',true))+
      `<section class="stat-strip">${stat('累计油费',fmt(s.fuelCost,2),'元','所有记录，不受筛选影响')}${stat('已记录油量',fmt(s.liters,2),'L','仅统计已填写的升数')}${stat('平均油耗',fmt(s.economy.value,2),'L/100km',s.economy.value==null?'暂无完整区间':s.economy.segments+' 个完整区间')}${stat('加油次数',fmt(data.fuelRecords.length),'次','按账本记录条数统计')}</section>`+
      `<section class="panel"><div class="toolbar"><label><span>搜索记录</span><input id="fuel-search" type="search" maxlength="100" placeholder="加油站、日期或备注" value="${esc(fuelQuery)}"></label><label><span>年份</span><select id="fuel-year"><option value="">全部年份</option>${years.map(y=>`<option value="${y}" ${y===fuelYear?'selected':''}>${y} 年</option>`).join('')}</select></label></div><div id="fuel-table" class="table-wrap">${fuelRows()}</div></section><p class="caption" style="margin-top:16px">满箱法：从一次加满到下一次加满，区间内全部加油升数 ÷ 行驶公里数 × 100。起点那次的油量不计入。${esc(s.economy.reason)} 未完成或数据不全的区间不参与平均。</p>`;
  }
  function maintenance() {
    const s = G.stats(data);
    const rows = [...data.maintenanceRecords].sort((a,b)=>b.date.localeCompare(a.date));
    return header('保养记录','记录做过的项目，也记住下一次保养。',btn('设置提醒','edit-reminder')+btn('＋ 添加保养','add-maintenance','',true))+
      `<div class="split"><section class="panel"><div class="section-heading"><h2>保养明细</h2><span class="caption">累计 ${money(s.maintenanceCost)}</span></div>`+(rows.length?`<ul class="record-list">${rows.map(r=>`<li><div><h3>${esc(r.item||'保养项目待补充')}</h3><p class="caption">${dateLabel(r.date)} · ${fmt(r.mileage)} km</p><p class="caption">${esc(r.shop||'门店待填写')}</p><p>${esc(r.note)}</p><div class="table-actions"><button class="button quiet" data-action="edit-maintenance" data-id="${esc(r.id)}">编辑</button><button class="button quiet danger" data-action="delete-maintenance" data-id="${esc(r.id)}">删除</button></div></div><strong class="amount">${money(r.amount)}</strong></li>`).join('')}</ul>`:empty('还没有保养记录','保养完成后，记录项目、费用和当时里程。','add-maintenance','添加第一条记录'))+`</section><section class="panel"><h2>下次保养</h2>${reminderView(s)}<p class="caption" style="margin-top:20px">这里是你设置的计划，不代表厂家保养周期。日期与里程任一达到时，页面会提示。</p></section></div>`;
  }
  function detail(name,value) { return `<div><dt>${name}</dt><dd>${value}</dd></div>`; }
  function profile() {
    const v = data.vehicle,p = data.purchase,s = G.stats(data);
    return header('车辆档案','车辆身份和购车账本，集中存放。',btn('编辑车辆信息','edit-profile','',true)) + unverifiedNotice() +
      `<div class="split equal"><section class="panel"><div class="section-heading"><h2>车辆身份</h2><span class="tag ${v.verified?'good':''}">${v.verified?'已核对':'待核对'}</span></div><dl class="details">${detail('车型',label(v.model))}${detail('生产月份',label(v.productionMonth))}${detail('提车日期',label(v.deliveryDate))}${detail('发票型号',label(v.invoiceModel))}${detail('车架号后四位',label(v.vinSuffix))}${detail('档案里程',v.mileage==null?'待填写':fmt(v.mileage)+' km')}</dl><p class="caption" style="margin-top:16px">以上初始信息来自历史对话，请按车辆实物与购车凭证核对。</p></section>`+
      `<section class="panel"><div class="section-heading"><h2>购车账本</h2><button class="button quiet" data-action="edit-purchase">编辑账本</button></div><dl class="details">${detail('裸车价',money(p.price))}${detail('购置税',money(p.tax))}${detail('保险与上牌',money(p.insuranceAndRegistration))}${detail('购车补贴',money(p.subsidy)+(p.subsidy!=null?` <span class="tag ${p.subsidyReceived?'good':''}">${p.subsidyReceived?'已到账':'待到账'}</span>`:''))}</dl><div class="purchase-total"><span>落地合计<br><small class="muted">裸车价 + 购置税 + 保险与上牌</small></span><strong>${money(s.purchaseTotal)}</strong></div><p class="caption" style="margin-top:16px">${p.verified?'账本已核对。':'历史对话数据，待核对。'}补贴单独记录，未从落地合计中扣除。旧车出售不计入购车价格。</p></section></div>`;
  }
  function documents() {
    const local = location.protocol === 'file:';
    const folders = [['购车发票','购车合同、购车发票'],['保险','保单、保险缴费凭证'],['购置税','完税证明与缴费凭证'],['保养记录','保养单、维修清单与发票']];
    return header('资料与备份','把凭证放好，也为日常记录留一份备份。')+
      `<div class="split equal"><section class="panel"><h2>资料文件夹</h2><p class="muted">将照片、扫描件和 PDF 放入对应文件夹。</p><ul class="folder-list">${folders.map(([name,desc])=>`<li>${local?`<a href="documents/${encodeURIComponent(name)}/" target="_blank" rel="noopener">${name}<span aria-hidden="true">↗</span></a>`:`<strong>${name}</strong>`}<small>${desc}</small></li>`).join('')}</ul><p class="caption" style="margin-top:16px">${local?'如果浏览器未能打开文件夹，可在资源管理器进入项目的 documents 文件夹。':'当前是网页预览。请在电脑上打开项目中的 documents 文件夹存放资料。'}</p></section>`+
      `<section class="panel"><h2>备份与迁移</h2><p>网页新增记录保存在当前浏览器中。更换浏览器、电脑或清理浏览器数据前，请导出备份。</p><div class="actions">${btn('导出完整备份','export','',true)}${btn('导入备份','import')}</div><div class="backup-section"><h3>与 Excel 配合使用</h3><p>“导出加油表格”会生成 Excel 可打开的 CSV。现有的加油记录.xlsx 保持独立，不会自动同步或被网页改写。</p>${btn('导出加油表格','csv')}</div><div class="backup-section"><h3>恢复导入前的数据</h3><p>每次导入前，浏览器会保留上一份数据。先下载该副本，确认后再导入。</p>${btn('下载导入前副本','recovery')}</div>${corruptedStorage?`<div class="backup-section"><h3>原始存储副本</h3>${btn('下载原始存储','raw-recovery')}</div>`:''}</section></div>`;
  }
  const views = {overview,fuel,maintenance,profile,documents};
  function render() {
    const hash = location.hash.slice(1);
    page = names[hash] ? hash : 'overview';
    $('#breadcrumb').textContent = '我的车库 / ' + names[page];
    document.title = names[page] + ' · 迈腾数字车库';
    document.querySelectorAll('[data-page]').forEach(el=>{if(el.dataset.page===page) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');});
    $('#app').innerHTML = views[page]();
    updateSaveLabel();
  }
  function field(name,title,value='',type='text',attrs='') { return `<label><span>${title}</span><input name="${name}" type="${type}" value="${esc(value??'')}" ${type==='text'?'maxlength="200"':''} ${attrs}></label>`; }
  function check(name,title,value=false) { return `<label class="checkbox wide"><input type="checkbox" name="${name}" ${value?'checked':''}><span>${title}</span></label>`; }
  function note(value) { return `<label class="wide"><span>备注</span><textarea name="note" maxlength="1000">${esc(value)}</textarea></label>`; }
  function openEditor(type,id='') {
    const list = type==='fuel' ? data.fuelRecords : data.maintenanceRecords;
    const row = id ? list.find(r=>r.id===id) : {};
    if (!row) return;
    editor = {type,id};
    let fields = '', title = '';
    if (type==='fuel' || type==='maintenance') {
      title = type==='fuel' ? (id?'编辑加油记录':'记一笔加油') : (id?'编辑保养记录':'添加保养记录');
      fields = field('date','日期',id?row.date:localDate(),'date') + field('mileage','总里程（公里）',row.mileage,'number','min="0" max="1000000000" step="1" placeholder="未知可留空"');
      if (type==='fuel') {
        fields += field('amount','金额（元）',row.amount,'number','min="0" max="1000000000" step="0.01"')+field('liters','加油量（升）',row.liters,'number','min="0.001" max="1000000000" step="0.001" placeholder="未知可留空"')+field('station','加油站',row.station)+field('grade','油品标号',row.grade,'text','placeholder="按实际加油填写，如 95号"')+check('full','本次已加满（确认加满后再勾选）',row.full);
      } else {
        fields += field('item','保养项目',row.item,'text','required placeholder="例如：更换机油、机滤"')+field('shop','保养门店',row.shop)+field('amount','费用（元）',row.amount,'number','min="0" max="1000000000" step="0.01" placeholder="免费保养填 0"');
      }
      fields += note(row.note||'')+'<p class="caption wide">不确定的信息可以留空，之后通过“编辑”补充。未知升数和里程不会被当作 0。</p>';
    } else if (type==='profile') {
      const v = data.vehicle; title = '编辑车辆信息';
      fields = field('model','车型',v.model)+field('productionMonth','生产月份',v.productionMonth,'month')+field('deliveryDate','提车日期',v.deliveryDate,'date')+field('invoiceModel','发票型号',v.invoiceModel)+field('vinSuffix','车架号后四位',v.vinSuffix,'text','pattern="[A-Za-z0-9]{4}"')+field('mileage','档案里程（公里）',v.mileage,'number','min="0" max="1000000000" step="1"')+check('verified','我已按实际车辆信息核对以上内容',v.verified);
    } else if (type==='purchase') {
      const p = data.purchase; title = '编辑购车账本';
      fields = field('price','裸车价（元）',p.price,'number','min="0" max="1000000000" step="0.01"')+field('tax','购置税（元）',p.tax,'number','min="0" max="1000000000" step="0.01"')+field('insuranceAndRegistration','保险与上牌（元）',p.insuranceAndRegistration,'number','min="0" max="1000000000" step="0.01"')+field('subsidy','购车补贴（元）',p.subsidy,'number','min="0" max="1000000000" step="0.01"')+check('subsidyReceived','补贴已到账',p.subsidyReceived)+check('verified','我已按购车凭证核对以上金额',p.verified);
    } else if (type==='reminder') {
      const r = data.reminders; title = '设置保养提醒';
      fields = field('date','计划保养日期',r.date,'date')+field('mileage','计划保养里程（公里）',r.mileage,'number','min="0" max="1000000000" step="1"')+note(r.note)+'<p class="caption wide">按手册或门店确认的信息填写。日期、里程任选或同时设置；全部留空即可取消提醒。</p>';
    }
    $('#dialog-title').textContent = title; $('#form-fields').innerHTML = '<div class="form-grid">'+fields+'</div>'; $('#form-error').textContent = '';
    $('#editor').showModal();
    $('#form-fields input')?.focus();
  }
  $('#record-form').addEventListener('submit',event=>{
    event.preventDefault();
    const form = new FormData(event.target), get = name=>String(form.get(name)||'').trim(), n = name=>get(name)===''?null:Number(get(name)), b = name=>form.has(name);
    const next = G.clone(data), {type,id} = editor;
    try {
      if (type==='fuel' || type==='maintenance') {
        const collection = type==='fuel' ? 'fuelRecords' : 'maintenanceRecords';
        const row = {id:id || (globalThis.crypto?.randomUUID?.() || 'id-'+Date.now()+'-'+Math.random().toString(36).slice(2)),date:get('date'),mileage:n('mileage'),amount:n('amount'),note:get('note')};
        if (type==='fuel') { Object.assign(row,{liters:n('liters'),station:get('station'),grade:get('grade'),full:b('full')}); if (row.amount==null && row.liters==null) throw Error('请至少填写金额或加油升数。'); }
        else { Object.assign(row,{item:get('item'),shop:get('shop')}); if (!row.item) throw Error('请填写保养项目。'); }
        const index = next[collection].findIndex(r=>r.id===id);
        if (index>=0) next[collection][index] = row; else next[collection].push(row);
      } else if (type==='profile') next.vehicle = {model:get('model'),productionMonth:get('productionMonth'),deliveryDate:get('deliveryDate'),invoiceModel:get('invoiceModel'),vinSuffix:get('vinSuffix'),mileage:n('mileage'),verified:b('verified')};
      else if (type==='purchase') next.purchase = {price:n('price'),tax:n('tax'),insuranceAndRegistration:n('insuranceAndRegistration'),subsidy:n('subsidy'),subsidyReceived:b('subsidyReceived'),verified:b('verified')};
      else next.reminders = {date:get('date'),mileage:n('mileage'),note:get('note')};
      persist(next); $('#editor').close(); render(); notify(storageAvailable?'记录已保存。':'记录已更新，请导出备份保存。');
    } catch (error) { $('#form-error').textContent = error.message; }
  });
  function download(content,name,type='application/json;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([content],{type}));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(()=>URL.revokeObjectURL(url),10000);
  }
  function deleteRecord(type,id) {
    const collection = type==='fuel'?'fuelRecords':'maintenanceRecords';
    const index = data[collection].findIndex(r=>r.id===id);
    if (index<0) return;
    const removed = G.clone(data[collection][index]), next = G.clone(data);
    next[collection].splice(index,1); persist(next); render();
    notify('记录已删除。',()=>{ const restored = G.clone(data); if (!restored[collection].some(r=>r.id===id)) restored[collection].splice(Math.min(index,restored[collection].length),0,removed); persist(restored); render(); notify('已恢复记录。'); });
  }
  function exportData() { download(JSON.stringify(data,null,2),'迈腾车库备份-'+localDate()+'.json'); notify('已生成备份，请保留下载的文件。'); }
  document.addEventListener('click',event=>{
    const button = event.target.closest('[data-action]'); if (!button) return;
    const action = button.dataset.action, id = button.dataset.id;
    try {
      if (action==='add-fuel' || action==='edit-fuel') openEditor('fuel',id);
      else if (action==='add-maintenance' || action==='edit-maintenance') openEditor('maintenance',id);
      else if (action==='edit-profile') openEditor('profile');
      else if (action==='edit-purchase') openEditor('purchase');
      else if (action==='edit-reminder') openEditor('reminder');
      else if (action==='delete-fuel') deleteRecord('fuel',id);
      else if (action==='delete-maintenance') deleteRecord('maintenance',id);
      else if (action==='close-dialog') $('#editor').close();
      else if (action==='export') exportData();
      else if (action==='csv') { download(G.csv(data.fuelRecords),'加油记录-'+localDate()+'.csv','text/csv;charset=utf-8'); notify('已导出 CSV，可用 Excel 打开。'); }
      else if (action==='import') { $('#import-file').value=''; $('#import-file').click(); }
      else if (action==='cancel-import') { importData=null; $('#import-dialog').close(); }
      else if (action==='confirm-import' && importData) {
        if (stale) throw Error('另一窗口已更新车库，请刷新后再导入。');
        if (storageAvailable) {
          try { localStorage.setItem(RECOVERY,corruptedStorage ? localStorage.getItem(KEY) : JSON.stringify(data)); }
          catch { throw Error('无法保存导入前副本。请先导出当前数据并检查浏览器存储空间。'); }
        }
        persist(importData,{importing:true}); importData=null; $('#import-dialog').close(); fuelQuery=''; fuelYear=''; undoAction=null; render(); notify('备份已导入。');
      } else if (action==='recovery' || action==='raw-recovery') {
        const raw = localStorage.getItem(action==='recovery'?RECOVERY:KEY);
        if (!raw) throw Error('尚无可下载的副本。');
        download(raw,(action==='recovery'?'导入前车库副本-':'原始存储副本-')+localDate()+'.json');
      } else if (action==='dismiss') $('#message').hidden=true;
    } catch (error) { notify(error.message); }
  });
  $('#undo').addEventListener('click',()=>{ try { const undo=undoAction; undoAction=null; undo?.(); } catch(error) { notify(error.message); } });
  document.addEventListener('input',event=>{ if(event.target.id==='fuel-search') { fuelQuery=event.target.value; $('#fuel-table').innerHTML=fuelRows(); } });
  document.addEventListener('change',event=>{ if(event.target.id==='fuel-year') { fuelYear=event.target.value; $('#fuel-table').innerHTML=fuelRows(); } });
  $('#import-file').addEventListener('change',async event=>{
    const file=event.target.files[0]; if(!file)return;
    try {
      if(file.size>5*1024*1024) throw Error('备份超过 5 MB，请选择较小的车库 JSON 文件。');
      importData=G.normalize(JSON.parse((await file.text()).replace(/^\uFEFF/,'')));
      $('#import-summary').textContent = `所选文件：${file.name}。包含 ${importData.fuelRecords.length} 笔加油、${importData.maintenanceRecords.length} 笔保养。当前共有 ${data.fuelRecords.length} 笔加油、${data.maintenanceRecords.length} 笔保养。`;
      $('#import-dialog').showModal();
    } catch(error) { importData=null; notify(error instanceof SyntaxError?'文件不是有效 JSON，请选择车库导出的备份。':error.message); }
  });
  for(const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click',event=>{ if(event.target!==dialog)return; const r=dialog.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close(); });
  window.addEventListener('hashchange',()=>{render(); window.scrollTo(0,0); $('#main').focus({preventScroll:true});});
  window.addEventListener('storage',event=>{ if(event.key===KEY) { stale=true; warning('另一窗口已更新车库，请刷新本页后再编辑。'); } });
  window.addEventListener('beforeunload',event=>{if(!storageAvailable && data.updatedAt){event.preventDefault();event.returnValue='';}});
  render();
})();
