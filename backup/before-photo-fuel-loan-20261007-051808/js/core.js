(function (root) {
  'use strict';
  const num = value => typeof value === 'number' && Number.isFinite(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T12:00:00Z');
    return !isNaN(date) && date.toISOString().slice(0, 10) === value;
  }
  function normalize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![1, 2].includes(input.schemaVersion)) throw Error('请选择本车库导出的 JSON 备份（版本 1 或 2）。');
    const text = (value, max = 1000) => { if (value == null) return ''; if (typeof value !== 'string' || value.length > max) throw Error('备份中存在过长或格式错误的文字。'); return value; };
    const number = value => { if (value == null || value === '') return null; if (!num(value) || value < 0 || value > 1e9) throw Error('备份中的数值必须是有效的非负数字。'); return value; };
    const date = value => { if (value == null || value === '') return ''; if (!validDate(value)) throw Error('备份中存在无效日期，请使用 YYYY-MM-DD。'); return value; };
    const object = value => { if (value == null) return {}; if (typeof value !== 'object' || Array.isArray(value)) throw Error('备份中的档案格式不正确。'); return value; };
    const bool = value => { if (value == null) return false; if (typeof value !== 'boolean') throw Error('备份中的勾选项格式不正确。'); return value; };
    const v = object(input.vehicle), p = object(input.purchase), r = object(input.reminders);
    const month = text(v.productionMonth, 7);
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Error('生产月份格式不正确。');
    const result = {
      schemaVersion: 2,
      vehicle: {model:text(v.model,200),productionMonth:month,deliveryDate:date(v.deliveryDate),invoiceModel:text(v.invoiceModel,100),vinSuffix:text(v.vinSuffix,4),mileage:number(v.mileage),verified:bool(v.verified)},
      purchase: {price:number(p.price),tax:number(p.tax),insuranceAndRegistration:number(p.insuranceAndRegistration),subsidy:number(p.subsidy),subsidyReceived:bool(p.subsidyReceived),verified:bool(p.verified)},
      reminders:{date:date(r.date),mileage:number(r.mileage),note:text(r.note)},
      fuelRecords:[],maintenanceRecords:[],insuranceRecords:[],updatedAt:text(input.updatedAt,100) || null
    };
    for (const kind of ['fuelRecords','maintenanceRecords']) {
      const list = input[kind] ?? [];
      if (!Array.isArray(list) || list.length > 10000) throw Error('记录数量或列表格式不正确。');
      const ids = new Set();
      result[kind] = list.map((item, i) => {
        item = object(item);
        const id = text(item.id,100) || kind + '-' + i;
        if (ids.has(id)) throw Error('备份中存在重复记录编号。');
        ids.add(id);
        const record = {id,date:date(item.date),mileage:number(item.mileage),amount:number(item.amount),note:text(item.note)};
        if (kind === 'fuelRecords') {
          Object.assign(record,{station:text(item.station,200),grade:text(item.grade,30),liters:number(item.liters),full:bool(item.full)});
          if (record.liters === 0) throw Error('加油升数必须大于 0，未知时请留空。');
        } else Object.assign(record,{item:text(item.item,200),shop:text(item.shop,200)});
        return record;
      });
    }
    if (input.insuranceRecords != null && !Array.isArray(input.insuranceRecords)) throw Error('保险记录格式不正确。');
    result.insuranceRecords = clone(input.insuranceRecords || []);
    return result;
  }
  const sum = (rows, field) => rows.reduce((total,r) => total + (num(r[field]) ? r[field] : 0),0);
  function fuelEconomy(records) {
    // Unknown dates make ordering ambiguous; no fuel estimate is shown until corrected.
    if (records.some(r => !validDate(r.date))) return {value:null,km:0,liters:0,segments:0,reason:'先补齐加油日期，再按满箱法计算。'};
    const sorted = [...records].sort((a,b) => a.date.localeCompare(b.date) || (a.mileage ?? Infinity)-(b.mileage ?? Infinity));
    let base = null, previousMileage = null, pending = 0, complete = true, km = 0, liters = 0, segments = 0;
    for (const r of sorted) {
      if (base != null) {
        if (!num(r.liters) || r.liters <= 0) complete = false;
        else pending += r.liters;
        if (num(r.mileage) && previousMileage != null && r.mileage < previousMileage) complete = false;
        if (r.full) {
          if (complete && num(r.mileage) && r.mileage > base) { km += r.mileage-base; liters += pending; segments++; }
          base = num(r.mileage) ? r.mileage : null;
          pending = 0; complete = true;
        }
      } else if (r.full && num(r.mileage)) { base = r.mileage; pending = 0; complete = true; }
      if (num(r.mileage)) previousMileage = r.mileage;
    }
    return {value:km ? liters/km*100 : null,km,liters,segments,reason:segments ? `按 ${segments} 个完整满箱区间、${km.toLocaleString('zh-CN')} 公里计算` : '需两次满箱里程，且区间内每次加油升数完整。'};
  }
  function stats(data) {
    const known = [data.vehicle.mileage,...data.fuelRecords.map(r=>r.mileage),...data.maintenanceRecords.map(r=>r.mileage)].filter(num);
    const parts = [data.purchase.price,data.purchase.tax,data.purchase.insuranceAndRegistration];
    return {mileage:known.length ? Math.max(...known) : null,fuelCost:sum(data.fuelRecords,'amount'),liters:sum(data.fuelRecords,'liters'),maintenanceCost:sum(data.maintenanceRecords,'amount'),purchaseTotal:parts.every(num) ? parts.reduce((a,b)=>a+b,0) : null,economy:fuelEconomy(data.fuelRecords)};
  }
  function csv(records) {
    const escape = value => { let s = value == null ? '' : String(value); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g,'""') + '"'; };
    const rows = [['日期','总里程（公里）','加油站','油品标号','金额（元）','油量（升）','是否加满','备注'],...records.map(r=>[r.date,r.mileage,r.station,r.grade,r.amount,r.liters,r.full?'是':'否/未知',r.note])];
    return '\uFEFF' + rows.map(r=>r.map(escape).join(',')).join('\r\n');
  }
  const api = {num,clone,validDate,normalize,sum,fuelEconomy,stats,csv};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Garage = api;
})(typeof window !== 'undefined' ? window : globalThis);
