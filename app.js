/* Family Budget Tracker app logic — extracted from index.html for v2.4.1. */
/* ════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════ */
const CATS = ['Groceries / Household','Utilities & Bills','Dining Out','Kids / Childcare','Home Improvement','Entertainment','Investments','Other'];
const MO   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MOS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DEFAULT_PIN = '1234';
const APP_VERSION = '2.4.1'; // 2026-05-16 — invite acceptance fallback
const FAMILY_RECOVERY_IDS = ['fam_3g9178wnsrg2'];

/* ════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════ */
let Y, M;
let DB = {};
let RECUR = [];
let name1='Person 1', name2='Person 2';
let rOpen=true, cOpen=false, eOpen=true;

// Auth + family state
let _currentUser = null;    // Firebase user object (set after sign-in)
let _familyId    = null;    // Active family ID
let _familyMembers = [];    // [{uid, email, role, addedAt}] live from members subcollection
let _isOwner = false;       // true if _currentUser is owner of _familyId

// All Firestore reads/writes go through paths returned by this helper.
// Old paths (budget/meta, months/*, persMeta/data, personal_1/*, personal_2/*)
// remain untouched in Firestore — locked at rules level. Migration is Session 2.
function _famPath(p){
  if(!_familyId) throw new Error('No family ID set; cannot access family data');
  if(!isSafeFamilyId(_familyId)) throw new Error('Invalid family ID; cannot access family data');
  return 'families/' + _familyId + '/' + p;
}
window._famPath = _famPath;

function isSafeFamilyId(fid){
  return typeof fid === 'string' && /^fam_[a-z0-9]{12}$/.test(fid);
}
function _cachePrefix(){
  if(!_familyId) return 'bgt_';
  if(!isSafeFamilyId(_familyId)) throw new Error('Invalid family ID; cannot build cache key');
  return 'bgt_' + _familyId + '_';
}
function _cacheKey(k){ return _cachePrefix() + k; }
function _cacheSet(k,v){ try{ localStorage.setItem(_cacheKey(k),v); }catch(e){} }
function _cacheGet(k){ try{ return localStorage.getItem(_cacheKey(k)); }catch(e){ return null; } }
function _cacheRemove(k){ try{ localStorage.removeItem(_cacheKey(k)); }catch(e){} }
function _isCacheMonthKey(k){
  const p=_cachePrefix();
  return k.startsWith(p) && /^\d{4}-\d{2}$/.test(k.slice(p.length));
}
function _isCachePersonalMonthKey(k){
  const p=_cachePrefix();
  return k.startsWith(p) && /^p[12]_\d{4}-\d{2}$/.test(k.slice(p.length));
}
function cleanupLegacyCache(){
  // These pre-v2.3 keys were not family-scoped and could show stale data after switching families.
  try{
    Object.keys(localStorage).forEach(k=>{
      if(k==='bgt_meta'||k==='bgt_pers_meta'||/^bgt_(p[12]_)?\d{4}-\d{2}$/.test(k)){
        localStorage.removeItem(k);
      }
    });
  }catch(e){}
}
function clearFamilyCache(fid){
  if(!fid) return;
  const p='bgt_' + fid + '_';
  try{
    Object.keys(localStorage).forEach(k=>{ if(k.startsWith(p)) localStorage.removeItem(k); });
  }catch(e){}
}
// Track collapsed row indices across re-renders
let _collapsedRecur=new Set();
let _collapsedExp=new Set();
let _collapsedCred=new Set();
let _collapsedPRecur=new Set();
let _collapsedPExp=new Set();
let _collapsedPCred=new Set();
// 3f: Always start with all rows collapsed on fresh boot. Within-session toggles still
// persist to localStorage (so switching months and coming back preserves state), but
// the saved state is intentionally ignored on next app open via collapseAllForCurrentData().
function collapseAllForCurrentData(){
  _collapsedRecur.clear(); _collapsedExp.clear(); _collapsedCred.clear();
  _collapsedPRecur.clear(); _collapsedPExp.clear(); _collapsedPCred.clear();
  // Joint recurring templates
  for(let i=0;i<RECUR.length;i++) _collapsedRecur.add(i);
  // Joint expenses + credits for current month
  const jk = mk(Y,M);
  const jmd = DB[jk];
  if(jmd){
    const credLen = (jmd.credits||[]).length;
    for(let i=0;i<credLen;i++) _collapsedCred.add(i);
    // expenses: skip seeded recurring; only count non-recurring (matches render-time logic)
    const oneOff = (jmd.expenses||[]).filter(e => !e.recurId && !e.recurParent);
    for(let i=0;i<oneOff.length;i++) _collapsedExp.add(i);
  }
  // Personal: collapse both pages' subs + current month expenses/credits.
  // PRecur/PExp/PCred sets are shared across the two personal pages (only one open at a time).
  // Use the larger set of indices so neither page has expanded rows when first opened.
  const maxPsubs = Math.max((PSUBS['1']||[]).length, (PSUBS['2']||[]).length);
  for(let i=0;i<maxPsubs;i++) _collapsedPRecur.add(i);
  // Don't pre-populate personal expenses/credits since they're per-user-per-month and
  // we don't know which page will open first. Will populate lazily on first personal-page render.
}
function _saveCollapsed(){
  try{localStorage.setItem('bgt_collapsed',JSON.stringify({
    r:[..._collapsedRecur],e:[..._collapsedExp],c:[..._collapsedCred],
    pr:[..._collapsedPRecur],pe:[..._collapsedPExp],pc:[..._collapsedPCred]
  }));}catch(e){}
}
// PIN state
let pinEntry='';
let pinMode='unlock'; // 'unlock' | 'verify-old' | 'set-new' | 'confirm-new'
let pinNewFirst='';

/* ════════════════════════════════════════════════
   PIN LOGIC
════════════════════════════════════════════════ */
function getStoredPin(){
  let pending=null;
  try{ pending=localStorage.getItem(_pinRetryKey()); }catch(e){}
  if(pending) return pending;
  const mine=_familyMembers.find(m=>m.uid===(_currentUser&&_currentUser.uid));
  return (mine&&mine.pin)||_getLocalPin()||DEFAULT_PIN;
}
function _getLocalPin(){
  try{
    const p=localStorage.getItem('bgt_pin');
    if(!p) return null;
    const uid=localStorage.getItem('bgt_pin_uid');
    if(_currentUser&&uid&&uid!==_currentUser.uid) return null;
    return p;
  }catch(e){ return null; }
}
function _setLocalPin(p){
  try{
    localStorage.setItem('bgt_pin',p);
    if(_currentUser) localStorage.setItem('bgt_pin_uid',_currentUser.uid);
  }catch(e){}
}
function _pinRetryKey(){
  return _currentUser ? 'bgt_pin_retry_' + _currentUser.uid : 'bgt_pin_retry';
}
async function retryPinSync(){
  if(!window._fbSet||!_familyId||!_currentUser) return;
  let p=null;
  try{ p=localStorage.getItem(_pinRetryKey()); }catch(e){}
  if(!p) return;
  const ok=await window._fbSet(_famPath('members/'+_currentUser.uid),{pin:p,pinUpdatedAt:Date.now()});
  if(ok){ try{ localStorage.removeItem(_pinRetryKey()); }catch(e){} }
}
async function savePin(p){
  _setLocalPin(p);
  if(!window._fbSet||!_familyId||!_currentUser) return false;
  const ok=await window._fbSet(_famPath('members/'+_currentUser.uid),{pin:p,pinUpdatedAt:Date.now()});
  if(ok){
    try{ localStorage.removeItem(_pinRetryKey()); }catch(e){}
    return true;
  }
  try{ localStorage.setItem(_pinRetryKey(),p); }catch(e){}
  return false;
}
async function loadCurrentUserPin(metaPin){
  if(!_familyId||!_currentUser||!window._fbGet) return;
  try{
    const member=await window._fbGet(_famPath('members/'+_currentUser.uid));
    if(member&&member.pin){
      _setLocalPin(member.pin);
      return;
    }
    if(metaPin){
      _setLocalPin(metaPin);
      await savePin(metaPin);
    }
  }catch(e){ console.warn('PIN load/migration failed:', e); }
}

function pinKey(d){
  if(pinEntry.length>=4) return;
  pinEntry+=d;
  updateDots(false);
  if(pinEntry.length===4) setTimeout(()=>checkPin(),120);
}
function pinDel(){
  pinEntry=pinEntry.slice(0,-1);
  updateDots(false);
  document.getElementById('pin-err').textContent='';
}
function updateDots(err){
  for(let i=0;i<4;i++){
    const dot=document.getElementById('d'+i);
    dot.classList.toggle('filled',i<pinEntry.length);
    dot.classList.toggle('error',err);
  }
}
async function checkPin(){
  if((pinMode==='unlock'||pinMode==='verify-old') && _dataLoadPromise && !_dataLoaded){
    document.getElementById('pin-subtitle').textContent='Loading your budget…';
    try{ await _dataLoadPromise; }catch(e){ console.warn('Data load failed:', e); }
  }
  const stored=getStoredPin();
  if(pinMode==='unlock'){
    if(pinEntry===stored){
      sessionStorage.setItem('bgt_unlocked','1');
      document.getElementById('pin-screen').classList.remove('show');
      document.getElementById('app').classList.add('unlocked');
    } else {
      shakeError('Incorrect PIN');
    }
  } else if(pinMode==='verify-old'){
    if(pinEntry===stored){
      pinEntry='';
      updateDots(false);
      pinMode='set-new';
      document.getElementById('pin-subtitle').textContent='Enter a new PIN';
      document.getElementById('pin-change-hint').textContent='Choose a 4-digit PIN. Tap "Cancel" to stop.';
    } else {
      pinMode='unlock';
      document.getElementById('pin-change-hint').style.display='none';
      document.getElementById('pin-change-btn').textContent='Change PIN';
      shakeError('Incorrect current PIN');
    }
  } else if(pinMode==='set-new'){
    pinNewFirst=pinEntry;
    pinEntry='';
    updateDots(false);
    document.getElementById('pin-subtitle').textContent='Confirm new PIN';
    document.getElementById('pin-change-hint').textContent='Re-enter your new PIN to confirm.';
    pinMode='confirm-new';
  } else if(pinMode==='confirm-new'){
    if(pinEntry===pinNewFirst){
      const ok=await savePin(pinEntry);
      pinMode='unlock';
      pinEntry='';
      updateDots(false);
      document.getElementById('pin-subtitle').textContent='PIN updated! Enter it to continue.';
      document.getElementById('pin-change-hint').style.display='none';
      document.getElementById('pin-change-btn').textContent='Change PIN';
      showToast(ok?'PIN updated ✓':'PIN saved locally — sync will retry');
    } else {
      shakeError("PINs don't match — try again");
      pinMode='set-new';
      pinNewFirst='';
      document.getElementById('pin-subtitle').textContent='Enter a new PIN';
    }
  }
}
function shakeError(msg){
  updateDots(true);
  document.getElementById('pin-err').textContent=msg;
  setTimeout(()=>{ pinEntry=''; updateDots(false); },600);
}
function startChangePin(){
  if(pinMode==='verify-old'||pinMode==='set-new'||pinMode==='confirm-new'){
    // cancel
    pinMode='unlock'; pinEntry=''; pinNewFirst='';
    updateDots(false);
    document.getElementById('pin-subtitle').textContent='Enter your PIN to continue';
    document.getElementById('pin-change-hint').style.display='none';
    document.getElementById('pin-change-btn').textContent='Change PIN';
    document.getElementById('pin-err').textContent='';
    return;
  }
  pinMode='verify-old'; pinEntry='';
  updateDots(false);
  document.getElementById('pin-subtitle').textContent='Enter current PIN';
  document.getElementById('pin-change-hint').textContent='Verify your current PIN first. Tap "Cancel" to stop.';
  document.getElementById('pin-change-hint').style.display='block';
  document.getElementById('pin-change-btn').textContent='Cancel';
  document.getElementById('pin-err').textContent='';
}
function lockApp(){
  sessionStorage.removeItem('bgt_unlocked');
  document.getElementById('app').classList.remove('unlocked');
  document.getElementById('pin-screen').classList.add('show');
  pinMode='unlock'; pinEntry='';
  updateDots(false);
  document.getElementById('pin-err').textContent='';
  document.getElementById('pin-subtitle').textContent='Enter your PIN to continue';
}

/* ════════════════════════════════════════════════
   STORAGE — Firebase + localStorage cache
   Structure:
     budget/meta          → {name1,name2,recur,rOpen,cOpen,eOpen}
     months/{key}         → joint month data
     personal_{who}/{key} → personal month data
     persMeta/data        → {subs, subOpen}
     members/{uid}.pin    → per-user PIN, migrated from legacy meta.pin when present
════════════════════════════════════════════════ */

// Sync state
let _syncPending = 0;
function setSyncing(){ _syncPending++; ['sync-dot','pers-sync-dot'].forEach(id=>{const d=document.getElementById(id); if(d) d.className='sync-dot syncing';}); ['sync-label','pers-sync-label'].forEach(id=>{const l=document.getElementById(id); if(l) l.textContent='saving…';}); }
function setSynced(){ _syncPending=Math.max(0,_syncPending-1); if(_syncPending>0) return; ['sync-dot','pers-sync-dot'].forEach(id=>{const d=document.getElementById(id); if(d) d.className='sync-dot';}); ['sync-label','pers-sync-label'].forEach(id=>{const l=document.getElementById(id); if(l) l.textContent='synced';}); }
function setSyncError(){ ['sync-dot','pers-sync-dot'].forEach(id=>{const d=document.getElementById(id); if(d) d.className='sync-dot error';}); ['sync-label','pers-sync-label'].forEach(id=>{const l=document.getElementById(id); if(l) l.textContent='error';}); }

// Write helpers — write to Firebase AND localStorage cache
async function saveMeta(){
  const data={name1,name2,recur:RECUR,rOpen,cOpen,eOpen};
  // localStorage cache
  _cacheSet('meta',JSON.stringify(data));
  // Firebase
  if(window._fbSet && _familyId){ setSyncing(); const ok=await window._fbSet(_famPath('budget/meta'),data); ok?setSynced():setSyncError(); }
}
function saveNames(){ name1=document.getElementById('name1').value||'Person 1'; name2=document.getElementById('name2').value||'Person 2'; saveMeta(); }

function mk(y,m){ return `${y}-${String(m+1).padStart(2,'0')}`; }
function getMD(y,m){
  const k=mk(y,m);
  if(!DB[k]) DB[k]={expenses:[],credits:[],settled:false,seeded:false,skips:{},overrides:{}};
  if(!DB[k].credits) DB[k].credits=[];
  if(!DB[k].skips)   DB[k].skips={};
  if(!DB[k].overrides) DB[k].overrides={};
  return DB[k];
}
async function saveMD(){
  const k=mk(Y,M);
  const data=DB[k];
  // localStorage cache
  _cacheSet(k,JSON.stringify(data));
  // Firebase — serialize the entire month as a JSON string in a single field
  // This avoids any Firestore nesting/array issues
  if(window._fbSet && _familyId){
    setSyncing();
    const payload = {data: JSON.stringify(data), ts: Date.now()};
    const ok = await window._fbSet(_famPath('months/'+k), payload);
    if(ok){ setSynced(); console.log('Saved month', k, 'to Firebase'); }
    else{ setSyncError(); console.error('Failed to save month', k); }
  }
}

// Load from Firebase on init, fall back to localStorage if offline
async function loadAll(){
  // First load from localStorage cache for instant display
  try{
    const m=JSON.parse(_cacheGet('meta')||'{}');
    name1=m.name1||'Person 1'; name2=m.name2||'Person 2';
    RECUR=m.recur||[]; rOpen=m.rOpen!==false; cOpen=m.cOpen===true; eOpen=m.eOpen!==false;
    document.getElementById('name1').value=name1;
    document.getElementById('name2').value=name2;
  }catch(e){}
  for(const k in localStorage){
    if(_isCacheMonthKey(k)){
      const mk2=k.slice(_cachePrefix().length);
      try{ DB[mk2]=JSON.parse(localStorage.getItem(k)); }catch(e){}
    }
  }

  // Then fetch from Firebase and merge (Firebase is source of truth)
  if(window._fbGet && _familyId){
    try{
      const meta=await window._fbGet(_famPath('budget/meta'));
      if(meta){
        name1=meta.name1||'Person 1'; name2=meta.name2||'Person 2';
        RECUR=meta.recur||[]; rOpen=meta.rOpen!==false; cOpen=meta.cOpen===true; eOpen=meta.eOpen!==false;
        await loadCurrentUserPin(meta.pin);
        document.getElementById('name1').value=name1;
        document.getElementById('name2').value=name2;
        _cacheSet('meta',JSON.stringify({name1,name2,recur:RECUR,rOpen,cOpen,eOpen}));
      }
      // Load months via individual keys we know about
      const allMonthKeys=[...new Set([...Object.keys(DB), ...Array.from({length:24},(_,i)=>{
        const d=new Date(); d.setMonth(d.getMonth()-12+i);
        return mk(d.getFullYear(),d.getMonth());
      })])];
      await Promise.all(allMonthKeys.map(async k=>{
        const doc=await window._fbGet(_famPath('months/'+k));
        if(doc&&doc.data){ try{ DB[k]=JSON.parse(doc.data); _cacheSet(k,doc.data); }catch(e){} }
      }));
    }catch(e){ console.warn('Firebase load failed, using cache',e); }
  }
}

// Real-time listener — updates app when other device makes changes
let _listenersActive=false;
let _metaUnsub=null, _persMetaUnsub=null, _membersUnsub=null;
function startListeners(){
  if(_listenersActive||!window._fbListen||!_familyId) return;
  _listenersActive=true;

  // Listen to meta (names, RECUR templates)
  _metaUnsub=window._fbListen(_famPath('budget/meta'), data=>{
    if(!data) return;
    const prev=JSON.stringify({name1,name2,recur:RECUR});
    name1=data.name1||'Person 1'; name2=data.name2||'Person 2';
    RECUR=data.recur||[]; rOpen=data.rOpen!==false; cOpen=data.cOpen===true; eOpen=data.eOpen!==false;
    _cacheSet('meta',JSON.stringify({name1,name2,recur:RECUR,rOpen,cOpen,eOpen}));
    document.getElementById('name1').value=name1;
    document.getElementById('name2').value=name2;
    render(); showToast('↻ Synced');
  });

  // Listen to current month — re-listen when month changes
  listenCurrentMonth();

  // Listen to persMeta
  _persMetaUnsub=window._fbListen(_famPath('persMeta/data'), data=>{
    if(!data) return;
    PSUBS=data.subs||{'1':[],'2':[]};
    persSubOpen=data.subOpen||{'1':true,'2':true};
    _cacheSet('pers_meta',JSON.stringify({subs:PSUBS,subOpen:persSubOpen}));
  });

  // Listen to family members (live list)
  if(window._fbListenCollection){
    _membersUnsub=window._fbListenCollection(_famPath('members'), members=>{
      _familyMembers = members.map(m => ({uid:m.id, email:m.email, role:m.role||'member', addedAt:m.addedAt, pin:m.pin}));
      _isOwner = !!_familyMembers.find(m => m.uid === (_currentUser && _currentUser.uid) && m.role === 'owner');
      const mine=_familyMembers.find(m=>m.uid===(_currentUser&&_currentUser.uid));
      let pendingPin=null;
      try{ pendingPin=localStorage.getItem(_pinRetryKey()); }catch(e){}
      if(mine&&mine.pin&&!pendingPin) _setLocalPin(mine.pin);
      retryPinSync();
      renderFamilySection();
      // If owner, also refresh pending invites since visibility depends on ownership
      if(_isOwner) loadPendingInvites();
    });
  }
}

