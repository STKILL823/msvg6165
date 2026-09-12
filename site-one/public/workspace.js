'use strict';

const SERVERS = ['61','62','63','64','65'];
const SHEETS = [
  ['house_exchange','Обмен дом на дом'],['car_exchange','Авто на Авто'],['pay','/pay'],
  ['unique','Уникальная'],['levels_3_4_5','Уровень 3,4,5'],['works','Работы'],
  ['marketplace','Маркетплейс'],['trades','Трейды'],['statistics','Статистика'],
];
const STATUS_LABELS = { pending:'Ожидание', violation:'Есть нарушение', clear:'Нет нарушений', help:'Требуется помощь руководства', processed:'Ранее отработано' };
let currentUser;
let currentServer = '61';
let currentSheet = SHEETS[0][0];

initialize();

async function initialize() {
  try {
    const response = await apiFetch('/api/me');
    if (!response.ok) return showFatal('Не удалось проверить доступ.');
    currentUser = await response.json();
    currentServer = currentUser.globalServerAccess ? '61' : currentUser.serverId;
    if (!currentServer) return showFatal('Для аккаунта не назначен сервер. Обратитесь к администратору.');
    document.querySelector('#account-label').textContent = `${currentUser.username} · ${roleLabel(currentUser.role)}${currentUser.serverId ? ` · сервер ${currentUser.serverId}` : ''}`;
    if (currentUser.canAdminister) document.querySelector('#admin-link').classList.remove('hidden');
    renderNavigation();
    await loadWorkspace();
  } catch (error) { if (error.message !== 'session_expired') showFatal('Сервер недоступен. Попробуйте обновить страницу.'); }
}

function renderNavigation() {
  const serverTabs = document.querySelector('#server-tabs');
  serverTabs.replaceChildren();
  const visibleServers = currentUser.globalServerAccess ? SERVERS : [currentUser.serverId];
  for (const server of visibleServers) {
    const button = document.createElement('button');
    button.type='button'; button.textContent=`Сервер ${server}`; button.classList.toggle('active',server===currentServer);
    button.addEventListener('click',async()=>{currentServer=server;renderNavigation();await loadWorkspace()});
    serverTabs.append(button);
  }
  const sheetTabs = document.querySelector('#sheet-tabs');
  sheetTabs.replaceChildren();
  for (const [key,label] of SHEETS) {
    const button=document.createElement('button');button.type='button';button.textContent=label;button.classList.toggle('active',key===currentSheet);
    button.addEventListener('click',async()=>{currentSheet=key;renderNavigation();await loadWorkspace()});sheetTabs.append(button);
  }
}

async function loadWorkspace() {
  const response = await apiFetch(`/api/workspace?server=${encodeURIComponent(currentServer)}&sheet=${encodeURIComponent(currentSheet)}`);
  if (!response.ok) return showFatal('Не удалось загрузить рабочую зону.');
  const payload=await response.json();
  document.querySelector('#sheet-title').textContent=SHEETS.find(([key])=>key===currentSheet)[1];
  document.querySelector('#scope-label').textContent=`Сервер ${payload.serverId}`;
  const statisticsView=document.querySelector('#statistics-view');
  const tableView=document.querySelector('#table-view');
  if(currentSheet==='statistics'){
    tableView.classList.add('hidden');statisticsView.classList.remove('hidden');renderStatistics(payload.statistics,payload.serverId);
  }else{
    statisticsView.classList.add('hidden');tableView.classList.remove('hidden');renderRows(payload.rows);
  }
}

function renderRows(rows) {
  document.querySelector('#row-count').textContent=`Найдено записей: ${rows.length}`;
  const head=document.querySelector('#rows-head');const body=document.querySelector('#rows-body');head.replaceChildren();body.replaceChildren();
  const dataColumns=[...new Set(rows.flatMap(row=>Object.keys(row.data||{})))];
  const labels=['Сервер','Строка',...dataColumns,'Исполнитель','Статус'];
  const header=document.createElement('tr');labels.forEach(label=>{const th=document.createElement('th');th.textContent=label;header.append(th)});head.append(header);
  if(!rows.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=dataColumns.length+4;td.className='empty';td.textContent='На этом листе пока нет загруженных строк';tr.append(td);body.append(tr);return}
  for(const row of rows){const tr=document.createElement('tr');tr.append(cell(currentServer,'','Сервер'),cell(row.rowKey,'row-key','Строка'));for(const key of dataColumns)tr.append(cell(formatValue(row.data[key]),'',key));tr.append(cell(row.assignedUsername||'Общий доступ','','Исполнитель'));const td=document.createElement('td');td.dataset.label='Статус';td.append(statusSelect(row));tr.append(td);body.append(tr)}
}

function statusSelect(row){const select=document.createElement('select');select.className=`status-select status-${row.status}`;for(const [value,label] of Object.entries(STATUS_LABELS)){const option=document.createElement('option');option.value=value;option.textContent=label;option.selected=value===row.status;select.append(option)}select.addEventListener('change',async()=>{const previous=row.status;const next=select.value;select.disabled=true;const response=await apiFetch(`/api/rows/${encodeURIComponent(row.id)}/status`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:next})}).catch(()=>null);if(!response||!response.ok){select.value=previous;flash('Не удалось сохранить статус',false)}else{row.status=next;select.className=`status-select status-${next}`;flash('Статус сохранён',true)}select.disabled=false});return select}
function renderStatistics(statistics,serverId){const stats=statistics.find(item=>item.serverId===serverId)||{};document.querySelector('#stats-server').textContent=serverId;const cards=[['Всего',stats.total,''],['Отработано',stats.completed,''],['Нарушения',stats.violation,'violation'],['Без нарушений',stats.clear,'clear'],['Требуется помощь',stats.help,'help'],['Ранее отработано',stats.processed,'processed']];const container=document.querySelector('#stats-cards');container.replaceChildren(...cards.map(([label,value,type])=>{const card=document.createElement('div');card.className=`stat-card ${type?`stat-${type}`:''}`;const span=document.createElement('span');span.textContent=label;const strong=document.createElement('strong');strong.textContent=value||0;card.append(span,strong);return card}));const percent=stats.total?Math.round(stats.completed/stats.total*100):0;document.querySelector('#stats-progress').style.width=`${percent}%`;document.querySelector('#stats-progress').title=`Отработано ${percent}%`}
function cell(value,className='',label=''){const td=document.createElement('td');td.textContent=value;td.className=className;if(label)td.dataset.label=label;return td}
function formatValue(value){if(value===null||value===undefined)return '';return typeof value==='object'?JSON.stringify(value):String(value)}
function roleLabel(role){return {user:'Пользователь',admin:'Admin',superadmin:'Superadmin',developer:'Developer'}[role]||role}
function flash(text,ok){const message=document.querySelector('#save-message');message.textContent=text;message.style.color=ok?'#267448':'#a42525';setTimeout(()=>{message.textContent=''},2500)}
function showFatal(text){document.querySelector('main').textContent=text}
async function apiFetch(url,options={}){const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);try{const response=await fetch(url,{...options,signal:controller.signal});if(response.status===401){sessionStorage.setItem('auth_notice','session_expired');location.replace('/');throw new Error('session_expired')}return response}finally{clearTimeout(timeout)}}
document.querySelector('#logout').addEventListener('click',async()=>{await fetch('/api/logout',{method:'POST'}).catch(()=>{});location.replace('/')});