function stopListeners(){
  if(_metaUnsub){ _metaUnsub(); _metaUnsub=null; }
  if(_persMetaUnsub){ _persMetaUnsub(); _persMetaUnsub=null; }
  if(_monthUnsub){ _monthUnsub(); _monthUnsub=null; }
  if(_persMonthUnsub){ _persMonthUnsub(); _persMonthUnsub=null; }
  if(_membersUnsub){ _membersUnsub(); _membersUnsub=null; }
  _listenersActive=false;
}

let _monthUnsub=null;
function listenCurrentMonth(){
  if(_monthUnsub){ _monthUnsub(); _monthUnsub=null; }
  if(!window._fbListen||!_familyId) return;
  const k=mk(Y,M);
  _monthUnsub=window._fbListen(_famPath('months/'+k), data=>{
    if(!data||!data.data) return;
    try{
      const parsed=JSON.parse(data.data);
      DB[k]=parsed;
      _cacheSet(k,data.data);
      render(); // always re-render on any incoming change
    }catch(e){}
  });
}

/* ════════════════════════════════════════════════
   RECURRING SEED
════════════════════════════════════════════════ */
function seedMonth(y,m){
  const md=getMD(y,m);
  let changed=false;
  for(const t of RECUR){
    if(!t.active) continue;
    const freq=t.frequency||'monthly';

    if(freq==='monthly'||freq==='annual'||freq==='semiannual'){
      // For annual/semiannual, auto-skip in off-months (charge still shows, dimmed, excluded from totals)
      if(freq==='annual'||freq==='semiannual'){
        const anchor=t.anchorDate;
        if(anchor){
          const anchorD=new Date(anchor+'T12:00:00');
          const anchorMo=anchorD.getMonth();
          const isActive=freq==='annual'?(m===anchorMo):(m===anchorMo||m===(anchorMo+6)%12);
          if(!isActive && !md.skips[t.id]){ md.skips[t.id]=true; changed=true; }
          if(isActive && md.skips[t.id]){ delete md.skips[t.id]; changed=true; }
        }
      }
      // Clean up any leftover multi-occurrence expenses from a previous weekly/biweekly setting
      const multiLeftovers=md.expenses.filter(e=>e.recurParent===t.id);
      if(multiLeftovers.length){
        md.expenses=md.expenses.filter(e=>e.recurParent!==t.id);
        changed=true;
      }
      // Original behavior — one expense per month
      const existing=md.expenses.find(e=>e.recurId===t.id);
      if(!existing){
        md.expenses.push({
          date:chargeDate(t.chargeDay,y,m),
          desc:t.name+covStr(t,y,m),
          cat:t.cat||'Utilities & Bills',
          paidBy:t.paidBy||'1',
          amount:t.amount||'',
          recurId:t.id
        });
        const ams=t.activeMonths;
        if(ams && ams[m]===0) md.skips[t.id]=true;
        changed=true;
      } else {
        if((!existing.amount || existing.amount==='') && t.amount){
          existing.amount=t.amount; changed=true;
        }
        if(existing.paidBy!==t.paidBy && t.paidBy){
          existing.paidBy=t.paidBy; changed=true;
        }
      }
    } else {
      // Clean up any leftover monthly expense from a previous monthly setting
      const monthlyLeftover=md.expenses.findIndex(e=>e.recurId===t.id && !e.recurParent);
      if(monthlyLeftover!==-1){
        md.expenses.splice(monthlyLeftover,1);
        changed=true;
      }
      // Weekly or biweekly — compute occurrence dates in this month
      const dates=getRecurDates(t,y,m);
      dates.forEach((dt,idx)=>{
        const rid=t.id+'_'+idx;
        const existing=md.expenses.find(e=>e.recurId===rid);
        if(!existing){
          md.expenses.push({
            date:dt,
            desc:t.name+' ('+ordinal(idx+1)+')',
            cat:t.cat||'Utilities & Bills',
            paidBy:t.paidBy||'1',
            amount:t.amount||'',
            recurId:rid,
            recurParent:t.id
          });
          const ams=t.activeMonths;
          if(ams && ams[m]===0) md.skips[t.id]=true;
          changed=true;
        } else {
          if((!existing.amount || existing.amount==='') && t.amount){
            existing.amount=t.amount; changed=true;
          }
          if(existing.paidBy!==t.paidBy && t.paidBy){
            existing.paidBy=t.paidBy; changed=true;
          }
        }
      });
      // Clean up stale occurrences if anchor date changed (more seeded than expected)
      const validRids=new Set(dates.map((_,idx)=>t.id+'_'+idx));
      const stale=md.expenses.filter(e=>e.recurParent===t.id && !validRids.has(e.recurId));
      if(stale.length){
        md.expenses=md.expenses.filter(e=>!(e.recurParent===t.id && !validRids.has(e.recurId)));
        changed=true;
      }
    }
  }
  // Auto-seed credits from recurring charges with creditAmount
  if(!md.credits) md.credits=[];
  for(const t of RECUR){
    if(!t.active) continue;
    const creditId='rc_'+t.id;
    const sk=md.skips&&(md.skips[t.id]);
    if(!t.creditAmount || !t.creditTo || sk){
      // Remove auto-credit if template no longer has credit or is skipped
      const staleIdx=md.credits.findIndex(c=>c.recurCreditId===creditId);
      if(staleIdx!==-1){ md.credits.splice(staleIdx,1); changed=true; }
      continue;
    }
    const existing=md.credits.find(c=>c.recurCreditId===creditId);
    if(!existing){
      md.credits.push({
        date:chargeDate(t.chargeDay||1,y,m),
        desc:t.name+' (auto-credit)',
        to:t.creditTo,
        amount:t.creditAmount,
        payment:t.payment||'',
        recurCreditId:creditId
      });
      changed=true;
    } else {
      if(existing.amount!==t.creditAmount){ existing.amount=t.creditAmount; changed=true; }
      if(existing.to!==t.creditTo){ existing.to=t.creditTo; changed=true; }
      if((existing.payment||'')!==(t.payment||'')){ existing.payment=t.payment||''; changed=true; }
      if(existing.desc!==t.name+' (auto-credit)'){ existing.desc=t.name+' (auto-credit)'; changed=true; }
    }
  }
  md.seeded=true;
  if(changed) saveMD();
}

// Compute occurrence dates for biweekly/weekly charges in a given month
function getRecurDates(t,y,m){
  const freq=t.frequency||'monthly';
  const anchor=t.anchorDate;
  if(!anchor) return [];
  const anchorD=new Date(anchor+'T12:00:00'); // noon to avoid TZ issues
  if(isNaN(anchorD)) return [];
  const interval=freq==='weekly'?7:14;
  const monthStart=new Date(y,m,1);
  const monthEnd=new Date(y,m+1,0); // last day of month
  const dates=[];
  // Find the first occurrence on or after the anchor that falls in or before this month
  // Step forward/backward from anchor by intervals to find first occurrence in this month
  const anchorMs=anchorD.getTime();
  const startMs=monthStart.getTime();
  const endMs=monthEnd.getTime();
  const intervalMs=interval*86400000;
  // How many intervals from anchor to month start?
  let diff=startMs-anchorMs;
  let steps=Math.floor(diff/intervalMs);
  // Start checking from a couple steps before to be safe
  for(let s=Math.max(0,steps-1);s<=steps+6;s++){
    const d=new Date(anchorMs+s*intervalMs);
    if(d>=monthStart && d<=monthEnd){
      const ds=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      dates.push(ds);
    }
    if(d>monthEnd) break;
  }
  return dates;
}
function chargeDate(day,y,m){
  const d=Math.min(parseInt(day)||1,new Date(y,m+1,0).getDate());
  return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function covStr(t,y,m){
  const sd=parseInt(t.covStartDay), ed=parseInt(t.covEndDay);
  if(!sd||!ed) return '';
  const sr=t.covStartRef||'curr', er=t.covEndRef||'next';
  function refMo(ref){
    let mo=m, yr=y;
    if(ref==='prev'){ mo--; if(mo<0){mo=11;yr--;} }
    if(ref==='next'){ mo++; if(mo>11){mo=0;yr++;} }
    return {mo,yr};
  }
  const s=refMo(sr), e=refMo(er);
  const sdC=Math.min(sd,new Date(s.yr,s.mo+1,0).getDate());
  const edC=Math.min(ed,new Date(e.yr,e.mo+1,0).getDate());
  return ` (${MOS[s.mo]} ${sdC} – ${MOS[e.mo]} ${edC})`;
}

/* ════════════════════════════════════════════════
   MATH
   Joint: payer owes $0; other person owes half.
   Regular: whoever paid is responsible for the full amount.
   Credit: reduces credited person's net responsibility.
   Balance: positive = p2 owes p1; negative = p1 owes p2.
════════════════════════════════════════════════ */
function calcMonth(y,m){
  // Cards show total dollars actually paid out, after credits.
  // Balance = net1 - net2: positive means p2 owes p1, negative means p1 owes p2.
  // Joint expenses: payer paid full amount (goes into their total).
  // The non-payer owes their half, which is naturally reflected in the balance diff.
  const md=getMD(y,m);
  let paid1=0, paid2=0;

  for(const e of md.expenses){
    if(e.recurId&&(md.skips[e.recurId]||md.skips[e.recurParent])) continue;
    let a=parseFloat(e.amount)||0;
    // For recurring charges with no amount, fall back to override then template
    if(!a && e.recurId){
      const ov=md.overrides&&md.overrides[e.recurId];
      if(ov!==undefined && ov!=='') a=parseFloat(ov)||0;
      if(!a){ const t=RECUR.find(r=>r.id===e.recurId||r.id===e.recurParent); if(t) a=parseFloat(t.amount)||0; }
    }
    if(!a) continue;
    if(e.paidBy==='1') paid1+=a;
    else if(e.paidBy==='2') paid2+=a;
  }

  let cred1=0, cred2=0;
  for(const c of (md.credits||[])){
    const a=parseFloat(c.amount)||0;
    if(c.to==='1') cred1+=a;
    else if(c.to==='2') cred2+=a;
    else{ cred1+=a/2; cred2+=a/2; }
  }

  const net1=Math.max(0, paid1-cred1);
  const net2=Math.max(0, paid2-cred2);
  const balance=net1-net2; // positive = p2 owes p1

  return{paid1, paid2, total:paid1+paid2, net1, net2, balance};
}


function getCarry(y,m){
  const cur=mk(y,m);
  let carry=0;
  for(const k of Object.keys(DB).sort()){
    if(k>=cur) continue;
    const md=DB[k]; if(!md||md.settled) continue;
    const[yr,mo]=k.split('-');
    carry+=calcMonth(parseInt(yr),parseInt(mo)-1).balance;
  }
  return carry;
}
function getCarryByKey(k){
  const[yr,mo]=k.split('-');
  return getCarry(parseInt(yr),parseInt(mo)-1);
}

/* ════════════════════════════════════════════════
   RENDER
════════════════════════════════════════════════ */
function render(){
  const md=getMD(Y,M);
  // Clear expense filter
  const ef=document.getElementById('exp-filter'); if(ef) ef.value='';
  const r=calcMonth(Y,M);
  const carry=getCarry(Y,M);
  const comb=r.balance+carry;

  document.getElementById('monthLabel').textContent=`${MO[M]} ${Y}`;
  document.getElementById('lbl1').textContent=`${name1}`;
  document.getElementById('lbl2').textContent=`${name2}`;
  document.getElementById('vp1').textContent=fmt(r.net1);
  document.getElementById('vp2').textContent=fmt(r.net2);
  document.getElementById('vtotal').textContent=fmt(r.net1+r.net2);

  const abs=Math.abs(comb);
  const blbl=comb>0.005?`${name2} owes ${name1}`:comb<-0.005?`${name1} owes ${name2}`:'All Even ✓';
  document.getElementById('lblbal').textContent=blbl;
  document.getElementById('vbal').textContent=fmt(abs);

  const cb=document.getElementById('carry-badge');
  if(Math.abs(carry)>0.01){ cb.style.display='block'; cb.textContent=`incl. ${fmt(Math.abs(carry))} carryover`; }
  else cb.style.display='none';

  const bc=document.getElementById('balCard');
  const sb=document.getElementById('settle-btn');
  if(md.settled){
    bc.classList.add('settled'); sb.textContent='Mark Unsettled'; sb.className='settle-btn unmark';
    document.getElementById('settle-note').textContent='Settled ✓';
  }else{
    bc.classList.remove('settled'); sb.textContent='Mark Settled'; sb.className='settle-btn mark';
    document.getElementById('settle-note').textContent='';
  }

  renderRecur(); renderCredits(); renderExpenses(); renderCats(); renderHistory();
  document.getElementById('h1').textContent=name1;
  document.getElementById('h2').textContent=name2;

}

function moOptions(sel){ return MOS.map((m,i)=>`<option value="${i}" ${i==sel?'selected':''}>${m}</option>`).join(''); }
function paymentOptions(sel, blank='—'){
  return [blank,'Amex','Chase','Debit','ACH','Cash','Check','Other'].map((p,i)=>{
    const v=i===0?'':p;
    return `<option value="${v}" ${(!sel&&i===0)||sel===v?'selected':''}>${p}</option>`;
  }).join('');
}
function dayOptions(sel){
  let o='<option value="">Day</option>';
  for(let d=1;d<=31;d++) o+=`<option value="${d}" ${d==sel?'selected':''}>${ordinal(d)}</option>`;
  return o;
}
// Charge day can go up to 31 (clamped at seeding time to actual month days)
function chargeDayOptions(sel){
  let o='<option value="">Charge Day</option>';
  for(let d=1;d<=31;d++) o+=`<option value="${d}" ${d==sel?'selected':''}>${ordinal(d)}</option>`;
  return o;
}

function renderRecur(){
  const md=getMD(Y,M);
  const tbody=document.getElementById('r-tbody');
  tbody.innerHTML='';
  let cnt=0,tot=0;
  for(const idx of _collapsedRecur){ if(idx>=RECUR.length) _collapsedRecur.delete(idx); }
  RECUR.forEach((t,i)=>{
    const sk=!!(md.skips&&md.skips[t.id]);
    const freq=t.frequency||'monthly';
    const ov=md.overrides&&md.overrides[t.id]!==undefined?md.overrides[t.id]:'';
    const disp=ov!==''?ov:t.amount;
    if(t.active&&!sk){
      cnt++;
      if(freq==='weekly'||freq==='biweekly'){
        const occN=getRecurDates(t,Y,M).length;
        tot+=(parseFloat(disp)||0)*occN;
      } else {
        // monthly, annual, semiannual — 1 occurrence (annual/semiannual only seeded if active this month)
        tot+=parseFloat(disp)||0;
      }
    }
    const collapsed=_collapsedRecur.has(i);
    const covLabel=buildCovLabel(t);
    const occ=freq==='weekly'||freq==='biweekly'?getRecurDates(t,Y,M).length:(freq==='annual'||freq==='semiannual'?1:1);
    const moTotal=(parseFloat(disp)||0)*occ;
    const rowClass=!t.active?'ri':sk?'rskip':'';

    // Summary row
    const sr=document.createElement('tr');
    sr.className='rsummary-row'+(rowClass?' '+rowClass:'');
    sr.innerHTML=`<td colspan="7"><div style="display:flex;align-items:center;gap:4px;">
      <div class="reorder-arrows">
        <button class="reorder-btn" onclick="reorderRecur(${i},-1)" ${i===0?'disabled style="visibility:hidden"':''} title="Move up">▲</button>
        <button class="reorder-btn" onclick="reorderRecur(${i},1)" ${i===RECUR.length-1?'disabled style="visibility:hidden"':''} title="Move down">▼</button>
      </div>
      <button class="rexp-toggle" onclick="toggleRowCollapse('recur',${i},this)">${collapsed?'▶':'▼'}</button>
      <span contenteditable="true" class="rname-edit" data-placeholder="Enter charge name…" onblur="const _n=this.textContent.trim();setTimeout(()=>updRecur(${i},'name',_n),150)">${esc(t.name||'')}</span>
      ${t.notes?'<span class="ec-note" style="color:var(--rv);">'+esc(t.notes)+'</span>':''}
      <span class="rsum">${fmt(moTotal)}${freq==='weekly'||freq==='biweekly'?' ('+occ+'×)':freq==='annual'?' (annual)':freq==='semiannual'?' (every 6 mo)':''}</span>
      <button class="del-btn" onclick="confirmDel(this,()=>delRecur(${i}))" style="margin-left:4px;" title="Delete">✕</button>
    </div></td>`;
    tbody.appendChild(sr);

    // Detail row
    const dr=document.createElement('tr');
    dr.className='rdetail-row'+(collapsed?' r-hidden':'')+(rowClass?' '+rowClass:'');
    dr.innerHTML=`
      <td colspan="7" class="recur-detail-cell">
        <div class="recur-detail-panel">
          <div class="recur-detail-group">
            <div class="recur-field">
              <label>Paid By</label>
              <select onchange="updRecurImm(${i},'paidBy',this.value)">
                <option value="1" ${t.paidBy==='1'?'selected':''}>${name1}</option>
                <option value="2" ${t.paidBy==='2'?'selected':''}>${name2}</option>
              </select>
            </div>
            <div class="recur-field">
              <label>Category</label>
              <select onchange="updRecurImm(${i},'cat',this.value)">
                ${CATS.map(c=>`<option value="${c}" ${(t.cat||'Utilities & Bills')===c?'selected':''}>${c}</option>`).join('')}
              </select>
            </div>
            <div class="recur-field">
              <label>Payment Type</label>
              <select onchange="updRecurImm(${i},'payment',this.value)">${paymentOptions(t.payment)}</select>
            </div>
          </div>
          <div class="recur-detail-group">
            <div class="recur-field rnum">
              <label>Usual Cost</label>
              <input type="number" value="${esc(t.amount||'')}" placeholder="$0.00" min="0" step="0.01" onchange="updRecurImm(${i},'amount',this.value)">
            </div>
            <div class="recur-field rnum">
              <label>Override Cost</label>
              <div class="ov-wrap">
                <input type="number" value="${esc(String(ov))}" placeholder="$0.00" min="0" step="0.01" title="Actual cost for ${MO[M]} only — leave blank if same as usual" onchange="setOv('${esc(t.id)}',this.value)">
                ${ov!==''?`<button class="ov-reset" onclick="clearOv('${esc(t.id)}')" title="Reset to usual cost">✕</button>`:''}
              </div>
            </div>
            ${(freq==='weekly'||freq==='biweekly')&&(parseFloat(disp)||0)?'<div class="recur-subtle" style="font-family:DM Mono,monospace;color:var(--rv);">'+getRecurDates(t,Y,M).length+'× = '+fmt((parseFloat(disp)||0)*getRecurDates(t,Y,M).length)+'/mo</div>':''}
            <div class="recur-field credit">
              <label>Auto-Credit</label>
              <div class="recur-inline">
                <input type="number" value="${t.creditAmount||''}" placeholder="$0.00" min="0" step="0.01" style="font-family:'DM Mono',monospace;" onchange="updRecurImm(${i},'creditAmount',this.value)">
                <select onchange="updRecurImm(${i},'creditTo',this.value)">
                  <option value="" ${!t.creditTo?'selected':''}>Credit To…</option>
                  <option value="1" ${t.creditTo==='1'?'selected':''}>${name1}</option>
                  <option value="2" ${t.creditTo==='2'?'selected':''}>${name2}</option>
                  <option value="shared" ${t.creditTo==='shared'?'selected':''}>Shared</option>
                </select>
              </div>
              <div class="recur-subtle">Uses this charge's payment type for generated credits.</div>
            </div>
          </div>
          <div class="recur-detail-group">
            <div class="recur-field">
              <label>Frequency</label>
              <select onchange="updRecurImm(${i},'frequency',this.value)">
                <option value="monthly" ${(t.frequency||'monthly')==='monthly'?'selected':''}>Monthly</option>
                <option value="biweekly" ${t.frequency==='biweekly'?'selected':''}>Bi-weekly</option>
                <option value="weekly" ${t.frequency==='weekly'?'selected':''}>Weekly</option>
                <option value="semiannual" ${t.frequency==='semiannual'?'selected':''}>Every 6 Months</option>
                <option value="annual" ${t.frequency==='annual'?'selected':''}>Annual</option>
              </select>
            </div>
            ${(t.frequency||'monthly')==='monthly'?`<div class="recur-field">
              <label>Charge Day</label>
              <select onchange="updRecurImm(${i},'chargeDay',this.value)">${chargeDayOptions(t.chargeDay)}</select>
            </div>`:`<div class="recur-field">
              <label>Anchor Date</label>
              <input type="date" value="${t.anchorDate||''}" onblur="updRecurImm(${i},'anchorDate',this.value)" title="First occurrence — all future dates calculated from this">
              ${getRecurDates(t,Y,M).length?'<div class="recur-subtle">'+getRecurDates(t,Y,M).length+'× this month</div>':''}
            </div>`}
            <div class="recur-field">
              <label>Days Covered</label>
              <div class="recur-inline">
                <span class="recur-inline-label">From</span>
                <select onchange="updRecurImm(${i},'covStartRef',this.value)">
                  <option value="prev" ${(t.covStartRef||'curr')==='prev'?'selected':''}>Previous Month</option>
                  <option value="curr" ${(t.covStartRef||'curr')==='curr'?'selected':''}>This Month</option>
                  <option value="next" ${(t.covStartRef||'curr')==='next'?'selected':''}>Next Month</option>
                </select>
                <select onchange="updRecurImm(${i},'covStartDay',this.value)">${dayOptions(t.covStartDay)}</select>
              </div>
              <div class="recur-inline">
                <span class="recur-inline-label">To</span>
                <select onchange="updRecurImm(${i},'covEndRef',this.value)">
                  <option value="prev" ${(t.covEndRef||'next')==='prev'?'selected':''}>Previous Month</option>
                  <option value="curr" ${(t.covEndRef||'next')==='curr'?'selected':''}>This Month</option>
                  <option value="next" ${(t.covEndRef||'next')==='next'?'selected':''}>Next Month</option>
                </select>
                <select onchange="updRecurImm(${i},'covEndDay',this.value)">${dayOptions(t.covEndDay)}</select>
              </div>
              ${covLabel?`<div class="recur-subtle">${covLabel}</div>`:''}
            </div>
          </div>
          <div class="recur-detail-group">
            <div class="recur-field">
              <label>Months Active</label>
              <div class="recur-months">
                ${(t.activeMonths||[1,1,1,1,1,1,1,1,1,1,1,1]).map((on,mi)=>`<button type="button" class="mo-btn ${on?'on':''} ${mi===M?'curr-mo':''}" onclick="toggleActiveMo('${esc(t.id)}',${i},${mi})" title="${MO[mi]}">${MOS[mi][0]}</button>`).join('')}
              </div>
            </div>
            <div class="recur-field">
              <label>Notes</label>
              <input class="recur-note-input" type="text" value="${esc(t.notes||'')}" placeholder="Optional note…" onchange="updRecurImm(${i},'notes',this.value)">
            </div>
          </div>
        </div>
      </td>`;
    tbody.appendChild(dr);
  });
  document.getElementById('r-count').textContent=cnt;
  document.getElementById('r-total').textContent=`${fmt(tot)}/mo`;
  setZone('r',rOpen);
}

function buildCovLabel(t, viewM, viewY){
  const sd=parseInt(t.covStartDay), ed=parseInt(t.covEndDay);
  if(!sd||!ed) return '';
  const cm=viewM!==undefined?viewM:M, cy=viewY!==undefined?viewY:Y;
  const sr=t.covStartRef||'curr', er=t.covEndRef||'next';
  function refMo(ref){
    let mo=cm, yr=cy;
    if(ref==='prev'){ mo--; if(mo<0){mo=11;yr--;} }
    if(ref==='next'){ mo++; if(mo>11){mo=0;yr++;} }
    return {mo,yr};
  }
  const s=refMo(sr), e=refMo(er);
  const sdClamped=Math.min(sd,new Date(s.yr,s.mo+1,0).getDate());
  const edClamped=Math.min(ed,new Date(e.yr,e.mo+1,0).getDate());
  return `${MOS[s.mo]} ${sdClamped} – ${MOS[e.mo]} ${edClamped}`;
}

function renderCredits(){
  const md=getMD(Y,M);
  const tbody=document.getElementById('c-tbody');
  const empty=document.getElementById('c-empty');
  tbody.innerHTML='';
  let tot=0;
  const credLen=(md.credits||[]).length;
  for(const idx of _collapsedCred){ if(idx>=credLen) _collapsedCred.delete(idx); }
  (md.credits||[]).forEach((c,i)=>{
    tot+=parseFloat(c.amount)||0;
    const collapsed=_collapsedCred.has(i);
    const isAuto=!!c.recurCreditId;

    // Summary row
    const sr=document.createElement('tr');
    sr.className='ec-summary-row';
    sr.innerHTML=`<td colspan="7"><div style="display:flex;align-items:center;gap:4px;">
      <div class="reorder-arrows">
        <button class="reorder-btn" onclick="reorderCredit(${i},-1)" ${i===0?'disabled style="visibility:hidden"':''} title="Move up">▲</button>
        <button class="reorder-btn" onclick="reorderCredit(${i},1)" ${i===(md.credits||[]).length-1?'disabled style="visibility:hidden"':''} title="Move down">▼</button>
      </div>
      <button class="ec-toggle" onclick="toggleRowCollapse('cred',${i},this)">${collapsed?'▶':'▼'}</button>
      ${isAuto?'<span style="font-size:.55rem;font-weight:700;color:var(--cv);background:var(--cbg);border:1px solid var(--cb);border-radius:4px;padding:1px 5px;">AUTO</span>':''}
      <span contenteditable="true" class="ec-name-edit" data-placeholder="Enter credit description…" onblur="const _d=this.textContent.trim();setTimeout(()=>updCredit(${i},'desc',_d),150)">${esc(c.desc||'')}</span>
      <span style="font-family:'DM Mono',monospace;font-size:.82rem;color:var(--cv);margin-left:auto;">${fmt(parseFloat(c.amount)||0)}</span>
      ${c.notes?'<span class="ec-note">'+esc(c.notes)+'</span>':''}
      ${isAuto?'':'<button class="cdel-btn" onclick="confirmDel(this,()=>delCredit('+i+'))" style="margin-left:4px;">✕</button>'}
    </div></td>`;
    tbody.appendChild(sr);

    // Detail row
    const dr=document.createElement('tr');
    dr.className='ec-detail-row'+(collapsed?' ec-hidden':'');
    dr.setAttribute('data-ec-idx',i);
    dr.innerHTML=`
      <td><input type="date" value="${c.date||''}" onchange="updCredit(${i},'date',this.value)"></td>
      <td><input type="text" value="${esc(c.desc||'')}" placeholder="e.g. Tax refund" onchange="updCredit(${i},'desc',this.value)"></td>
      <td><select onchange="updCredit(${i},'to',this.value)">
        <option value="1" ${c.to==='1'?'selected':''}>${name1}</option>
        <option value="2" ${c.to==='2'?'selected':''}>${name2}</option>
        <option value="shared" ${c.to==='shared'?'selected':''}>Shared (split)</option>
      </select></td>
      <td><select onchange="updCredit(${i},'payment',this.value)">
        <option value="" ${!c.payment?'selected':''}>Payment Type</option>
        <option value="Amex" ${c.payment==='Amex'?'selected':''}>Amex</option>
        <option value="Chase" ${c.payment==='Chase'?'selected':''}>Chase</option>
        <option value="Debit" ${c.payment==='Debit'?'selected':''}>Debit</option>
        <option value="ACH" ${c.payment==='ACH'?'selected':''}>ACH</option>
        <option value="Cash" ${c.payment==='Cash'?'selected':''}>Cash</option>
        <option value="Check" ${c.payment==='Check'?'selected':''}>Check</option>
        <option value="Other" ${c.payment==='Other'?'selected':''}>Other</option>
      </select></td>
      <td class="cnum"><input type="number" value="${c.amount||''}" placeholder="0.00" min="0" step="0.01" onchange="updCredit(${i},'amount',this.value)"></td>
      <td><input type="text" value="${esc(c.notes||'')}" placeholder="Optional note…" onchange="updCredit(${i},'notes',this.value)" style="min-width:100px"></td>`;
    tbody.appendChild(dr);
  });
  const cnt=(md.credits||[]).length;
  document.getElementById('c-count').textContent=cnt;
  document.getElementById('c-total').textContent=fmt(tot);
  empty.style.display=cnt===0?'block':'none';
  setZone('c',cOpen);
}

function renderExpenses(){
  const md=getMD(Y,M);
  const tbody=document.getElementById('e-tbody');
  const empty=document.getElementById('e-empty');
  tbody.innerHTML='';
  const oneOff=md.expenses.filter(e=>!e.recurId);
  // Prune stale collapsed indices
  for(const idx of _collapsedExp){ if(idx>=oneOff.length) _collapsedExp.delete(idx); }
  empty.style.display=oneOff.length===0?'block':'none';
  const oneOffTotal=oneOff.reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  const ootEl=document.getElementById('other-total-tag');
  if(ootEl) ootEl.textContent=fmt(oneOffTotal);
  const ecEl=document.getElementById('e-count');
  if(ecEl) ecEl.textContent=oneOff.length;
  let expIdx=0;
  md.expenses.forEach((e,i)=>{
    if(e.recurId) return;
    const collapsed=_collapsedExp.has(expIdx);
    const eidx=expIdx;

    // Summary row — always visible
    const sr=document.createElement('tr');
    sr.className='ec-summary-row';
    sr.innerHTML=`<td colspan="8"><div style="display:flex;align-items:center;gap:4px;">
      <div class="reorder-arrows">
        <button class="reorder-btn" onclick="reorderExp(${i},-1)" ${eidx===0?'disabled style="visibility:hidden"':''} title="Move up">▲</button>
        <button class="reorder-btn" onclick="reorderExp(${i},1)" ${eidx===oneOff.length-1?'disabled style="visibility:hidden"':''} title="Move down">▼</button>
      </div>
      <button class="ec-toggle" onclick="toggleRowCollapse('exp',${eidx},this)">${collapsed?'▶':'▼'}</button>
      <span contenteditable="true" class="ec-name-edit" data-placeholder="Enter expense description…" onblur="const _d=this.textContent.trim();setTimeout(()=>updExp(${i},'desc',_d),150)">${esc(e.desc||'')}</span>
      <span style="font-family:'DM Mono',monospace;font-size:.82rem;color:var(--slate);margin-left:auto;">${fmt(parseFloat(e.amount)||0)}</span>
      ${e.notes?'<span class="ec-note">'+esc(e.notes)+'</span>':''}
      <button class="del-btn" onclick="confirmDel(this,()=>delExp(${i}))" style="margin-left:4px;">✕</button>
    </div></td>`;
    tbody.appendChild(sr);

    // Detail row — hidden when collapsed
    const dr=document.createElement('tr');
    dr.className='ec-detail-row'+(collapsed?' ec-hidden':'');
    dr.setAttribute('data-ec-idx',eidx);
    dr.innerHTML=`
      <td><input type="date" value="${e.date||''}" onchange="updExp(${i},'date',this.value)"></td>
      <td><input type="text" value="${esc(e.desc||'')}" placeholder="Description" onchange="updExp(${i},'desc',this.value)"></td>
      <td><select onchange="updExp(${i},'cat',this.value)">
        ${CATS.map(c=>`<option value="${c}" ${e.cat===c?'selected':''}>${c}</option>`).join('')}
      </select></td>
      <td><select onchange="updExpPaid(${i},this.value)">
        <option value="p1" ${e.paidBy==='1'?'selected':''}>${name1}</option>
        <option value="p2" ${e.paidBy==='2'?'selected':''}>${name2}</option>
      </select></td>
      <td><select onchange="updExp(${i},'payment',this.value)">
        <option value="" ${!e.payment?'selected':''}>Payment Type</option>
        <option value="Amex" ${e.payment==='Amex'?'selected':''}>Amex</option>
        <option value="Chase" ${e.payment==='Chase'?'selected':''}>Chase</option>
        <option value="Debit" ${e.payment==='Debit'?'selected':''}>Debit</option>
        <option value="ACH" ${e.payment==='ACH'?'selected':''}>ACH</option>
        <option value="Cash" ${e.payment==='Cash'?'selected':''}>Cash</option>
        <option value="Check" ${e.payment==='Check'?'selected':''}>Check</option>
        <option value="Other" ${e.payment==='Other'?'selected':''}>Other</option>
      </select></td>
      <td class="anum"><input type="number" value="${e.amount||''}" placeholder="0.00" min="0" step="0.01" onchange="updExp(${i},'amount',this.value)"></td>
      <td><input type="text" value="${esc(e.notes||'')}" placeholder="Optional note…" onchange="updExp(${i},'notes',this.value)" style="min-width:100px"></td>`;
    tbody.appendChild(dr);
    expIdx++;
  });
  setZone('e',eOpen);
}

function renderCats(){
  const md=getMD(Y,M);
  // Current month totals
  const tots={}; CATS.forEach(c=>tots[c]=0);
  for(const e of md.expenses){
    if(e.recurId&&(md.skips[e.recurId]||md.skips[e.recurParent])) continue;
    let a=parseFloat(e.amount)||0;
    if(!a && e.recurId){
      const ov=md.overrides&&md.overrides[e.recurId];
      if(ov!==undefined && ov!=='') a=parseFloat(ov)||0;
      if(!a){ const t=RECUR.find(r=>r.id===e.recurId||r.id===e.recurParent); if(t) a=parseFloat(t.amount)||0; }
    }
    tots[CATS.includes(e.cat)?e.cat:'Other']+=a;
  }

  // Build 4-month history per category (current + 3 prior) for sparklines
  const sparkMonths=[];
  for(let i=3;i>=0;i--){
    let sm=M-i, sy=Y;
    while(sm<0){sm+=12;sy--;}
    sparkMonths.push({y:sy,m:sm,k:mk(sy,sm)});
  }
  const sparkData={};
  CATS.forEach(c=>sparkData[c]=[]);
  sparkMonths.forEach(({y,m,k})=>{
    const smd=DB[k];
    const catTots={}; CATS.forEach(c=>catTots[c]=0);
    if(smd){
      for(const e of (smd.expenses||[])){
        if(e.recurId&&smd.skips&&(smd.skips[e.recurId]||smd.skips[e.recurParent])) continue;
        let a=parseFloat(e.amount)||0;
        if(!a && e.recurId){
          const ov=smd.overrides&&smd.overrides[e.recurId];
          if(ov!==undefined && ov!=='') a=parseFloat(ov)||0;
          if(!a){ const t=RECUR.find(r=>r.id===e.recurId||r.id===e.recurParent); if(t) a=parseFloat(t.amount)||0; }
        }
        catTots[CATS.includes(e.cat)?e.cat:'Other']+=a;
      }
    }
    CATS.forEach(c=>sparkData[c].push(catTots[c]));
  });

  function miniSpark(vals){
    const max=Math.max(...vals,1);
    const w=60, h=20, pad=2;
    const step=(w-pad*2)/(vals.length-1);
    const pts=vals.map((v,i)=>`${pad+i*step},${h-pad-(v/max)*(h-pad*2)}`);
    if(vals.every(v=>v===0)) return `<svg width="${w}" height="${h}" style="opacity:.25"><line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="var(--border)" stroke-width="1"/></svg>`;
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts.join(' ')}" fill="none" stroke="var(--rv)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${pts[pts.length-1].split(',')[0]}" cy="${pts[pts.length-1].split(',')[1]}" r="2" fill="var(--rv)"/></svg>`;
  }

  const sparkLabels=sparkMonths.map(s=>MOS[s.m]).join(' → ');
  document.getElementById('cat-grid').innerHTML=CATS.map(c=>`
    <div class="cat-tile">
      <div class="cat-name">${c}</div>
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:6px;">
        <div class="cat-amt">${fmt(tots[c])}</div>
        <div title="${sparkLabels}">${miniSpark(sparkData[c])}</div>
      </div>
    </div>`).join('');
}

function renderHistory(){
  const tbody=document.getElementById('h-tbody');
  // Build list of 12 months: current viewed month and 11 preceding
  const months=[];
  for(let i=0;i<12;i++){
    let ym=M-i, yy=Y;
    while(ym<0){ym+=12;yy--;}
    months.push(mk(yy,ym));
  }
  // Filter to only months that have data
  const keys=months.filter(k=>DB[k]);
  if(!keys.length){
    tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--slate);padding:14px;font-family:DM Sans;font-size:.85rem">No history yet.</td></tr>';
    return;
  }
  tbody.innerHTML=keys.map(k=>{
    const md=DB[k]; if(!md) return '';
    const[yr,mo]=k.split('-');
    const r=calcMonth(parseInt(yr),parseInt(mo)-1);
    const carry=getCarryByKey(k);
    const comb=r.balance+carry;
    const abs=Math.abs(comb);
    const owes=comb>0.005?`${name2} owes ${fmt(abs)}`:comb<-0.005?`${name1} owes ${fmt(abs)}`:'Even';
    return`<tr>
      <td style="font-family:DM Sans">${MO[parseInt(mo)-1]} ${yr}</td>
      <td>${fmt(r.net1)}</td><td>${fmt(r.net2)}</td>
      <td>${owes}</td>
      <td>${Math.abs(carry)<0.01?'—':fmt(Math.abs(carry))}</td>
      <td><span class="spill ${md.settled?'s-yes':'s-no'}">${md.settled?'Settled':'Open'}</span></td>
    </tr>`;
  }).join('');
}

/* ════════════════════════════════════════════════
   ZONE COLLAPSE
════════════════════════════════════════════════ */
function setZone(z,open){
  document.getElementById(z+'-body').classList.toggle('open',open);
  document.getElementById(z+'-chev').classList.toggle('open',open);
}
function toggleZone(z){
  if(z==='r'){ rOpen=!rOpen; saveMeta(); setZone('r',rOpen); }
  else if(z==='e'){ eOpen=!eOpen; saveMeta(); setZone('e',eOpen); }
  else{ cOpen=!cOpen; saveMeta(); setZone('c',cOpen); }
}

// Scroll to last row in a tbody after a short delay (lets DOM update)
function scrollToLastRow(tbodyId, container){
  setTimeout(()=>{
    const tbody=document.getElementById(tbodyId);
    if(!tbody) return;
    // Find the last summary row (the new item) and scroll to it
    const summaries=tbody.querySelectorAll('.rsummary-row,.ec-summary-row');
    const last=summaries.length?summaries[summaries.length-1]:tbody.lastElementChild;
    if(last){
      last.scrollIntoView({behavior:'smooth',block:'center'});
      // Flash highlight so the user sees it
      last.style.background='rgba(107,79,187,.08)';
      setTimeout(()=>{last.style.background='';},1500);
    }
  },100);
}
function focusLastInlineName(tbodyId){
  setTimeout(()=>{
    const tbody=document.getElementById(tbodyId);
    if(!tbody) return;
    const names=tbody.querySelectorAll('.ec-name-edit,.rname-edit');
    const el=names[names.length-1];
    if(!el) return;
    try{
      el.focus();
      const range=document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel=window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }catch(e){}
  },140);
}

// Header "+ Add" wrappers — open zone if collapsed, add item, scroll to it
function hdrAddRecur(){
  if(!rOpen){ rOpen=true; saveMeta(); setZone('r',true); }
  addRecur();
  scrollToLastRow('r-tbody');
}
function hdrAddExp(){
  if(!eOpen){ eOpen=true; saveMeta(); setZone('e',true); }
  addExp();
  scrollToLastRow('e-tbody');
}
function hdrAddCredit(){
  if(!cOpen){ cOpen=true; saveMeta(); setZone('c',true); }
  addCredit();
  scrollToLastRow('c-tbody');
}
function hdrAddPersSub(){
  if(!persSubOpen[persWho]){ persSubOpen[persWho]=true; savePMeta(); }
  addPersSub();
  scrollToLastRow('ps-sub-tbody', document.getElementById('pers-overlay'));
}
function hdrAddPersExp(){
  if(!persExpOpen[persWho]){ persExpOpen[persWho]=true; }
  addPersExp();
  scrollToLastRow('ps-exp-tbody', document.getElementById('pers-overlay'));
}
function hdrAddPersCredit(){
  if(!persCreditOpen[persWho]){ persCreditOpen[persWho]=true; }
  addPersCredit();
  scrollToLastRow('ps-c-tbody', document.getElementById('pers-overlay'));
}

/* ════════════════════════════════════════════════
   ACTIONS
════════════════════════════════════════════════ */
function addRecur(){
  const t={id:'r'+Date.now(),name:'',paidBy:'1',amount:'',chargeDay:'',
    frequency:'monthly',anchorDate:'',creditAmount:'',creditTo:'',
    covStartRef:'curr',covStartDay:'',covEndRef:'next',covEndDay:'',
    activeMonths:[1,1,1,1,1,1,1,1,1,1,1,1],active:true};
  RECUR.push(t);
  saveMeta();
  // Reset seeded flag so seedMonth re-runs and picks up the new template cleanly.
  // Avoids double-entry that occurred when manually pushing + Firebase listener firing.
  const md=getMD(Y,M);
  md.seeded=false;
  seedMonth(Y,M);
  render();
}
// updRecurImm: re-renders table (safe for selects/checkbox where focus doesn't matter)
function updRecurImm(i,f,v){
  RECUR[i][f]=v; saveMeta();
  // If frequency or anchorDate changed, re-seed the month
  if(f==='frequency'||f==='anchorDate'){
    // Auto-set activeMonths for annual/semiannual based on anchor date
    const t=RECUR[i];
    const fr=t.frequency||'monthly';
    if((fr==='annual'||fr==='semiannual')&&t.anchorDate){
      const anchorMo=new Date(t.anchorDate+'T12:00:00').getMonth();
      if(!isNaN(anchorMo)){
        const ams=[0,0,0,0,0,0,0,0,0,0,0,0];
        ams[anchorMo]=1;
        if(fr==='semiannual') ams[(anchorMo+6)%12]=1;
        RECUR[i].activeMonths=ams;
        saveMeta();
      }
    } else if(fr==='monthly'||fr==='weekly'||fr==='biweekly'){
      // Reset to all months active when switching back
      if(RECUR[i].activeMonths&&RECUR[i].activeMonths.filter(v=>v).length<=2){
        RECUR[i].activeMonths=[1,1,1,1,1,1,1,1,1,1,1,1];
        saveMeta();
      }
    }
    const md=getMD(Y,M);
    md.seeded=false;
    seedMonth(Y,M);
    render();
    return;
  }
  // Sync seeded expense(s) and auto-credits in the current month for fields that affect generated rows.
  if(f==='amount'||f==='paidBy'||f==='name'||f==='cat'||f==='payment'||f==='creditAmount'||f==='creditTo'){
    const md=getMD(Y,M);
    const tid=RECUR[i].id;
    for(const e of md.expenses){
      // Match both direct recurId and recurParent (for weekly/biweekly)
      if(e.recurId===tid || e.recurParent===tid){
        if(f==='amount') e.amount=v;
        if(f==='paidBy') e.paidBy=v;
        if(f==='cat') e.cat=v;
        if(f==='name'){
          if(e.recurParent===tid){
            // Multi-occurrence: keep the ordinal suffix
            const idx=parseInt((e.recurId||'').split('_').pop())||0;
            e.desc=v+' ('+ordinal(idx+1)+')';
          } else {
            e.desc=v+covStr(RECUR[i],Y,M);
          }
        }
      }
    }
    seedMonth(Y,M);
    saveMD();
  }
  renderRecur(); partialSummary();
}
// updRecur: saves only, no re-render — preserves focus while typing in text/number fields
function updRecur(i,f,v){ RECUR[i][f]=v; saveMeta(); partialSummary(); }
function delRecur(i){
  const tid=RECUR[i].id;
  RECUR.splice(i,1);
  saveMeta();
  const md = getMD(Y,M);
  md.expenses = md.expenses.filter(e => e.recurId !== tid && e.recurParent !== tid);
  // Also remove auto-credits for this charge
  if(md.credits) md.credits = md.credits.filter(c => c.recurCreditId !== 'rc_'+tid);
  saveMD();
  render();
}
function confirmDel(btn,fn){
  if(btn.dataset.armed==='true'){
    try{ fn(); }catch(e){ console.error('Delete failed:',e); }
    return;
  }
  document.querySelectorAll('[data-armed="true"]').forEach(b=>{b.dataset.armed='';b.textContent=b.dataset.origText||'✕';b.style.color='';b.style.borderColor='';b.style.background='';});
  btn.dataset.armed='true';
  btn.dataset.origText=btn.textContent;
  btn.textContent='Sure?';
  btn.style.color='var(--rust)';btn.style.borderColor='var(--rust)';btn.style.background='#FEF0EB';
  setTimeout(()=>{if(btn.dataset.armed==='true'){btn.dataset.armed='';btn.textContent=btn.dataset.origText||'✕';btn.style.color='';btn.style.borderColor='';btn.style.background='';}},3000);
}

function toggleActiveMo(id,i,mi){
  const ams=(RECUR[i].activeMonths||[1,1,1,1,1,1,1,1,1,1,1,1]).slice();
  ams[mi] = ams[mi] ? 0 : 1;
  RECUR[i].activeMonths=ams;
  saveMeta();
  // Update skip for current viewed month if this toggle affects it
  if(mi===M){
    const md=getMD(Y,M);
    if(ams[M]===0) md.skips[id]=true;
    else delete md.skips[id];
    saveMD();
  }
  renderRecur(); partialSummary();
}
function toggleSkip(id){
  const md=getMD(Y,M); md.skips[id]=!md.skips[id]; saveMD(); render();
}
function setOv(id,val){
  const md=getMD(Y,M); md.overrides[id]=val===''?undefined:val;
  for(const e of md.expenses){ if(e.recurId===id){e.amount=val;break;} }
  saveMD(); partialSummary(); renderCats(); renderHistory();
  // Update badge only — no full table re-render so Actual Cost field keeps focus
  let _cnt=0,_tot=0;
  const _md=getMD(Y,M);
  RECUR.forEach(t=>{ if(!t.active||((_md.skips||{})[t.id])) return; _cnt++;
    const _ov=(_md.overrides||{})[t.id]; _tot+=parseFloat(_ov!==undefined?_ov:t.amount)||0; });
  document.getElementById('r-count').textContent=_cnt;
  document.getElementById('r-total').textContent=fmt(_tot)+'/mo';
}
function clearOv(id){
  const md=getMD(Y,M); delete md.overrides[id];
  const t=RECUR.find(r=>r.id===id);
  if(t){ for(const e of md.expenses){if(e.recurId===id){e.amount=t.amount;break;}} }
  saveMD(); render();
}

function filterAll(q){
  const term=q.toLowerCase().trim();
  // Filter rows in all three tbodies
  ['r-tbody','e-tbody','c-tbody'].forEach(id=>{
    const tbody=document.getElementById(id);
    if(!tbody) return;
    const rows=tbody.querySelectorAll('tr');
    for(let r=0;r<rows.length;r++){
      const row=rows[r];
      const isSummary=row.classList.contains('rsummary-row')||row.classList.contains('ec-summary-row');
      const isDetail=row.classList.contains('rdetail-row')||row.classList.contains('ec-detail-row');
      if(isSummary){
        const text=(row.textContent||'').toLowerCase();
        const match=!term||text.includes(term);
        row.style.display=match?'':'none';
        // Also toggle the detail row
        const next=rows[r+1];
        if(next&&(next.classList.contains('rdetail-row')||next.classList.contains('ec-detail-row'))){
          if(!match) next.style.display='none';
          else next.style.display=(next.classList.contains('r-hidden')||next.classList.contains('ec-hidden'))?'none':'';
        }
      }
    }
  });
}

function filterAllPers(q){
  const term=q.toLowerCase().trim();
  ['ps-sub-tbody','ps-exp-tbody','ps-c-tbody'].forEach(id=>{
    const tbody=document.getElementById(id);
    if(!tbody) return;
    const rows=tbody.querySelectorAll('tr');
    for(let r=0;r<rows.length;r++){
      const row=rows[r];
      const isSummary=row.classList.contains('rsummary-row')||row.classList.contains('ec-summary-row');
      if(isSummary){
        const text=(row.textContent||'').toLowerCase();
        const match=!term||text.includes(term);
        row.style.display=match?'':'none';
        const next=rows[r+1];
        if(next&&(next.classList.contains('rdetail-row')||next.classList.contains('ec-detail-row'))){
          if(!match) next.style.display='none';
          else next.style.display=(next.classList.contains('r-hidden')||next.classList.contains('ec-hidden'))?'none':'';
        }
      }
    }
  });
}

function addExp(){
  const md=getMD(Y,M); const n=new Date();
  md.expenses.push({date:`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`,desc:'',cat:CATS[0],paidBy:'1',amount:''});
  saveMD(); render();
  focusLastInlineName('e-tbody');
}
function updExp(i,f,v){
  const md=getMD(Y,M); md.expenses[i][f]=v; saveMD(); partialSummary(); renderCats(); renderHistory();
  if(f==='desc'||f==='notes'){
    renderExpenses();
    return;
  }
  const oneOff=md.expenses.filter(e=>!e.recurId);
  const ootEl=document.getElementById('other-total-tag');
  if(ootEl) ootEl.textContent=fmt(oneOff.reduce((s,e)=>s+(parseFloat(e.amount)||0),0));
}
function updExpPaid(i,v){
  const md=getMD(Y,M);
  md.expenses[i].paidBy=v==='p1'?'1':'2';
  delete md.expenses[i].joint;
  saveMD(); partialSummary(); renderCats(); renderHistory();
}
function delExp(i){ const md=getMD(Y,M); md.expenses.splice(i,1); saveMD(); render(); }

function addCredit(){
  const md=getMD(Y,M); const n=new Date();
  md.credits.push({date:`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`,desc:'',to:'1',amount:''});
  saveMD(); render();
  focusLastInlineName('c-tbody');
}
function updCredit(i,f,v){
  const md=getMD(Y,M); md.credits[i][f]=v; saveMD();
  partialSummary(); renderHistory();
  if(f!=='amount'){
    // Rebuild table for text/select/date changes so summary and detail rows stay in sync.
    renderCredits();
  } else {
    // Just update the total badge without rebuilding the table
    const tot=(md.credits||[]).reduce((s,c)=>s+(parseFloat(c.amount)||0),0);
    document.getElementById('c-total').textContent=fmt(tot);
    document.getElementById('c-count').textContent=(md.credits||[]).length;
  }
}
function delCredit(i){ const md=getMD(Y,M); md.credits.splice(i,1); saveMD(); render(); }

function toggleSettle(){ const md=getMD(Y,M); md.settled=!md.settled; saveMD(); render(); }

/* ── Reorder functions ─────────────────────────── */
function _swap(arr,i,dir){
  const j=i+dir;
  if(j<0||j>=arr.length) return false;
  [arr[i],arr[j]]=[arr[j],arr[i]];
  return true;
}
function reorderRecur(i,dir){
  if(_swap(RECUR,i,dir)){ saveMeta(); render(); }
}
function reorderExp(i,dir){
  const md=getMD(Y,M);
  // Get indices of non-recurring expenses only
  const indices=[]; md.expenses.forEach((e,idx)=>{if(!e.recurId) indices.push(idx);});
  const pos=indices.indexOf(i);
  if(pos<0) return;
  const j=pos+dir;
  if(j<0||j>=indices.length) return;
  const ai=indices[pos], bi=indices[j];
  [md.expenses[ai],md.expenses[bi]]=[md.expenses[bi],md.expenses[ai]];
  saveMD(); render();
}
function reorderCredit(i,dir){
  const md=getMD(Y,M);
  if(_swap(md.credits,i,dir)){ saveMD(); render(); }
}
function reorderPSub(who,i,dir){
  if(_swap(PSUBS[who],i,dir)){ savePMeta(); renderPersSubs(who); renderPersHist(who); }
}
function reorderPExp(who,i,dir){
  const md=getPMD(who,PY,PM);
  const indices=[]; md.expenses.forEach((e,idx)=>{if(!e.isSubSeed) indices.push(idx);});
  const pos=indices.indexOf(i);
  if(pos<0) return;
  const j=pos+dir;
  if(j<0||j>=indices.length) return;
  const ai=indices[pos], bi=indices[j];
  [md.expenses[ai],md.expenses[bi]]=[md.expenses[bi],md.expenses[ai]];
  savePMD(who); renderPersExps(who);
}
function reorderPCredit(who,i,dir){
  const md=getPMD(who,PY,PM);
  if(_swap(md.credits,i,dir)){ savePMD(who); renderPersCredits(who); }
}

function changeMonth(d){
  M+=d; if(M>11){M=0;Y++;} if(M<0){M=11;Y--;}
  seedMonth(Y,M); render();
  listenCurrentMonth(); // re-listen to new month's Firestore doc
}

/* partial re-render to preserve focus while typing */
function partialSummary(){
  const r=calcMonth(Y,M); const carry=getCarry(Y,M); const comb=r.balance+carry;
  document.getElementById('vp1').textContent=fmt(r.net1);
  document.getElementById('vp2').textContent=fmt(r.net2);
  document.getElementById('vtotal').textContent=fmt(r.net1+r.net2);
  document.getElementById('vbal').textContent=fmt(Math.abs(comb));
  document.getElementById('lblbal').textContent=comb>0.005?`${name2} owes ${name1}`:comb<-0.005?`${name1} owes ${name2}`:'All Even ✓';
}


/* ════════════════════════════════════════════════
   PERSONAL PAGE
   PDB = { "1": { "YYYY-MM": { subs:[], expenses:[], subOpen:true } }, "2": {...} }
   PSUBS = { "1": [...templates], "2": [...templates] }  (global, like RECUR)
════════════════════════════════════════════════ */
let persWho = '1';   // '1' or '2' — whose page is open
let PY, PM;          // personal page month/year
let PSUBS = {'1':[], '2':[]};  // recurring subscription templates per person
let PDB   = {'1':{}, '2':{}};  // per-month data per person
let persSubOpen = {'1':true,'2':true};

// ── Load / Save ──────────────────────────────
async function loadPersonal(){
  // Load from cache first
  try{
    const m=JSON.parse(_cacheGet('pers_meta')||'{}');
    PSUBS = m.subs || {'1':[],'2':[]};
    persSubOpen = m.subOpen || {'1':true,'2':true};
  }catch(e){}
  for(const k in localStorage){
    if(_isCachePersonalMonthKey(k)){
      const raw=k.slice(_cachePrefix().length);
      const who=raw[1]; const mk2=raw.slice(3);
      try{ PDB[who][mk2]=JSON.parse(localStorage.getItem(k)); }catch(e){}
    }
  }
  // Load from Firebase
  if(window._fbGet && _familyId){
    try{
      const pm=await window._fbGet(_famPath('persMeta/data'));
      if(pm){ PSUBS=pm.subs||{'1':[],'2':[]}; persSubOpen=pm.subOpen||{'1':true,'2':true};
        _cacheSet('pers_meta',JSON.stringify({subs:PSUBS,subOpen:persSubOpen})); }
      // Load personal months for both people, last 24 months
      for(const who of ['1','2']){
        const keys=Array.from({length:24},(_,i)=>{
          const d=new Date(); d.setMonth(d.getMonth()-12+i);
          return mk(d.getFullYear(),d.getMonth());
        });
        await Promise.all(keys.map(async k=>{
          const doc=await window._fbGet(_famPath('personal_'+who+'/'+k));
          if(doc&&doc.data){ try{ PDB[who][k]=JSON.parse(doc.data); _cacheSet('p'+who+'_'+k,doc.data); }catch(e){} }
        }));
      }
    }catch(e){ console.warn('Personal Firebase load failed',e); }
  }
}
async function savePMeta(){
  const data={subs:PSUBS,subOpen:persSubOpen};
  _cacheSet('pers_meta',JSON.stringify(data));
  if(window._fbSet && _familyId){ setSyncing(); const ok=await window._fbSet(_famPath('persMeta/data'),data); ok?setSynced():setSyncError(); }
}
function getPMD(who,y,m){
  const k=mk(y,m);
  if(!PDB[who]) PDB[who]={};
  if(!PDB[who][k]) PDB[who][k]={expenses:[],credits:[],seeded:false,skips:{},overrides:{}};
  if(!PDB[who][k].credits) PDB[who][k].credits=[];
  if(!PDB[who][k].skips) PDB[who][k].skips={};
  if(!PDB[who][k].overrides) PDB[who][k].overrides={};
  return PDB[who][k];
}
async function savePMD(who){
  // NOTE: uses global PY/PM — only safe when called from the currently viewed personal month context
  const k=mk(PY,PM);
  const data=PDB[who][k];
  _cacheSet('p'+who+'_'+k, JSON.stringify(data));
  if(window._fbSet && _familyId){ setSyncing(); const ok=await window._fbSet(_famPath('personal_'+who+'/'+k),{data:JSON.stringify(data)}); ok?setSynced():setSyncError(); }
}
// Personal months use the same key format as joint months

// ── Seed subscriptions into personal month ──
function seedPersonalMonth(who,y,m){
  const md=getPMD(who,y,m);
  let changed=false;
  for(const t of (PSUBS[who]||[])){
    if(!t.active) continue;
    const freq=t.frequency||'monthly';
    // For annual/semiannual, auto-skip in off-months
    if(freq==='annual'||freq==='semiannual'){
      const anchor=t.anchorDate;
      if(anchor){
        const anchorD=new Date(anchor+'T12:00:00');
        const anchorMo=anchorD.getMonth();
        const isActive=freq==='annual'?(m===anchorMo):(m===anchorMo||m===(anchorMo+6)%12);
        if(!isActive && !md.skips[t.id]){ md.skips[t.id]=true; changed=true; }
        if(isActive && md.skips[t.id]){ delete md.skips[t.id]; changed=true; }
      }
    }
    const existing=md.expenses.find(e=>e.subId===t.id);
    if(!existing){
      md.expenses.push({
        date:'',desc:t.name,cat:'Subscriptions',paidBy:who,
        amount:t.amount||'',subId:t.id,isSubSeed:true
      });
      const ams=t.activeMonths;
      if(ams && ams[m]===0) md.skips[t.id]=true;
      changed=true;
    } else {
      if((!existing.amount || existing.amount==='') && t.amount){
        existing.amount=t.amount; changed=true;
      }
    }
  }
  // Auto-seed credits from personal subs with creditAmount
  if(!md.credits) md.credits=[];
  for(const t of (PSUBS[who]||[])){
    if(!t.active) continue;
    const creditId='rpc_'+t.id;
    const sk=md.skips&&(md.skips[t.id]);
    if(!t.creditAmount || sk){
      const staleIdx=md.credits.findIndex(c=>c.recurCreditId===creditId);
      if(staleIdx!==-1){ md.credits.splice(staleIdx,1); changed=true; }
      continue;
    }
    const existing=md.credits.find(c=>c.recurCreditId===creditId);
    if(!existing){
      md.credits.push({
        date:'',
        desc:t.name+' (auto-credit)',
        amount:t.creditAmount,
        payment:t.payment||'',
        recurCreditId:creditId
      });
      changed=true;
    } else {
      if(existing.amount!==t.creditAmount){ existing.amount=t.creditAmount; changed=true; }
      if((existing.payment||'')!==(t.payment||'')){ existing.payment=t.payment||''; changed=true; }
      if(existing.desc!==t.name+' (auto-credit)'){ existing.desc=t.name+' (auto-credit)'; changed=true; }
    }
  }
  md.seeded=true;
  if(changed) savePMD(who);
}

// ── Open / Close ─────────────────────────────
let _persMonthUnsub=null;
function openPersonal(who){
  persWho=String(who);
  const n=new Date(); PY=n.getFullYear(); PM=n.getMonth();
  seedPersonalMonth(persWho,PY,PM);
  // 3f: Collapse all personal-page rows on each open for scannability.
  // Within-session toggles still persist; this just resets default on open.
  _collapsedPRecur.clear(); _collapsedPExp.clear(); _collapsedPCred.clear();
  const psubs = PSUBS[persWho] || [];
  for(let i=0;i<psubs.length;i++) _collapsedPRecur.add(i);
  const pk = mk(PY,PM);
  const pmd = PDB[persWho] && PDB[persWho][pk];
  if(pmd){
    const credLen = (pmd.credits||[]).length;
    for(let i=0;i<credLen;i++) _collapsedPCred.add(i);
    const oneOff = (pmd.expenses||[]).filter(e => !e.recurId && !e.recurParent);
    for(let i=0;i<oneOff.length;i++) _collapsedPExp.add(i);
  }
  document.getElementById('pers-overlay').classList.add('open');
  renderPersonal();
  listenPersMonth();
}
function listenPersMonth(){
  if(_persMonthUnsub){ _persMonthUnsub(); _persMonthUnsub=null; }
  if(!window._fbListen||!_familyId) return;
  const k=mk(PY,PM);
  _persMonthUnsub=window._fbListen(_famPath('personal_'+persWho+'/'+k), data=>{
    if(!data||!data.data) return;
    try{
      const parsed=JSON.parse(data.data);
      PDB[persWho][k]=parsed;
      _cacheSet('p'+persWho+'_'+k,data.data);
      renderPersonal();
    }catch(e){}
  });
}
function closePersonal(){
  document.getElementById('pers-overlay').classList.remove('open');
}
function persChangeMonth(d){
  PM+=d; if(PM>11){PM=0;PY++;} if(PM<0){PM=11;PY--;}
  seedPersonalMonth(persWho,PY,PM);
  renderPersonal();
  listenPersMonth();
}

// ── Render ───────────────────────────────────
function renderPersonal(){
  const who=persWho;
  const pname=who==='1'?name1:name2;
  const color=who==='1'?'var(--p1)':'var(--p2)';
  // Clear personal filter
  const pf=document.getElementById('pers-filter'); if(pf) pf.value='';

  document.getElementById('pers-name').textContent=pname+"'s Personal Tracker";
  document.getElementById('pers-name').style.color=color;
  document.getElementById('pers-month-lbl').textContent=`${MO[PM]} ${PY}`;

  renderPersSubs(who);
  renderPersExps(who);
  renderPersCredits(who);
  renderPersHist(who);
}

function renderPersSubs(who){
  const md=getPMD(who,PY,PM);
  const tbody=document.getElementById('ps-sub-tbody');
  tbody.innerHTML='';
  let cnt=0, tot=0;
  const psubLen=(PSUBS[who]||[]).length;
  for(const idx of _collapsedPRecur){ if(idx>=psubLen) _collapsedPRecur.delete(idx); }
  (PSUBS[who]||[]).forEach((t,i)=>{
    const sk=!!(md.skips&&md.skips[t.id]);
    const seeded=md.expenses.find(e=>e.subId===t.id);
    const ov=seeded&&seeded.amount!==t.amount&&seeded.amount!==''?seeded.amount:'';
    const disp=ov!==''?ov:t.amount;
    if(t.active&&!sk){cnt++;tot+=parseFloat(disp)||0;}
    const collapsed=_collapsedPRecur.has(i);
    const covLabel=buildCovLabel(t,PM,PY);
    const pFreq=t.frequency||'monthly';
    const pDisp=ov!==''?ov:t.amount;
    const pMoTotal=(pFreq==='weekly')?(parseFloat(pDisp)||0)*4.33:(pFreq==='biweekly')?(parseFloat(pDisp)||0)*2.17:(parseFloat(pDisp)||0);
    const rowClass=!t.active?'ri':sk?'rskip':'';

    // Summary row
    const sr=document.createElement('tr');
    sr.className='rsummary-row'+(rowClass?' '+rowClass:'');
    sr.innerHTML=`<td colspan="6"><div style="display:flex;align-items:center;gap:4px;">
      <div class="reorder-arrows">
        <button class="reorder-btn" onclick="reorderPSub('${who}',${i},-1)" ${i===0?'disabled style="visibility:hidden"':''} title="Move up">▲</button>
        <button class="reorder-btn" onclick="reorderPSub('${who}',${i},1)" ${i===(PSUBS[who]||[]).length-1?'disabled style="visibility:hidden"':''} title="Move down">▼</button>
      </div>
      <button class="rexp-toggle" onclick="toggleRowCollapse('precur',${i},this)">${collapsed?'▶':'▼'}</button>
      <span contenteditable="true" class="rname-edit" data-placeholder="Enter subscription name…" onblur="const _n=this.textContent.trim();setTimeout(()=>{PSUBS['${who}'][${i}].name=_n;savePMeta();},150)">${esc(t.name||'')}</span>
      ${t.notes?'<span class="ec-note" style="color:var(--rv);">'+esc(t.notes)+'</span>':''}
      <span class="rsum">${fmt(pMoTotal)}${pFreq==='weekly'||pFreq==='biweekly'?' (≈/mo)':pFreq==='annual'?' (annual)':pFreq==='semiannual'?' (every 6 mo)':''}</span>
      <button class="del-btn" onclick="confirmDel(this,()=>delPSub('${who}',${i}))" style="margin-left:4px;" title="Delete">✕</button>
    </div></td>`;
    tbody.appendChild(sr);

    // Detail row
    const tr=document.createElement('tr');
    tr.className='rdetail-row'+(collapsed?' r-hidden':'')+(rowClass?' '+rowClass:'');
    tr.innerHTML=`
      <td colspan="6" class="recur-detail-cell">
        <div class="recur-detail-panel">
          <div class="recur-detail-group">
            <div class="recur-field rnum">
              <label>Usual Cost</label>
              <input type="number" value="${esc(t.amount||'')}" placeholder="$0.00" min="0" step="0.01" onchange="updPSub('${who}',${i},'amount',this.value)" title="Usual monthly cost">
            </div>
            <div class="recur-field rnum">
              <label>Override Cost</label>
              <div class="ov-wrap">
                <input type="number" value="${esc(String(ov))}" placeholder="$0.00" min="0" step="0.01" title="Actual cost this month — leave blank if same" onchange="setPersOv('${who}','${esc(t.id)}',this.value)">
                ${ov!==''?`<button class="ov-reset" onclick="clearPersOv('${who}','${esc(t.id)}')" title="Reset">✕</button>`:''}
              </div>
            </div>
            ${(pFreq==='weekly'||pFreq==='biweekly')&&(parseFloat(disp)||0)?'<div class="recur-subtle" style="font-family:DM Mono,monospace;color:var(--rv);">'+((pFreq==='weekly')?'4-5':'2-3')+'× ≈ '+fmt((parseFloat(disp)||0)*((pFreq==='weekly')?4.33:2.17))+'/mo</div>':''}
            <div class="recur-field">
              <label>Payment Type</label>
              <select onchange="updPSub('${who}',${i},'payment',this.value)">${paymentOptions(t.payment)}</select>
            </div>
          </div>
          <div class="recur-detail-group">
            <div class="recur-field credit">
              <label>Auto-Credit</label>
              <input type="number" value="${t.creditAmount||''}" placeholder="$0.00" min="0" step="0.01" style="font-family:'DM Mono',monospace;" onchange="updPSub('${who}',${i},'creditAmount',this.value)">
              <div class="recur-subtle">Uses this subscription's payment type for generated credits.</div>
            </div>
            <div class="recur-field">
              <label>Frequency</label>
              <select onchange="updPSub('${who}',${i},'frequency',this.value)">
                <option value="monthly" ${(t.frequency||'monthly')==='monthly'?'selected':''}>Monthly</option>
                <option value="biweekly" ${t.frequency==='biweekly'?'selected':''}>Bi-weekly</option>
                <option value="weekly" ${t.frequency==='weekly'?'selected':''}>Weekly</option>
                <option value="semiannual" ${t.frequency==='semiannual'?'selected':''}>Every 6 Months</option>
                <option value="annual" ${t.frequency==='annual'?'selected':''}>Annual</option>
              </select>
            </div>
            ${(t.frequency||'monthly')==='monthly'?`<div class="recur-field">
              <label>Charge Day</label>
              <select onchange="updPSub('${who}',${i},'chargeDay',this.value)">${chargeDayOptions(t.chargeDay)}</select>
            </div>`:`<div class="recur-field">
              <label>Anchor Date</label>
              <input type="date" value="${t.anchorDate||''}" onblur="updPSub('${who}',${i},'anchorDate',this.value)" title="First occurrence — all future dates calculated from this">
            </div>`}
          </div>
          <div class="recur-detail-group">
            <div class="recur-field">
              <label>Days Covered</label>
              <div class="recur-inline">
                <span class="recur-inline-label">From</span>
                <select onchange="updPSub('${who}',${i},'covStartRef',this.value)">
                  <option value="prev" ${(t.covStartRef||'curr')==='prev'?'selected':''}>Previous Month</option>
                  <option value="curr" ${(t.covStartRef||'curr')==='curr'?'selected':''}>This Month</option>
                  <option value="next" ${(t.covStartRef||'curr')==='next'?'selected':''}>Next Month</option>
                </select>
                <select onchange="updPSub('${who}',${i},'covStartDay',this.value)">${dayOptions(t.covStartDay)}</select>
              </div>
              <div class="recur-inline">
                <span class="recur-inline-label">To</span>
                <select onchange="updPSub('${who}',${i},'covEndRef',this.value)">
                  <option value="prev" ${(t.covEndRef||'next')==='prev'?'selected':''}>Previous Month</option>
                  <option value="curr" ${(t.covEndRef||'next')==='curr'?'selected':''}>This Month</option>
                  <option value="next" ${(t.covEndRef||'next')==='next'?'selected':''}>Next Month</option>
                </select>
                <select onchange="updPSub('${who}',${i},'covEndDay',this.value)">${dayOptions(t.covEndDay)}</select>
              </div>
              ${covLabel?`<div class="recur-subtle">${covLabel}</div>`:''}
            </div>
            <div class="recur-field">
              <label>Months Active</label>
              <div class="recur-months">
                ${(t.activeMonths||[1,1,1,1,1,1,1,1,1,1,1,1]).map((on,mi)=>`<button type="button" class="mo-btn ${on?'on':''} ${mi===PM?'curr-mo':''}" onclick="togglePersActiveMo('${who}','${esc(t.id)}',${i},${mi})" title="${MO[mi]}">${MOS[mi][0]}</button>`).join('')}
              </div>
            </div>
          </div>
          <div class="recur-detail-group">
            <div class="recur-field">
              <label>Notes</label>
              <input class="recur-note-input" type="text" value="${esc(t.notes||'')}" placeholder="Optional note…" onchange="updPSub('${who}',${i},'notes',this.value)">
            </div>
          </div>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });

  document.getElementById('ps-sub-cnt').textContent=cnt;
  document.getElementById('ps-sub-tag').textContent=`${fmt(tot)}/mo`;
  document.getElementById('ps-sub-total').textContent=fmt(tot);

  const open=persSubOpen[who]!==false;
  document.getElementById('ps-sub-body').classList.toggle('open',open);
  document.getElementById('ps-sub-chev').classList.toggle('open',open);

  updatePersTotals(who);
}

function renderPersExps(who){
  const md=getPMD(who,PY,PM);
  const tbody=document.getElementById('ps-exp-tbody');
  const empty=document.getElementById('ps-exp-empty');
  tbody.innerHTML='';
  const oneOff=md.expenses.filter(e=>!e.isSubSeed);
  for(const idx of _collapsedPExp){ if(idx>=oneOff.length) _collapsedPExp.delete(idx); }
  empty.style.display=oneOff.length===0?'block':'none';
  const pecEl=document.getElementById('ps-exp-cnt');
  if(pecEl) pecEl.textContent=oneOff.length;
  let pExpIdx=0;
  md.expenses.forEach((e,ei)=>{
    if(e.isSubSeed) return;
    const collapsed=_collapsedPExp.has(pExpIdx);
    const pidx=pExpIdx;

    const sr=document.createElement('tr');
    sr.className='ec-summary-row';
    sr.innerHTML=`<td colspan="7"><div style="display:flex;align-items:center;gap:4px;">
      <div class="reorder-arrows">
        <button class="reorder-btn" onclick="reorderPExp('${who}',${ei},-1)" ${pidx===0?'disabled style="visibility:hidden"':''} title="Move up">▲</button>
        <button class="reorder-btn" onclick="reorderPExp('${who}',${ei},1)" ${pidx===oneOff.length-1?'disabled style="visibility:hidden"':''} title="Move down">▼</button>
      </div>
      <button class="ec-toggle" onclick="toggleRowCollapse('pexp',${pidx},this)">${collapsed?'▶':'▼'}</button>
      <span contenteditable="true" class="ec-name-edit" data-placeholder="Enter expense description…" onblur="const _d=this.textContent.trim();setTimeout(()=>updPExp('${who}',${ei},'desc',_d),150)">${esc(e.desc||'')}</span>
      <span style="font-family:'DM Mono',monospace;font-size:.82rem;color:var(--slate);margin-left:auto;">${fmt(parseFloat(e.amount)||0)}</span>
      ${e.notes?'<span class="ec-note">'+esc(e.notes)+'</span>':''}
      <button class="del-btn" onclick="confirmDel(this,()=>delPExp('${who}',${ei}))" style="margin-left:4px;">✕</button>
    </div></td>`;
    tbody.appendChild(sr);

    const dr=document.createElement('tr');
    dr.className='ec-detail-row'+(collapsed?' ec-hidden':'');
    dr.setAttribute('data-ec-idx',pidx);
    dr.innerHTML=`
      <td><input type="date" value="${e.date||''}" onchange="updPExp('${who}',${ei},'date',this.value)"></td>
      <td><input type="text" value="${esc(e.desc||'')}" placeholder="Description" onchange="updPExp('${who}',${ei},'desc',this.value)"></td>
      <td><select onchange="updPExp('${who}',${ei},'cat',this.value)">
        ${CATS.map(c=>`<option value="${c}" ${e.cat===c?'selected':''}>${c}</option>`).join('')}
      </select></td>
      <td><select onchange="updPExp('${who}',${ei},'payment',this.value)">
        <option value="" ${!e.payment?'selected':''}>Payment Type</option>
        <option value="Amex" ${e.payment==='Amex'?'selected':''}>Amex</option>
        <option value="Chase" ${e.payment==='Chase'?'selected':''}>Chase</option>
        <option value="Debit" ${e.payment==='Debit'?'selected':''}>Debit</option>
        <option value="ACH" ${e.payment==='ACH'?'selected':''}>ACH</option>
        <option value="Cash" ${e.payment==='Cash'?'selected':''}>Cash</option>
        <option value="Check" ${e.payment==='Check'?'selected':''}>Check</option>
        <option value="Other" ${e.payment==='Other'?'selected':''}>Other</option>
      </select></td>
      <td class="anum"><input type="number" value="${e.amount||''}" placeholder="0.00" min="0" step="0.01" onchange="updPExpAmt('${who}',${ei},this.value)"></td>
      <td><input type="text" value="${esc(e.notes||'')}" placeholder="Optional note…" onchange="updPExp('${who}',${ei},'notes',this.value)" style="min-width:100px"></td>`;
    tbody.appendChild(dr);
    pExpIdx++;
  });
  const peOpen=persExpOpen[who]!==false;
  document.getElementById('ps-exp-body').classList.toggle('open',peOpen);
  document.getElementById('ps-exp-chev').classList.toggle('open',peOpen);
  updatePersTotals(who);
}

function updatePersTotals(who){
  const md=getPMD(who,PY,PM);
  // sub total from templates (active + not skipped, with any override)
  let subTot=0;
  (PSUBS[who]||[]).forEach(t=>{
    if(!t.active) return;
    if(md.skips&&md.skips[t.id]) return;
    const seeded=md.expenses.find(e=>e.subId===t.id);
    const ov=seeded&&seeded.amount!==''?seeded.amount:t.amount;
    subTot+=parseFloat(ov)||0;
  });
  // other expenses total
  const expTot=md.expenses.filter(e=>!e.isSubSeed).reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  // credits total
  const credTot=(md.credits||[]).reduce((s,c)=>s+(parseFloat(c.amount)||0),0);
  document.getElementById('ps-sub-total').textContent=fmt(subTot);
  document.getElementById('ps-exp-total').textContent=fmt(expTot);
  const pstag=document.getElementById('ps-exp-tag'); if(pstag) pstag.textContent=fmt(expTot);
  document.getElementById('ps-cred-total').textContent=fmt(credTot);
  document.getElementById('ps-grand-total').textContent=fmt(Math.max(0, subTot+expTot-credTot));
}

function renderPersHist(who){
  const tbody=document.getElementById('ps-hist-tbody');
  // Build list of 12 months: current personal viewed month and 11 preceding
  const months=[];
  for(let i=0;i<12;i++){
    let ym=PM-i, yy=PY;
    while(ym<0){ym+=12;yy--;}
    months.push(mk(yy,ym));
  }
  const keys=months.filter(k=>PDB[who]&&PDB[who][k]);
  if(!keys.length){
    tbody.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--slate);padding:14px;font-family:DM Sans;font-size:.85rem">No history yet.</td></tr>';
    return;
  }
  tbody.innerHTML=keys.map(k=>{
    const md=PDB[who][k]; if(!md) return '';
    const[yr,mo]=k.split('-');
    const m=parseInt(mo)-1;
    // Calculate sub total from seeded expenses, respecting skips
    let subTot=0;
    (PSUBS[who]||[]).forEach(t=>{
      if(!t.active) return;
      if(md.skips&&md.skips[t.id]) return;
      const seeded=(md.expenses||[]).find(e=>e.subId===t.id);
      const amt=seeded&&seeded.amount!==''?seeded.amount:t.amount;
      subTot+=parseFloat(amt)||0;
    });
    const expTot=(md.expenses||[]).filter(e=>!e.isSubSeed).reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
    const credTot=(md.credits||[]).reduce((s,c)=>s+(parseFloat(c.amount)||0),0);
    return`<tr>
      <td style="font-family:DM Sans">${MO[m]} ${yr}</td>
      <td>${fmt(subTot)}</td>
      <td>${fmt(expTot)}</td>
      <td style="color:var(--cv)">${credTot>0?'-':''}${fmt(credTot)}</td>
      <td>${fmt(Math.max(0, subTot+expTot-credTot))}</td>
    </tr>`;
  }).join('');
}

// ── Actions ─────────────────────────────────
function togglePersZone(){
  persSubOpen[persWho]=!persSubOpen[persWho];
  savePMeta(); renderPersSubs(persWho);
}

function addPersSub(){
  if(!PSUBS[persWho]) PSUBS[persWho]=[];
  PSUBS[persWho].push({id:'ps'+Date.now(),name:'',amount:'',notes:'',active:true,
    frequency:'monthly',anchorDate:'',creditAmount:'',
    chargeDay:'',covStartRef:'curr',covStartDay:'',covEndRef:'next',covEndDay:'',
    activeMonths:[1,1,1,1,1,1,1,1,1,1,1,1]});
  savePMeta();
  seedPersonalMonth(persWho,PY,PM);
  renderPersSubs(persWho); renderPersHist(persWho);
}
function updPSub(who,i,f,v){
  PSUBS[who][i][f]=v; savePMeta();
  if(f==='frequency'||f==='anchorDate'){
    // Auto-set activeMonths for annual/semiannual
    const t=PSUBS[who][i];
    const fr=t.frequency||'monthly';
    if((fr==='annual'||fr==='semiannual')&&t.anchorDate){
      const anchorMo=new Date(t.anchorDate+'T12:00:00').getMonth();
      if(!isNaN(anchorMo)){
        const ams=[0,0,0,0,0,0,0,0,0,0,0,0];
        ams[anchorMo]=1;
        if(fr==='semiannual') ams[(anchorMo+6)%12]=1;
        PSUBS[who][i].activeMonths=ams;
        savePMeta();
      }
    } else if(fr==='monthly'||fr==='weekly'||fr==='biweekly'){
      if(PSUBS[who][i].activeMonths&&PSUBS[who][i].activeMonths.filter(v=>v).length<=2){
        PSUBS[who][i].activeMonths=[1,1,1,1,1,1,1,1,1,1,1,1];
        savePMeta();
      }
    }
    // Re-seed
    const md=getPMD(who,PY,PM);
    md.seeded=false;
    seedPersonalMonth(who,PY,PM);
  }
  if(f==='payment'||f==='creditAmount'||f==='name'){
    seedPersonalMonth(who,PY,PM);
  }
  renderPersSubs(who); renderPersHist(who);
}
function delPSub(who,i){
  PSUBS[who].splice(i,1); savePMeta(); renderPersSubs(who); renderPersHist(who);
}
function setPersOv(who,id,val){
  const md=getPMD(who,PY,PM);
  const seeded=md.expenses.find(e=>e.subId===id);
  if(seeded) seeded.amount=val;
  savePMD(who); renderPersSubs(who); renderPersHist(who);
}
function clearPersOv(who,id){
  const md=getPMD(who,PY,PM);
  const seeded=md.expenses.find(e=>e.subId===id);
  const t=(PSUBS[who]||[]).find(s=>s.id===id);
  if(seeded&&t) seeded.amount=t.amount;
  savePMD(who); renderPersSubs(who); renderPersHist(who);
}

function togglePersSkip(who,id){
  const md=getPMD(who,PY,PM);
  md.skips[id]=!md.skips[id];
  savePMD(who); renderPersSubs(who); renderPersHist(who);
}

function togglePersActiveMo(who,id,i,mi){
  const ams=(PSUBS[who][i].activeMonths||[1,1,1,1,1,1,1,1,1,1,1,1]).slice();
  ams[mi] = ams[mi] ? 0 : 1;
  PSUBS[who][i].activeMonths=ams;
  savePMeta();
  if(mi===PM){
    const md=getPMD(who,PY,PM);
    if(ams[PM]===0) md.skips[id]=true;
    else delete md.skips[id];
    savePMD(who);
  }
  renderPersSubs(who); renderPersHist(who);
}

function addPersExp(){
  const md=getPMD(persWho,PY,PM); const n=new Date();
  md.expenses.push({
    date:`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`,
    desc:'',cat:CATS[0],amount:'',notes:''
  });
  savePMD(persWho); renderPersExps(persWho);
  focusLastInlineName('ps-exp-tbody');
}
function updPExp(who,i,f,v){
  const md=getPMD(who,PY,PM); md.expenses[i][f]=v; savePMD(who);
  updatePersTotals(who); renderPersHist(who);
  if(f==='desc'||f==='notes') renderPersExps(who);
}
function updPExpAmt(who,i,v){
  const md=getPMD(who,PY,PM); md.expenses[i].amount=v; savePMD(who);
  updatePersTotals(who); renderPersHist(who);
}
function delPExp(who,i){
  const md=getPMD(who,PY,PM); md.expenses.splice(i,1); savePMD(who); renderPersExps(who);
}

// ── Personal Credits ─────────────────────────
let persCreditOpen = {'1':true,'2':true};
let persExpOpen = {'1':true,'2':true};

function togglePersCreditZone(){
  persCreditOpen[persWho]=!persCreditOpen[persWho];
  renderPersCredits(persWho);
}

function togglePersExpZone(){
  persExpOpen[persWho]=!persExpOpen[persWho];
  renderPersExps(persWho);
}

function renderPersCredits(who){
  const md=getPMD(who,PY,PM);
  if(!md.credits) md.credits=[];
  const tbody=document.getElementById('ps-c-tbody');
  const empty=document.getElementById('ps-c-empty');
  tbody.innerHTML='';
  let tot=0;
  for(const idx of _collapsedPCred){ if(idx>=md.credits.length) _collapsedPCred.delete(idx); }
  md.credits.forEach((c,i)=>{
    tot+=parseFloat(c.amount)||0;
    const collapsed=_collapsedPCred.has(i);
    const isAuto=!!c.recurCreditId;

    const sr=document.createElement('tr');
    sr.className='ec-summary-row';
    sr.innerHTML=`<td colspan="6"><div style="display:flex;align-items:center;gap:4px;">
      <div class="reorder-arrows">
        <button class="reorder-btn" onclick="reorderPCredit('${who}',${i},-1)" ${i===0?'disabled style="visibility:hidden"':''} title="Move up">▲</button>
        <button class="reorder-btn" onclick="reorderPCredit('${who}',${i},1)" ${i===md.credits.length-1?'disabled style="visibility:hidden"':''} title="Move down">▼</button>
      </div>
      <button class="ec-toggle" onclick="toggleRowCollapse('pcred',${i},this)">${collapsed?'▶':'▼'}</button>
      ${isAuto?'<span style="font-size:.55rem;font-weight:700;color:var(--cv);background:var(--cbg);border:1px solid var(--cb);border-radius:4px;padding:1px 5px;">AUTO</span>':''}
      <span contenteditable="true" class="ec-name-edit" data-placeholder="Enter credit description…" onblur="const _d=this.textContent.trim();setTimeout(()=>updPersCredit('${who}',${i},'desc',_d),150)">${esc(c.desc||'')}</span>
      <span style="font-family:'DM Mono',monospace;font-size:.82rem;color:var(--cv);margin-left:auto;">${fmt(parseFloat(c.amount)||0)}</span>
      ${c.notes?'<span class="ec-note">'+esc(c.notes)+'</span>':''}
      ${isAuto?'':'<button class="cdel-btn" onclick="confirmDel(this,()=>delPersCredit(\''+who+'\','+i+'))" style="margin-left:4px;">✕</button>'}
    </div></td>`;
    tbody.appendChild(sr);

    const dr=document.createElement('tr');
    dr.className='ec-detail-row'+(collapsed?' ec-hidden':'');
    dr.setAttribute('data-ec-idx',i);
    dr.innerHTML=`
      <td><input type="date" value="${c.date||''}" onchange="updPersCredit('${who}',${i},'date',this.value)"></td>
      <td><input type="text" value="${esc(c.desc||'')}" placeholder="e.g. Refund" onchange="updPersCredit('${who}',${i},'desc',this.value)"></td>
      <td><select onchange="updPersCredit('${who}',${i},'payment',this.value)">
        <option value="" ${!c.payment?'selected':''}>Payment Type</option>
        <option value="Amex" ${c.payment==='Amex'?'selected':''}>Amex</option>
        <option value="Chase" ${c.payment==='Chase'?'selected':''}>Chase</option>
        <option value="Debit" ${c.payment==='Debit'?'selected':''}>Debit</option>
        <option value="ACH" ${c.payment==='ACH'?'selected':''}>ACH</option>
        <option value="Cash" ${c.payment==='Cash'?'selected':''}>Cash</option>
        <option value="Check" ${c.payment==='Check'?'selected':''}>Check</option>
        <option value="Other" ${c.payment==='Other'?'selected':''}>Other</option>
      </select></td>
      <td class="cnum"><input type="number" value="${c.amount||''}" placeholder="0.00" min="0" step="0.01" onchange="updPersCredit('${who}',${i},'amount',this.value)"></td>
      <td><input type="text" value="${esc(c.notes||'')}" placeholder="Optional note…" onchange="updPersCredit('${who}',${i},'notes',this.value)"></td>`;
    tbody.appendChild(dr);
  });
  const cnt=md.credits.length;
  document.getElementById('ps-c-count').textContent=cnt;
  document.getElementById('ps-c-total').textContent=fmt(tot);
  document.getElementById('ps-cred-total').textContent=fmt(tot);
  empty.style.display=cnt===0?'block':'none';

  const open=persCreditOpen[who]!==false;
  document.getElementById('ps-c-body').classList.toggle('open',open);
  document.getElementById('ps-c-chev').classList.toggle('open',open);

  updatePersTotals(who);
}

function addPersCredit(){
  const md=getPMD(persWho,PY,PM);
  if(!md.credits) md.credits=[];
  const n=new Date();
  md.credits.push({date:`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`,desc:'',amount:'',notes:''});
  savePMD(persWho); renderPersCredits(persWho);
  focusLastInlineName('ps-c-tbody');
}
function updPersCredit(who,i,f,v){
  const md=getPMD(who,PY,PM); md.credits[i][f]=v; savePMD(who);
  if(f==='amount'){
    const tot=(md.credits||[]).reduce((s,c)=>s+(parseFloat(c.amount)||0),0);
    document.getElementById('ps-c-total').textContent=fmt(tot);
    document.getElementById('ps-c-count').textContent=(md.credits||[]).length;
    document.getElementById('ps-cred-total').textContent=fmt(tot);
    updatePersTotals(who); renderPersHist(who);
  } else {
    renderPersCredits(who);
  }
}
function delPersCredit(who,i){
  const md=getPMD(who,PY,PM); md.credits.splice(i,1); savePMD(who); renderPersCredits(who);
}

/* ════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════ */
function fmt(v){ return '$'+(parseFloat(v)||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,','); }
function ordinal(n){ const s=['th','st','nd','rd']; const v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function isValidInviteEmail(email){
  return typeof email === 'string' &&
    email.length > 0 &&
    email.length <= 320 &&
    !email.includes('/') &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function toggleRowCollapse(type,idx,btn){
  const sets={recur:_collapsedRecur,exp:_collapsedExp,cred:_collapsedCred,precur:_collapsedPRecur,pexp:_collapsedPExp,pcred:_collapsedPCred};
  const s=sets[type];
  if(!s) return;
  const summaryRow=btn.closest('tr');
  const detailRow=summaryRow.nextElementSibling;
  if(s.has(idx)){
    s.delete(idx);
    if(detailRow) detailRow.classList.remove('ec-hidden','r-hidden');
    btn.textContent='▼';
  } else {
    s.add(idx);
    if(detailRow) detailRow.classList.add(type==='recur'||type==='precur'?'r-hidden':'ec-hidden');
    btn.textContent='▶';
  }
  _saveCollapsed();
}

let toastTimer;
function showToast(msg){
  const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2200);
}

function runDevTests(){
  const results=[];
  const snap={Y,M,DB,RECUR,name1,name2,_familyId};
  const assert=(name,ok,detail='')=>{ results.push({name,ok,detail}); if(!ok) throw new Error(name+(detail?': '+detail:'')); };
  const approx=(a,b)=>Math.abs(a-b)<0.0001;
  try{
    assert('fmt formats money', fmt(1234.5)==='$1,234.50');
    assert('ordinal suffixes', ordinal(1)==='1st'&&ordinal(2)==='2nd'&&ordinal(3)==='3rd'&&ordinal(11)==='11th');
    assert('mk zero-pads months', mk(2026,0)==='2026-01');
    assert('invite email rejects path separators', isValidInviteEmail('test@example.com')&&!isValidInviteEmail('bad/name@example.com'));
    assert('family id accepts only app-generated ids', isSafeFamilyId('fam_3g9178wnsrg2')&&!isSafeFamilyId('fam_bad/path'));
    assert('chargeDate clamps month end', chargeDate(31,2026,1)==='2026-02-28');
    const weekly=getRecurDates({frequency:'weekly',anchorDate:'2026-04-01'},2026,3);
    assert('weekly recurrence dates', weekly.length===5&&weekly[0]==='2026-04-01'&&weekly[4]==='2026-04-29', weekly.join(','));
    const biweekly=getRecurDates({frequency:'biweekly',anchorDate:'2026-04-03'},2026,3);
    assert('biweekly recurrence dates', biweekly.length===2&&biweekly[0]==='2026-04-03'&&biweekly[1]==='2026-04-17', biweekly.join(','));
    _familyId='fam_3g9178wnsrg2';
    assert('family cache key prefixes', _cacheKey('meta')==='bgt_fam_3g9178wnsrg2_meta');
    Y=2026; M=3; name1='Person 1'; name2='Person 2';
    RECUR=[{id:'r1',amount:'40'}];
    DB={'2026-04':{expenses:[
      {amount:'100',paidBy:'1'},
      {amount:'50',paidBy:'2'},
      {amount:'40',paidBy:'1',recurId:'r1'}
    ],credits:[
      {amount:'20',to:'1'},
      {amount:'10',to:'shared'}
    ],settled:false,skips:{},overrides:{}}};
    const r=calcMonth(2026,3);
    assert('calcMonth paid totals', approx(r.paid1,140)&&approx(r.paid2,50), JSON.stringify(r));
    assert('calcMonth credit nets', approx(r.net1,115)&&approx(r.net2,45)&&approx(r.balance,70), JSON.stringify(r));
    DB['2026-04'].skips={r1:true};
    const skipped=calcMonth(2026,3);
    assert('calcMonth excludes skipped recurring', approx(skipped.paid1,100)&&approx(skipped.net1,75)&&approx(skipped.balance,30), JSON.stringify(skipped));
    console.table(results);
    showToast('Dev tests passed');
    return true;
  }catch(e){
    console.error('Dev tests failed:', e, results);
    showToast('Dev tests failed: '+e.message);
    return false;
  }finally{
    Y=snap.Y; M=snap.M; DB=snap.DB; RECUR=snap.RECUR; name1=snap.name1; name2=snap.name2; _familyId=snap._familyId;
  }
}

/* ════════════════════════════════════════════════
   IMPORT / EXPORT
════════════════════════════════════════════════ */
function exportJSON(){
  const payload = {
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    meta: { name1, name2, recur: RECUR, rOpen, cOpen, eOpen },
    months: DB,
    persMeta: { subs: PSUBS, subOpen: persSubOpen },
    personal: { '1': PDB['1'], '2': PDB['2'] }
  };
  const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0,10);
  a.href = url; a.download = `family-budget-backup-${ts}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('JSON exported ✓');
}

function exportCSV(){
  const rows = [];
  // Header
  rows.push(['Type','Source','Month','Date','Description','Category','Paid By','Payment','Amount','Notes','Skipped']);

  const escapeCSV = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
  };
  const nameOf = pb => pb==='1'?name1 : pb==='2'?name2 : pb==='shared'?'Shared' : '';

  // Joint months
  Object.keys(DB).sort().forEach(k => {
    const md = DB[k];
    if(!md) return;
    (md.expenses||[]).forEach(e => {
      const isRecur = !!e.recurId;
      const skipped = isRecur && md.skips && md.skips[e.recurId] ? 'yes' : '';
      let amt = parseFloat(e.amount)||0;
      if(!amt && isRecur){
        const ov = md.overrides && md.overrides[e.recurId];
        if(ov!==undefined && ov!=='') amt = parseFloat(ov)||0;
        if(!amt){ const t = RECUR.find(r=>r.id===e.recurId); if(t) amt = parseFloat(t.amount)||0; }
      }
      rows.push([
        isRecur?'Recurring':'Expense', 'Joint', k, e.date||'', e.desc||'',
        e.cat||'', nameOf(e.paidBy), e.payment||'', amt.toFixed(2), e.notes||'', skipped
      ]);
    });
    (md.credits||[]).forEach(c => {
      rows.push([
        'Credit','Joint',k,c.date||'',c.desc||'','',nameOf(c.to),c.payment||'',
        (parseFloat(c.amount)||0).toFixed(2), c.notes||'', ''
      ]);
    });
  });

  // Personal months
  ['1','2'].forEach(who => {
    const pname = who==='1'?name1:name2;
    const months = PDB[who] || {};
    Object.keys(months).sort().forEach(k => {
      const md = months[k];
      if(!md) return;
      (md.expenses||[]).forEach(e => {
        const isSub = !!e.isSubSeed;
        const skipped = isSub && md.skips && md.skips[e.subId] ? 'yes' : '';
        let amt = parseFloat(e.amount)||0;
        if(!amt && isSub){
          const t = (PSUBS[who]||[]).find(s=>s.id===e.subId);
          if(t) amt = parseFloat(t.amount)||0;
        }
        rows.push([
          isSub?'Subscription':'Expense', pname, k, e.date||'', e.desc||'',
          e.cat||'', pname, e.payment||'', amt.toFixed(2), e.notes||'', skipped
        ]);
      });
      (md.credits||[]).forEach(c => {
        rows.push([
          'Credit',pname,k,c.date||'',c.desc||'','',pname,c.payment||'',
          (parseFloat(c.amount)||0).toFixed(2), c.notes||'', ''
        ]);
      });
    });
  });

  const csv = rows.map(r => r.map(escapeCSV).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0,10);
  a.href = url; a.download = `family-budget-export-${ts}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('CSV exported ✓');
}

function confirmImportClick(btn){
  confirmDel(btn,()=>document.getElementById('import-file').click());
}

async function importJSON(input){
  const file = input.files[0];
  if(!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if(!data.meta || !data.months){
      showToast('Import cancelled: not a Family Budget backup');
      input.value='';
      return;
    }

    showToast('Importing…');

    // Restore in-memory state
    name1 = data.meta.name1 || 'Person 1';
    name2 = data.meta.name2 || 'Person 2';
    RECUR = data.meta.recur || [];
    rOpen = data.meta.rOpen !== false;
    cOpen = data.meta.cOpen === true;
    eOpen = data.meta.eOpen !== false;
    DB = data.months || {};
    PSUBS = (data.persMeta && data.persMeta.subs) || {'1':[],'2':[]};
    persSubOpen = (data.persMeta && data.persMeta.subOpen) || {'1':true,'2':true};
    PDB = (data.personal) || {'1':{},'2':{}};
    if(!PDB['1']) PDB['1']={};
    if(!PDB['2']) PDB['2']={};

    // Update UI immediately
    document.getElementById('name1').value = name1;
    document.getElementById('name2').value = name2;

    // Write everything to Firebase
    if(window._fbSet && _familyId){
      setSyncing();
      const writes = [];
      writes.push(window._fbSet(_famPath('budget/meta'), {name1,name2,recur:RECUR,rOpen,cOpen,eOpen}));
      writes.push(window._fbSet(_famPath('persMeta/data'), {subs:PSUBS, subOpen:persSubOpen}));
      Object.keys(DB).forEach(k => {
        writes.push(window._fbSet(_famPath('months/'+k), {data: JSON.stringify(DB[k]), ts: Date.now()}));
      });
      ['1','2'].forEach(who => {
        Object.keys(PDB[who]||{}).forEach(k => {
          writes.push(window._fbSet(_famPath('personal_'+who+'/'+k), {data: JSON.stringify(PDB[who][k]), ts: Date.now()}));
        });
      });
      const results = await Promise.all(writes);
      const allOk = results.every(Boolean);
      allOk ? setSynced() : setSyncError();
    }

    // Refresh localStorage cache
    try{
      _cacheSet('meta', JSON.stringify({name1,name2,recur:RECUR,rOpen,cOpen,eOpen}));
      _cacheSet('pers_meta', JSON.stringify({subs:PSUBS,subOpen:persSubOpen}));
      Object.keys(DB).forEach(k => _cacheSet(k, JSON.stringify(DB[k])));
      ['1','2'].forEach(who => {
        Object.keys(PDB[who]||{}).forEach(k => {
          _cacheSet('p'+who+'_'+k, JSON.stringify(PDB[who][k]));
        });
      });
    }catch(e){ console.warn('localStorage cache refresh failed', e); }

    render();
    showToast('Import complete ✓');
  } catch(err) {
    console.error('Import failed:', err);
    showToast('Import failed: ' + err.message);
  } finally {
    input.value='';
  }
}

/* ════════════════════════════════════════════════
   KEYBOARD SUPPORT FOR PIN
════════════════════════════════════════════════ */
document.addEventListener('keydown',e=>{
  if(!document.getElementById('pin-screen').classList.contains('show')) return;
  if(e.key>='0'&&e.key<='9') pinKey(e.key);
  else if(e.key==='Backspace') pinDel();
});

/* ════════════════════════════════════════════════
   AUTH + FAMILY FLOW
════════════════════════════════════════════════ */
function showScreen(name){
  // 'auth' | 'family' | 'pin' | 'app'
  const a=document.getElementById('auth-screen');
  const f=document.getElementById('family-screen');
  const p=document.getElementById('pin-screen');
  const app=document.getElementById('app');
  a.classList.toggle('show', name==='auth');
  f.classList.toggle('show', name==='family');
  p.classList.toggle('show', name==='pin');
  app.classList.toggle('unlocked', name==='app');
}

function authShowError(msg, where){
  const el=document.getElementById(where||'auth-err');
  if(el) el.textContent=msg||'';
}
function _friendlyAuthError(e){
  const code=(e&&e.code)||'';
  if(code==='auth/invalid-email')           return 'That email address looks invalid.';
  if(code==='auth/missing-email')           return 'Please enter your email.';
  if(code==='auth/quota-exceeded')          return 'Too many requests — try again later.';
  if(code==='auth/too-many-requests')       return 'Too many attempts — wait a moment, then try again.';
  if(code==='auth/network-request-failed')  return 'Network error — check your connection.';
  if(code==='auth/invalid-action-code')     return 'This sign-in link is invalid or already used.';
  if(code==='auth/expired-action-code')     return 'This sign-in link has expired. Request a new one.';
  if(code==='permission-denied')            return 'Permission denied. Try signing out and back in.';
  return (e&&e.message)||'Something went wrong. Try again.';
}

// iOS standalone PWA detection — used to show paste-link affordance.
// Email-link auth can't reach a PWA on iOS (iOS routes external URLs to Safari only),
// so the PWA needs a manual paste flow to complete sign-in in its own storage scope.
const _isIOSPWA = (typeof navigator!=='undefined' && navigator.standalone === true);

// Stash for cross-device confirm flow (3d) — when email link is opened on a device
// without the originating email in localStorage, we need to ask the user for it.
let _pendingAuthLink = null;

function authStageInput(){
  document.getElementById('auth-stage-input').style.display='flex';
  document.getElementById('auth-stage-sent').style.display='none';
  document.getElementById('auth-stage-completing').style.display='none';
  const cf=document.getElementById('auth-stage-confirm-email'); if(cf) cf.style.display='none';
}
function authStageSent(email){
  document.getElementById('auth-stage-input').style.display='none';
  document.getElementById('auth-stage-sent').style.display='flex';
  document.getElementById('auth-stage-completing').style.display='none';
  const cf=document.getElementById('auth-stage-confirm-email'); if(cf) cf.style.display='none';
  document.getElementById('auth-sent-email').textContent=email;
  // Reveal paste-link section + PWA warning only when running as an iOS standalone PWA.
  // Hide the non-PWA hint in that case (it tells users to tap the link, which would break the flow).
  const ps=document.getElementById('auth-paste-section');
  const warn=document.getElementById('auth-pwa-warning');
  const hint=document.getElementById('auth-non-pwa-hint');
  if(ps)   ps.style.display   = _isIOSPWA ? 'flex' : 'none';
  if(warn) warn.style.display = _isIOSPWA ? 'block' : 'none';
  if(hint) hint.style.display = _isIOSPWA ? 'none' : 'block';
}
function authStageCompleting(){
  document.getElementById('auth-stage-input').style.display='none';
  document.getElementById('auth-stage-sent').style.display='none';
  document.getElementById('auth-stage-completing').style.display='flex';
  const cf=document.getElementById('auth-stage-confirm-email'); if(cf) cf.style.display='none';
}
function authStageConfirmEmail(){
  document.getElementById('auth-stage-input').style.display='none';
  document.getElementById('auth-stage-sent').style.display='none';
  document.getElementById('auth-stage-completing').style.display='none';
  const cf=document.getElementById('auth-stage-confirm-email');
  if(cf) cf.style.display='flex';
  const errEl=document.getElementById('auth-confirm-err'); if(errEl) errEl.textContent='';
  const inp=document.getElementById('auth-confirm-email');
  if(inp){ inp.value=''; setTimeout(()=>{ try{ inp.focus(); }catch(e){} }, 50); }
}
function authResetToInput(){
  try{ localStorage.removeItem('bgt_auth_email'); }catch(e){}
  authShowError('');
  // Clear paste textarea if present
  const pl=document.getElementById('auth-paste-link');
  if(pl) pl.value='';
  _pendingAuthLink = null;
  authStageInput();
}
function authCancelConfirmEmail(){
  _pendingAuthLink = null;
  // Clean URL so the cancelled link doesn't auto-retry on refresh
  if(history.replaceState){
    history.replaceState({}, document.title, window.location.origin+window.location.pathname);
  }
  authStageInput();
}

async function authConfirmEmailAndComplete(){
  const errEl = document.getElementById('auth-confirm-err');
  if(errEl) errEl.textContent = '';
  const emailEl = document.getElementById('auth-confirm-email');
  const email = (emailEl.value||'').trim().toLowerCase();
  if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    if(errEl) errEl.textContent = 'Enter a valid email address.';
    return;
  }
  if(!_pendingAuthLink){
    if(errEl) errEl.textContent = 'Sign-in link expired. Please request a new one.';
    return;
  }
  const btn = document.getElementById('auth-confirm-btn');
  if(btn){ btn.disabled = true; btn.textContent = 'Signing in…'; }
  try{
    authStageCompleting();
    await window._authComplete(email, _pendingAuthLink);
    try{ localStorage.removeItem('bgt_auth_email'); }catch(e){}
    if(history.replaceState){
      history.replaceState({}, document.title, window.location.origin+window.location.pathname);
    }
    _pendingAuthLink = null;
    // _authOnState fires next and routes to family/PIN/app
  }catch(e){
    console.error('Confirm-email complete failed:', e);
    authStageConfirmEmail();
    if(errEl) errEl.textContent = _friendlyAuthError(e);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = 'Continue sign-in'; }
  }
}

async function authCompleteFromPaste(){
  authShowError('');
  const linkEl=document.getElementById('auth-paste-link');
  const link=(linkEl.value||'').trim();
  if(!link){
    authShowError('Paste the sign-in link first');
    return;
  }
  if(!window._authIsLink || !window._authIsLink(link)){
    authShowError("That doesn't look like a valid sign-in link. Make sure you copied the full URL from the email.");
    return;
  }
  let email=null;
  try{ email=localStorage.getItem('bgt_auth_email'); }catch(e){}
  if(!email){
    authShowError('Email not found in this app — tap "Use a different email" and resend the link.');
    return;
  }
  authStageCompleting();
  try{
    await window._authComplete(email, link);
    try{ localStorage.removeItem('bgt_auth_email'); }catch(e){}
    // No URL to clean — paste flow doesn't put params in window.location
    // _authOnState fires next and routes to family/PIN/app
  }catch(e){
    console.error('Paste complete failed:', e);
    authShowError(_friendlyAuthError(e));
    authStageSent(email); // back to sent stage so user can retry
  }
}

async function authSendLink(){
  authShowError('');
  const emailEl=document.getElementById('auth-email');
  const sendBtn=document.getElementById('auth-send-btn');
  const email=(emailEl.value||'').trim().toLowerCase();
  if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    authShowError('Enter a valid email address');
    return;
  }
  sendBtn.disabled=true;
  sendBtn.textContent='Sending…';
  try{
    const redirect=window.location.origin+window.location.pathname;
    await window._authSendLink(email, redirect);
    try{ localStorage.setItem('bgt_auth_email', email); }catch(e){}
    authStageSent(email);
  }catch(e){
    console.error('Send link failed:', e);
    authShowError(_friendlyAuthError(e));
  }finally{
    sendBtn.disabled=false;
    sendBtn.textContent='Send sign-in link';
  }
}

async function authCompleteFromUrl(){
  if(!window._authIsLink||!window._authIsLink(window.location.href)) return false;
  let email=null;
  try{ email=localStorage.getItem('bgt_auth_email'); }catch(e){}
  if(!email){
    // Different device — stash the link, hand off to confirm-email stage (3d).
    // Use proper in-screen UI instead of a browser prompt.
    _pendingAuthLink = window.location.href;
    authStageConfirmEmail();
    return false;
  }
  authStageCompleting();
  try{
    await window._authComplete(email, window.location.href);
    try{ localStorage.removeItem('bgt_auth_email'); }catch(e){}
    // Clean URL — strip the email-link query params
    if(history.replaceState){
      history.replaceState({}, document.title, window.location.origin+window.location.pathname);
    }
    return true;
  }catch(e){
    console.error('Complete sign-in failed:', e);
    authShowError(_friendlyAuthError(e));
    authStageInput();
    return false;
  }
}

function genFamilyId(){
  const chars='abcdefghijklmnopqrstuvwxyz0123456789';
  let s='fam_';
  for(let i=0;i<12;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}

async function lookupFamily(uid){
  if(!window._fbGet) return null;
  const data=await window._fbGet('userFamilies/'+uid);
  const fid=(data&&data.familyId)||null;
  return isSafeFamilyId(fid) ? fid : null;
}

async function verifyFamilyMembership(fid, uid){
  if(!isSafeFamilyId(fid)||!uid) return {status:'not-member'};
  if(window._fbGetStatus){
    const res=await window._fbGetStatus('families/'+fid+'/members/'+uid);
    if(!res.ok) return {status:'unknown', error:res.error};
    return {status:res.exists?'member':'not-member', member:res.data};
  }
  if(!window._fbGet) return {status:'unknown'};
  const member=await window._fbGet('families/'+fid+'/members/'+uid);
  return {status:member?'member':'not-member', member};
}

async function clearInvalidFamilyAccess(fid, uid, opts={}){
  clearFamilyCache(fid);
  try{
    if(localStorage.getItem('bgt_family_id')===fid) localStorage.removeItem('bgt_family_id');
    if(localStorage.getItem('bgt_uid')===uid) localStorage.removeItem('bgt_uid');
  }catch(e){}
  if(opts.deleteRoute&&window._fbDelete&&uid){
    try{ await window._fbDelete('userFamilies/'+uid); }catch(e){}
  }
  if(_familyId===fid) _familyId=null;
  DB={}; PDB={'1':{},'2':{}};
  RECUR=[]; PSUBS={'1':[],'2':[]};
}

async function recoverKnownFamilyRoute(uid){
  if(!uid||!window._fbSet) return null;
  for(const fid of FAMILY_RECOVERY_IDS){
    const check=await verifyFamilyMembership(fid, uid);
    if(check.status==='member'){
      const ok=await window._fbSet('userFamilies/'+uid, {familyId:fid, recoveredAt:Date.now()});
      if(ok) return fid;
      if(window._fbDelete){
        try{
          await window._fbDelete('userFamilies/'+uid);
          const retryOk=await window._fbSet('userFamilies/'+uid, {familyId:fid, recoveredAt:Date.now()});
          if(retryOk) return fid;
        }catch(e){ console.warn('Family route recovery retry failed:', e); }
      }
    }
  }
  return null;
}

async function createFamilyForUser(uid, email){
  if(!window._fbSet) throw new Error('Firebase not ready');
  const newFamId=genFamilyId();
  // Order matters — rules require membership for family writes.
  // 1) Create membership doc (rule allows when request.auth.uid === uid)
  const memOk=await window._fbSet('families/'+newFamId+'/members/'+uid, {
    email: email||null, role: 'owner', addedAt: Date.now()
  });
  if(!memOk) throw new Error('Could not create membership');
  // 2) Create userFamilies routing doc
  const routeOk=await window._fbSet('userFamilies/'+uid, {
    familyId: newFamId, createdAt: Date.now()
  });
  if(!routeOk) throw new Error('Could not create user→family link');
  // 3) Seed family meta with defaults (now allowed — user is a member)
  const metaOk=await window._fbSet('families/'+newFamId+'/budget/meta', {
    name1:'Person 1', name2:'Person 2', recur:[],
    rOpen:true, cOpen:false, eOpen:true,
    createdAt: Date.now()
  });
  if(!metaOk) throw new Error('Could not create family meta');
  return newFamId;
}

async function authCreateFamilyClick(){
  authShowError('', 'family-err');
  if(!_currentUser){
    authShowError('Not signed in.', 'family-err');
    return;
  }
  const btn=document.getElementById('family-create-btn');
  btn.disabled=true;
  btn.textContent='Creating…';
  try{
    const famId=await createFamilyForUser(_currentUser.uid, _currentUser.email);
    _familyId=famId;
    try{ localStorage.setItem('bgt_family_id', famId); localStorage.setItem('bgt_uid', _currentUser.uid); }catch(e){}
    cleanupLegacyCache();
    await proceedToApp();
  }catch(e){
    console.error('Create family failed:', e);
    authShowError(_friendlyAuthError(e), 'family-err');
  }finally{
    btn.disabled=false;
    btn.textContent='Create new family';
  }
}

async function signOutClick(){
  // Tear down listeners first so we don't get permission-denied bursts after sign-out
  try{ stopListeners(); }catch(e){}
  if(_invitesUnsub){ try{ _invitesUnsub(); }catch(e){} _invitesUnsub=null; }
  // Clear cached state
  try{
    Object.keys(localStorage).forEach(k=>{
      if(k.startsWith('bgt_')) localStorage.removeItem(k);
    });
    sessionStorage.removeItem('bgt_unlocked');
  }catch(e){}
  // Reset in-memory state
  _familyId=null;
  _currentUser=null;
  _familyMembers=[];
  _pendingInvites=[];
  _isOwner=false;
  DB={}; PDB={'1':{},'2':{}};
  RECUR=[]; PSUBS={'1':[],'2':[]};
  name1='Person 1'; name2='Person 2';
  rOpen=true; cOpen=false; eOpen=true;
  persSubOpen={'1':true,'2':true};
  // Reset PIN state so the next sign-in lands cleanly on unlock mode
  pinMode='unlock'; pinEntry=''; pinNewFirst='';
  // Sign out from Firebase
  try{ if(window._authSignOut) await window._authSignOut(); }catch(e){ console.warn('Sign-out:', e); }
  // Reset UI
  const ae=document.getElementById('account-email'); if(ae) ae.textContent='—';
  // Clear family UI
  const memEl=document.getElementById('fam-members'); if(memEl) memEl.innerHTML='';
  const pendingEl=document.getElementById('fam-pending-list'); if(pendingEl) pendingEl.innerHTML='';
  const invSec=document.getElementById('fam-invite-section'); if(invSec) invSec.style.display='none';
  const leaveBtn=document.getElementById('fam-leave-btn'); if(leaveBtn) leaveBtn.style.display='none';
  authResetToInput();
  showScreen('auth');
}

// 3h: split data loading from screen-show so PIN screen appears immediately after auth+family
// resolve. Data loads run in parallel and the in-progress promise is awaited if the user enters
// their PIN before loads complete. Also collapse-all on first paint.
let _dataLoaded = false;
let _dataLoadPromise = null;

async function startDataLoad(){
  _dataLoaded = false;
  _dataLoadPromise = (async () => {
    await loadAll();
    await loadPersonal();
    getMD(Y,M); seedMonth(Y,M);
    // 3f: collapse all rows on first paint so the app opens scannable.
    collapseAllForCurrentData();
    render();
    startListeners();
    _dataLoaded = true;
    // Hide loader and restore default subtitle once data is ready
    const ld = document.getElementById('pin-loader');
    if(ld) ld.classList.remove('show');
    const subtitle = document.getElementById('pin-subtitle');
    if(subtitle && pinMode === 'unlock' && subtitle.textContent === 'Loading your budget…'){
      subtitle.textContent = 'Enter your PIN to continue';
    }
  })();
  return _dataLoadPromise;
}

async function proceedToApp(){
  // Reset PIN state ONLY if it's in a non-unlock mode (stale from a previous incomplete
  // change-PIN attempt). On fresh page load pinMode is already 'unlock' so we skip the reset
  // and preserve any keys the user has already tapped while the screen was loading.
  if(pinMode !== 'unlock'){
    pinMode = 'unlock';
    pinEntry = '';
    pinNewFirst = '';
    const subtitle = document.getElementById('pin-subtitle');
    if(subtitle) subtitle.textContent = 'Enter your PIN to continue';
    const hint = document.getElementById('pin-change-hint');
    if(hint){ hint.style.display = 'none'; hint.textContent = ''; }
    const cb = document.getElementById('pin-change-btn');
    if(cb) cb.textContent = 'Change PIN';
    const errEl = document.getElementById('pin-err');
    if(errEl) errEl.textContent = '';
    updateDots(false);
  }

  // _familyId is set. Kick off data loads, but DON'T await before showing PIN.
  // 3g: silent token refresh — fire-and-forget; signals iOS that storage is active,
  // and surfaces revoked tokens early (onAuthStateChanged will fire with null on revocation).
  if(_currentUser && typeof _currentUser.getIdToken === 'function'){
    _currentUser.getIdToken(true).catch(e => console.warn('Token refresh failed:', e.code, e.message));
  }
  startDataLoad();
  // Update account email
  const ae=document.getElementById('account-email');
  if(ae && _currentUser) ae.textContent=_currentUser.email||_currentUser.uid;
  // PIN gate (session-scoped bypass)
  if(sessionStorage.getItem('bgt_unlocked')==='1'){
    // Already unlocked — wait for data, then show app
    await _dataLoadPromise;
    showScreen('app');
  } else {
    // Show PIN immediately; data continues loading in background.
    // Visual reassurance: shimmer bar at top + "Loading your budget…" subtitle so users
    // know something is happening rather than wondering if the keypad is frozen.
    showScreen('pin');
    if(!_dataLoaded){
      const ld = document.getElementById('pin-loader');
      if(ld) ld.classList.add('show');
      const subtitle = document.getElementById('pin-subtitle');
      if(subtitle && pinMode === 'unlock') subtitle.textContent = 'Loading your budget…';
    }
  }
}

async function handleAuthState(user){
  if(!user){
    // Signed out
    _currentUser=null;
    _familyId=null;
    _familyMembers=[];
    _isOwner=false;
    try{ localStorage.removeItem('bgt_family_id'); localStorage.removeItem('bgt_uid'); }catch(e){}
    const ae=document.getElementById('account-email'); if(ae) ae.textContent='—';
    showScreen('auth');
    authStageInput();
    return;
  }
  _currentUser=user;
  // Try cached family ID first (offline-friendly)
  let famId=null;
  try{
    const cachedUid=localStorage.getItem('bgt_uid')||null;
    const cachedFamId=cachedUid===user.uid ? (localStorage.getItem('bgt_family_id')||null) : null;
    famId=isSafeFamilyId(cachedFamId) ? cachedFamId : null;
    if(cachedFamId && !famId) localStorage.removeItem('bgt_family_id');
  }catch(e){}
  if(!famId){
    try{ famId=await lookupFamily(user.uid); }catch(e){ console.warn('Family lookup:', e); }
  }
  if(!famId){
    try{ famId=await recoverKnownFamilyRoute(user.uid); }catch(e){ console.warn('Family route recovery:', e); }
  }
  if(famId){
    const membership=await verifyFamilyMembership(famId, user.uid);
    if(membership.status==='member'){
      _familyId=famId;
      try{ localStorage.setItem('bgt_family_id', famId); localStorage.setItem('bgt_uid', user.uid); }catch(e){}
      cleanupLegacyCache();
      await proceedToApp();
      return;
    }
    if(membership.status==='unknown'){
      console.warn('Family membership check inconclusive; preserving route for retry:', famId, membership.error);
      authShowError('Family access could not be verified. Check your connection and try again.', 'family-err');
      showScreen('family');
      return;
    }
    console.warn('Family membership missing; clearing local cached family access:', famId);
    await clearInvalidFamilyAccess(famId, user.uid, {deleteRoute:false});
  }
  // No family — check for pending invites against this user's email
  let inviteLookupMsg='';
  if(user.email){
    try{
      const accepted = await acceptPendingInviteIfAny(user.uid, user.email);
      if(accepted){
        _familyId = accepted;
        try{ localStorage.setItem('bgt_family_id', accepted); localStorage.setItem('bgt_uid', user.uid); }catch(e){}
        cleanupLegacyCache();
        await proceedToApp();
        return;
      }
    }catch(e){
      console.warn('Pending invite check failed:', e);
      inviteLookupMsg='Could not check pending invites. Check connection, Firestore rules, or ask for a fresh invite.';
    }
  }
  // Still no family — first-time-user flow
  const fue=document.getElementById('family-user-email');
  if(fue) fue.textContent=user.email||user.uid;
  authShowError(inviteLookupMsg || (famId?'Your family access could not be verified. Ask the owner for a new invite, or create a new family.':''), 'family-err');
  showScreen('family');
}

/* ════════════════════════════════════════════════
   FAMILY MEMBERS + INVITES (Session 3c)
════════════════════════════════════════════════ */

// Called from handleAuthState. Looks for a pending invite matching this user's email
// across all families. If found, joins the family and deletes the invite.
async function acceptPendingInviteIfAny(uid, email){
  if(!email) return null;
  const lc = email.toLowerCase();
  // Pending invites are stored at families/{fid}/pendingInvites/{email-lowercased}
  // with `email` field also denormalized for queryability.
  let invites = [];
  let groupLookupFailed = false;
  if(window._fbQueryGroupStatus){
    const res = await window._fbQueryGroupStatus('pendingInvites', 'email', lc);
    if(res.ok) invites = res.docs || [];
    else groupLookupFailed = true;
  } else if(window._fbQueryGroup){
    invites = await window._fbQueryGroup('pendingInvites', 'email', lc);
  }

  // Tactical fallback for the current family: direct doc read avoids collectionGroup
  // index/rules surprises and still requires the signed-in email to match the invite doc.
  if(!invites || invites.length === 0){
    for(const fid of FAMILY_RECOVERY_IDS){
      if(!isSafeFamilyId(fid) || !window._fbGetStatus) continue;
      const path='families/'+fid+'/pendingInvites/'+lc;
      const direct=await window._fbGetStatus(path);
      if(direct.ok && direct.exists){
        invites = [{id:lc, path, ...direct.data}];
        break;
      }
    }
  }

  if(!invites || invites.length === 0){
    if(groupLookupFailed) throw new Error('Pending invite lookup failed');
    return null;
  }
  if(groupLookupFailed){
    console.warn('Pending invite collectionGroup lookup failed; accepted via direct known-family fallback.');
  }
  // Pick the first one (in practice should only ever be one — invitations are exclusive per email)
  const invite = invites[0];
  // Path looks like: families/{fid}/pendingInvites/{email}
  const parts = invite.path.split('/');
  if(parts.length !== 4 || parts[0] !== 'families' || parts[2] !== 'pendingInvites') return null;
  const fid = parts[1];
  if(!isSafeFamilyId(fid)) return null;
  // 1) Create self-membership doc (rules allow because request.auth.uid == uid)
  const memOk = await window._fbSet('families/'+fid+'/members/'+uid, {
    email: email, role: 'member', addedAt: Date.now()
  });
  if(!memOk) return null;
  // 2) Create userFamilies routing doc
  const routeOk = await window._fbSet('userFamilies/'+uid, {
    familyId: fid, createdAt: Date.now()
  });
  if(!routeOk) return null;
  // 3) Delete the pending invite (rules allow because we're now a member)
  try{ await window._fbDelete(invite.path); }catch(e){ console.warn('Delete invite failed:', e); }
  return fid;
}

async function loadPendingInvites(){
  if(!_familyId || !_isOwner) return;
  // Direct subcollection listen via collection helper
  if(!window._fbListenCollection) return;
  if(_invitesUnsub) return; // already listening
  _invitesUnsub = window._fbListenCollection(_famPath('pendingInvites'), invites=>{
    _pendingInvites = invites;
    renderFamilySection();
  });
}

let _pendingInvites = [];
let _invitesUnsub = null;

function renderFamilySection(){
  const memEl = document.getElementById('fam-members');
  const inviteSection = document.getElementById('fam-invite-section');
  const leaveBtn = document.getElementById('fam-leave-btn');
  const pendingEl = document.getElementById('fam-pending-list');
  if(!memEl) return;
  // Sort: owner first, then by addedAt
  const sorted = [..._familyMembers].sort((a,b)=>{
    if(a.role==='owner' && b.role!=='owner') return -1;
    if(b.role==='owner' && a.role!=='owner') return 1;
    return (a.addedAt||0)-(b.addedAt||0);
  });
  const myUid = _currentUser && _currentUser.uid;
  memEl.innerHTML = sorted.map(m => {
    const isYou = m.uid === myUid;
    const canRemove = _isOwner && !isYou; // owner can remove others, not self
    return `<div class="fam-member ${isYou?'is-you':''}">
      <div class="fam-member-info">
        <span class="fam-member-email">${esc(m.email||'(unknown)')}${isYou?' (you)':''}</span>
        <span class="fam-member-role ${m.role==='owner'?'owner':''}">${esc(m.role||'member')}</span>
      </div>
      ${canRemove?`<button class="fam-member-action fam-remove-member" data-uid="${esc(m.uid)}" data-email="${esc(m.email||'')}">Remove</button>`:''}
    </div>`;
  }).join('');
  // Invite section + pending list — owner only
  if(inviteSection) inviteSection.style.display = _isOwner ? 'flex' : 'none';
  // Leave button — non-owner only (owner can't leave their own family without transferring; out of scope here)
  if(leaveBtn) leaveBtn.style.display = (_familyMembers.length > 0 && !_isOwner) ? 'inline-block' : 'none';
  // Pending invites
  if(pendingEl){
    if(_pendingInvites.length === 0){
      pendingEl.innerHTML = '';
    } else {
      pendingEl.innerHTML = _pendingInvites.map(inv => {
        const when = inv.invitedAt ? new Date(inv.invitedAt).toLocaleDateString() : '';
        return `<div class="fam-pending">
          <div class="fam-pending-info">
            <span class="fam-pending-email">${esc(inv.email||inv.id||'')}</span>
            <span class="fam-pending-meta">Pending${when?' · sent '+when:''}</span>
          </div>
          <button class="fam-member-action fam-revoke-invite" data-invite-id="${esc(inv.id)}">Revoke</button>
        </div>`;
      }).join('');
    }
  }
}

document.addEventListener('click', e=>{
  const target=e.target;
  if(!(target instanceof Element)) return;
  const removeBtn=target.closest('.fam-remove-member');
  if(removeBtn){
    e.preventDefault();
    confirmDel(removeBtn,()=>removeMember(removeBtn.dataset.uid||'', removeBtn.dataset.email||''));
    return;
  }
  const revokeBtn=target.closest('.fam-revoke-invite');
  if(revokeBtn){
    e.preventDefault();
    confirmDel(revokeBtn,()=>revokeInvite(revokeBtn.dataset.inviteId||''));
  }
});

function _famSetMsg(text, kind){
  const el = document.getElementById('fam-msg');
  if(!el) return;
  el.textContent = text || '';
  el.classList.remove('err','ok');
  if(kind) el.classList.add(kind);
  if(text) setTimeout(()=>{ if(el.textContent===text){ el.textContent=''; el.classList.remove('err','ok'); } }, 4000);
}

async function inviteMember(){
  _famSetMsg('');
  if(!_isOwner){ _famSetMsg('Only the family owner can invite people.', 'err'); return; }
  const input = document.getElementById('fam-invite-email');
  const btn = document.getElementById('fam-invite-btn');
  const email = (input.value||'').trim().toLowerCase();
  if(!isValidInviteEmail(email)){
    _famSetMsg('Enter a valid email address.', 'err'); return;
  }
  if(email === (_currentUser && _currentUser.email || '').toLowerCase()){
    _famSetMsg("That's your own email.", 'err'); return;
  }
  if(_familyMembers.find(m => (m.email||'').toLowerCase() === email)){
    _famSetMsg('That person is already in this family.', 'err'); return;
  }
  btn.disabled = true; btn.textContent = 'Saving…';
  try{
    // Doc ID = email so duplicate invites overwrite. Email field denormalized for collectionGroup query.
    const ok = await window._fbSet(_famPath('pendingInvites/'+email), {
      email: email,
      familyId: _familyId,
      invitedBy: _currentUser.uid,
      invitedByEmail: _currentUser.email || null,
      invitedAt: Date.now()
    });
    if(!ok){ _famSetMsg('Could not create invite. Check Firestore rules.', 'err'); return; }
    input.value = '';
    _famSetMsg('Invite saved. No email is sent; have them sign in with this exact email.', 'ok');
  } catch(e){
    console.error('Invite failed:', e);
    _famSetMsg(e.message || 'Invite failed.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Send invite';
  }
}

async function revokeInvite(emailId){
  _famSetMsg('');
  if(!_isOwner){ _famSetMsg('Only the family owner can revoke invites.', 'err'); return; }
  try{
    const ok = await window._fbDelete(_famPath('pendingInvites/'+emailId));
    if(!ok){ _famSetMsg('Could not revoke invite.', 'err'); return; }
    _famSetMsg('Invite revoked.', 'ok');
  }catch(e){
    console.error('Revoke failed:', e);
    _famSetMsg(e.message || 'Revoke failed.', 'err');
  }
}

async function removeMember(uid, email){
  _famSetMsg('');
  if(!_isOwner){ _famSetMsg('Only the family owner can remove members.', 'err'); return; }
  if(uid === _currentUser.uid){ _famSetMsg("You can't remove yourself.", 'err'); return; }
  try{
    // Remove member doc + their userFamilies routing doc
    const memOk = await window._fbDelete('families/'+_familyId+'/members/'+uid);
    if(!memOk){ _famSetMsg('Could not remove member from family.', 'err'); return; }
    // Best-effort: clear their userFamilies. Rules may deny if they're not the caller — that's OK,
    // when they next sign in they'll see no family + no pending invite, treated as new user.
    try{ await window._fbDelete('userFamilies/'+uid); }catch(e){}
    _famSetMsg(email + ' removed from family.', 'ok');
  }catch(e){
    console.error('Remove member failed:', e);
    _famSetMsg(e.message || 'Remove failed.', 'err');
  }
}

async function leaveFamilyClick(){
  _famSetMsg('');
  if(_isOwner){ _famSetMsg("Owners can't leave. Transfer ownership first (not yet implemented).", 'err'); return; }
  try{
    // Remove our own member doc
    const memOk = await window._fbDelete('families/'+_familyId+'/members/'+_currentUser.uid);
    if(!memOk){ _famSetMsg('Could not leave family.', 'err'); return; }
    // Remove our userFamilies routing doc
    try{ await window._fbDelete('userFamilies/'+_currentUser.uid); }catch(e){}
    // Sign out (clean teardown)
    await signOutClick();
  }catch(e){
    console.error('Leave family failed:', e);
    _famSetMsg(e.message || 'Leave failed.', 'err');
  }
}

/* ════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════ */
document.getElementById('prevMonth').addEventListener('click',()=>changeMonth(-1));
document.getElementById('nextMonth').addEventListener('click',()=>changeMonth(1));

(async function(){
  console.log('Family Budget v' + APP_VERSION);
  const dtv = document.getElementById('dt-version');
  if(dtv) dtv.textContent = APP_VERSION;

  // Best-effort cached display name (will be overridden after family resolved)
  try{
    const m=JSON.parse(_cacheGet('meta')||'{}');
    name1=m.name1||'Person 1'; name2=m.name2||'Person 2';
    RECUR=m.recur||[];
    document.getElementById('name1').value=name1;
    document.getElementById('name2').value=name2;
  }catch(e){}

  const n=new Date(); Y=n.getFullYear(); M=n.getMonth();
  try{
    const params=new URLSearchParams(window.location.search);
    const devTestEnabled=params.has('test')||window.location.hash==='#test';
    const testBtn=document.getElementById('dev-test-btn');
    if(testBtn) testBtn.style.display=devTestEnabled?'inline-flex':'none';
    if(devTestEnabled) runDevTests();
  }catch(e){ console.warn('Dev test bootstrap failed:', e); }

  // Wait for Firebase module to register globals
  await new Promise(res=>{
    if(window._auth) return res();
    window.addEventListener('fb-ready', res, {once:true});
    setTimeout(res, 3000); // proceed after 3s even if SDK is slow
  });

  if(!window._auth){
    console.error('Firebase Auth did not load. App will not work offline-only.');
    showScreen('auth');
    return;
  }

  // If returning from an email-link click, complete sign-in first
  await authCompleteFromUrl();

  // Subscribe to auth state — drives the rest of the UI
  window._authOnState(user => { handleAuthState(user); });
})();
