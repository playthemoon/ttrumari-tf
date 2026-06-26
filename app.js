// ============================================================
// 뚜루마리 TF 발걸음 — 메인 로직
// ============================================================

const CHANNEL_ID = "UCgIwZtsiqMv8T1uIbh0yPSQ";
const YT_API_KEY_STORAGE_KEY = "turumari_yt_api_key";
const PROGRESS_STORAGE_KEY = "turumari_progress_v1";
const SB_STORAGE_KEY = "turumari_sb_local_v1";
const VIDEO_URL_STORAGE_KEY = "turumari_video_urls_v1";
const VIEW_MODE_STORAGE_KEY = "turumari_view_mode_v1";
const OPS_STORAGE_KEY = "turumari_ops_tasks_v1";
const EP_OVERRIDE_STORAGE_KEY = "turumari_ep_overrides_v1";

// ------------------------------------------------------------
// GitHub 공유 저장소 설정
// ------------------------------------------------------------
const GH_OWNER = "playthemoon";
const GH_REPO = "ttrumari-tf";
const GH_BRANCH = "main";
const GH_DATA_PATH = "data-store.json";
const GH_TOKEN_STORAGE_KEY = "turumari_gh_token";
let ghSyncState = { status: "idle", lastError: null, lastSyncedAt: null }; // idle | loading | saving | error
let ghFileSha = null; // 현재 data-store.json의 sha (덮어쓰기 시 필요)

const STEP_DEFS_LONGFORM = [
  { key: "planner", label: "기획", icon: "✏️" },
  { key: "image",   label: "이미지", icon: "🎨" },
  { key: "video",   label: "영상", icon: "🎬" },
  { key: "done",    label: "완료", icon: "✅" },
];
const STEP_DEFS_SHORTS = [
  { key: "planner", label: "기획", icon: "✏️" },
  { key: "video",   label: "영상", icon: "🎬" },
  { key: "done",    label: "완료", icon: "✅" },
];

let state = {
  tab: "longform", // longform | shorts | rr
  filterPerson: null,
  progress: loadProgress(),
  sbLocal: loadSbLocal(),
  videoUrls: loadVideoUrls(),
  viewMode: loadViewMode(), // table | card
  ops: loadOps(),
  epOverrides: loadEpOverrides(),
};
let videoStatsCache = {}; // videoId -> {views, loading, error}

// ------------------------------------------------------------
// GitHub 공유 저장소 — 토큰 관리
// ------------------------------------------------------------
function getGhToken(){
  return localStorage.getItem(GH_TOKEN_STORAGE_KEY) || "";
}
function setGhToken(token){
  if(!token) localStorage.removeItem(GH_TOKEN_STORAGE_KEY);
  else localStorage.setItem(GH_TOKEN_STORAGE_KEY, token);
}

function collectSyncableState(){
  return {
    progress: state.progress,
    sbLocal: state.sbLocal,
    videoUrls: state.videoUrls,
    ops: state.ops,
    epOverrides: state.epOverrides,
  };
}
function applySyncedState(data){
  if(!data) return;
  if(data.progress) state.progress = data.progress;
  if(data.sbLocal) state.sbLocal = data.sbLocal;
  if(data.videoUrls) state.videoUrls = data.videoUrls;
  if(data.ops) state.ops = data.ops;
  if(data.epOverrides) state.epOverrides = data.epOverrides;
  // localStorage에도 캐시해서 오프라인/재방문 시 즉시 보이게
  saveProgress(); saveSbLocal(); saveVideoUrls(); saveOps(); saveEpOverrides();
}

// 두 상태를 병합: 키 단위로 "더 최근에 수정된 쪽"을 알 수 없으므로,
// 원격(remote)을 기준으로 하되 로컬에만 있는 항목은 보존 (단순 deep merge)
function mergeSyncState(remote, local){
  function mergeObj(r, l){
    if(!r) return l;
    if(!l) return r;
    const out = { ...r };
    Object.keys(l).forEach(k=>{
      if(!(k in out)) out[k] = l[k];
      else if(typeof out[k] === 'object' && typeof l[k] === 'object' && !Array.isArray(out[k]) && out[k]!==null && l[k]!==null){
        out[k] = mergeObj(out[k], l[k]);
      }
    });
    return out;
  }
  return {
    progress: mergeObj(remote.progress, local.progress),
    sbLocal: mergeObj(remote.sbLocal, local.sbLocal),
    videoUrls: mergeObj(remote.videoUrls, local.videoUrls),
    ops: mergeObj(remote.ops, local.ops),
    epOverrides: mergeObj(remote.epOverrides, local.epOverrides),
  };
}

let __ghPushTimer = null;
let __ghPushPending = null;
function ghPush(message){
  // 디바운스 없이 즉시 전송 (단, 짧은 연타는 마지막 메시지로 합쳐 보냄)
  __ghPushPending = message;
  if(__ghPushTimer) clearTimeout(__ghPushTimer);
  __ghPushTimer = setTimeout(()=>{
    __ghPushTimer = null;
    ghPushNow(__ghPushPending);
  }, 150);
}

async function ghFetchFile(){
  const token = getGhToken();
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_DATA_PATH}?ref=${GH_BRANCH}`;
  const headers = { Accept: "application/vnd.github+json" };
  if(token) headers.Authorization = `Bearer ${token}`; // 토큰 있으면 사용(레이트리밋 상향), 없어도 공개 repo라 읽기는 가능
  const res = await fetch(url, { headers });
  if(res.status === 404){ ghFileSha = null; return null; } // 파일이 아직 없음
  if(!res.ok){
    const body = await res.json().catch(()=>({}));
    throw new Error(body.message || `GitHub 응답 오류 (${res.status})`);
  }
  const json = await res.json();
  ghFileSha = json.sha;
  const decoded = decodeURIComponent(escape(atob(json.content.replace(/\n/g,''))));
  return JSON.parse(decoded);
}

async function ghSaveFile(dataObj, message){
  const token = getGhToken();
  if(!token) throw new Error("GitHub 토큰이 없어요");
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_DATA_PATH}`;
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(dataObj, null, 2))));
  const body = {
    message: message || "Update progress data",
    content,
    branch: GH_BRANCH,
  };
  if(ghFileSha) body.sha = ghFileSha;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if(!res.ok){
    const errBody = await res.json().catch(()=>({}));
    // sha 충돌(다른 사람이 그 사이 저장함) -> 한번 재시도 유도
    if(res.status === 409 || (errBody.message && errBody.message.includes('sha'))){
      throw new Error("CONFLICT");
    }
    throw new Error(errBody.message || `저장 실패 (${res.status})`);
  }
  const json = await res.json();
  ghFileSha = json.content.sha;
  return json;
}

// 원격에서 불러와서 로컬과 합친 뒤 화면에 반영 (저장은 하지 않음 — 읽기 전용 동기화)
async function ghPull(){
  ghSyncState.status = "loading";
  render();
  try{
    const remote = await ghFetchFile();
    if(remote){
      const merged = mergeSyncState(remote, collectSyncableState());
      applySyncedState(merged);
    }
    ghSyncState.status = "idle";
    ghSyncState.lastError = null;
    ghSyncState.lastSyncedAt = Date.now();
  }catch(e){
    ghSyncState.status = "error";
    ghSyncState.lastError = e.message;
  }
  render();
}

// 로컬 변경사항을 원격에 반영 (충돌 시 한번 재시도)
async function ghPushNow(message, retryCount){
  const token = getGhToken();
  if(!token){
    showToast("👀 보기 전용 모드예요. 이 변경은 내 화면에만 남고 공유되지 않아요 — 상단에서 등록하면 모두와 공유돼요");
    return;
  }
  retryCount = retryCount || 0;
  ghSyncState.status = "saving";
  render();
  try{
    // 먼저 최신 원격 상태를 가져와 충돌을 최소화
    const remote = await ghFetchFile();
    const merged = remote ? mergeSyncState(remote, collectSyncableState()) : collectSyncableState();
    applySyncedState(merged);
    await ghSaveFile(merged, message);
    ghSyncState.status = "idle";
    ghSyncState.lastError = null;
    ghSyncState.lastSyncedAt = Date.now();
  }catch(e){
    if(e.message === "CONFLICT" && retryCount < 2){
      await ghPushNow(message, retryCount+1);
      return;
    }
    ghSyncState.status = "error";
    ghSyncState.lastError = e.message;
    showToast(`⚠️ 공유 저장 실패: ${e.message}`);
  }
  render();
}

// ------------------------------------------------------------
// progress persistence (localStorage — per-browser)
// ------------------------------------------------------------
function loadProgress(){
  try{
    const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      if(!parsed.sbStages) parsed.sbStages = {};
      return parsed;
    }
  }catch(e){}
  return { longform: {}, shorts: {}, sbStages: {} };
}
function saveProgress(){
  localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(state.progress));
}
function loadSbLocal(){
  try{
    const raw = localStorage.getItem(SB_STORAGE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return {}; // { "longform-3": {title, scenes:[...]} }
}
function saveSbLocal(){
  localStorage.setItem(SB_STORAGE_KEY, JSON.stringify(state.sbLocal));
}
function loadVideoUrls(){
  try{
    const raw = localStorage.getItem(VIDEO_URL_STORAGE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return {}; // { "longform-3": "https://youtube.com/watch?v=..." }
}
function saveVideoUrls(){
  localStorage.setItem(VIDEO_URL_STORAGE_KEY, JSON.stringify(state.videoUrls));
}
function loadViewMode(){
  return localStorage.getItem(VIEW_MODE_STORAGE_KEY) || "table";
}
function saveViewMode(){
  localStorage.setItem(VIEW_MODE_STORAGE_KEY, state.viewMode);
}
function loadOps(){
  try{
    const raw = localStorage.getItem(OPS_STORAGE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return {}; // { "longform-3": [{id, label, done, assignee}] }
}
function saveOps(){
  localStorage.setItem(OPS_STORAGE_KEY, JSON.stringify(state.ops));
}
function getOps(kind, ep){
  return state.ops[videoKeyFor(kind, ep)] || [];
}
function addOp(kind, ep, label, assignee){
  const key = videoKeyFor(kind, ep);
  if(!state.ops[key]) state.ops[key] = [];
  state.ops[key].push({ id: Date.now()+"_"+Math.random().toString(36).slice(2,6), label, assignee: assignee||"", done:false });
  saveOps();
  ghPush(`Add op task on ${key}`);
}
function toggleOp(kind, ep, opId){
  const key = videoKeyFor(kind, ep);
  const list = state.ops[key] || [];
  const op = list.find(o=>o.id===opId);
  if(op) op.done = !op.done;
  saveOps();
  render();
  ghPush(`Toggle op task on ${key}`);
}
function removeOp(kind, ep, opId){
  const key = videoKeyFor(kind, ep);
  state.ops[key] = (state.ops[key]||[]).filter(o=>o.id!==opId);
  saveOps();
  render();
  ghPush(`Remove op task on ${key}`);
}

// ------------------------------------------------------------
// Episode field overrides (제목/담당자 직접 입력)
// ------------------------------------------------------------
function loadEpOverrides(){
  try{
    const raw = localStorage.getItem(EP_OVERRIDE_STORAGE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return {}; // { "longform-17": { title, shortsTitle, planner, image, video } }
}
function saveEpOverrides(){
  localStorage.setItem(EP_OVERRIDE_STORAGE_KEY, JSON.stringify(state.epOverrides));
}
function getEpField(kind, item, field){
  const key = videoKeyFor(kind, item.ep);
  const ov = state.epOverrides[key];
  if(ov && ov[field] !== undefined && ov[field] !== "") return ov[field];
  return item[field] || "";
}
function setEpOverrides(kind, ep, fields){
  const key = videoKeyFor(kind, ep);
  state.epOverrides[key] = { ...(state.epOverrides[key]||{}), ...fields };
  saveEpOverrides();
  ghPush(`Edit episode ${key}`);
}

function openEditEpModal(kind, ep){
  const list = kind === "longform" ? TF_DATA.longform : TF_DATA.shorts;
  const item = list.find(e=>e.ep===ep);
  if(!item) return;
  const isLongform = kind === "longform";
  const title = getEpField(kind, item, 'title');
  const shortsTitle = getEpField(kind, item, 'shortsTitle');
  const planner = getEpField(kind, item, 'planner');
  const image = getEpField(kind, item, 'image');
  const video = getEpField(kind, item, 'video');

  renderModal(`
    <div class="modal-head">
      <div>
        <h3>Ep.${ep} 정보 입력 / 수정</h3>
        <p>${fmtDate(item.date)} 발행 · 소재나 담당자가 정해지면 채워주세요</p>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:14px;">
      <div>
        <label style="font-size:12px; font-weight:700; color:var(--ink-soft); display:block; margin-bottom:5px;">${isLongform ? '롱폼 제목' : '쇼츠 제목'}</label>
        <input id="edit-title" type="text" value="${escapeHtml(title)}" placeholder="예: 첫 두발 자전거" style="width:100%; padding:11px 13px; border-radius:10px; border:1.5px solid var(--line); font-size:14px;">
      </div>
      ${isLongform ? `
      <div>
        <label style="font-size:12px; font-weight:700; color:var(--ink-soft); display:block; margin-bottom:5px;">쇼츠 제목</label>
        <input id="edit-shortsTitle" type="text" value="${escapeHtml(shortsTitle)}" placeholder="쇼츠용 제목 (선택)" style="width:100%; padding:11px 13px; border-radius:10px; border:1.5px solid var(--line); font-size:14px;">
      </div>` : ''}
      <div style="display:grid; grid-template-columns:${isLongform?'1fr 1fr 1fr':'1fr 1fr'}; gap:10px;">
        <div>
          <label style="font-size:12px; font-weight:700; color:var(--coral-deep); display:block; margin-bottom:5px;">기획</label>
          <input id="edit-planner" type="text" value="${escapeHtml(planner)}" placeholder="담당자 이름" list="people-list" style="width:100%; padding:11px 13px; border-radius:10px; border:1.5px solid var(--line); font-size:14px;">
        </div>
        ${isLongform ? `
        <div>
          <label style="font-size:12px; font-weight:700; color:#9C6B14; display:block; margin-bottom:5px;">이미지</label>
          <input id="edit-image" type="text" value="${escapeHtml(image)}" placeholder="담당자 이름" list="people-list" style="width:100%; padding:11px 13px; border-radius:10px; border:1.5px solid var(--line); font-size:14px;">
        </div>` : ''}
        <div>
          <label style="font-size:12px; font-weight:700; color:var(--sage-deep); display:block; margin-bottom:5px;">영상</label>
          <input id="edit-video" type="text" value="${escapeHtml(video)}" placeholder="담당자 이름" list="people-list" style="width:100%; padding:11px 13px; border-radius:10px; border:1.5px solid var(--line); font-size:14px;">
        </div>
      </div>
      <datalist id="people-list">
        ${allPeople().map(p=>`<option value="${escapeHtml(p)}">`).join("")}
      </datalist>
      <div style="font-size:11.5px; color:var(--ink-faint); background:var(--card); padding:10px 12px; border-radius:10px;">
        💡 완료(업로드)는 항상 ${UPLOAD_OWNER}님 담당으로 고정되어 있어요.
      </div>
      <button onclick="saveEpEdit('${kind}', ${ep})" style="background:var(--ink); color:#fff; border:none; padding:13px; border-radius:10px; font-weight:700; font-size:14px;">저장하기</button>
    </div>
  `);
}
function saveEpEdit(kind, ep){
  const fields = {
    title: document.getElementById('edit-title')?.value.trim() ?? '',
    planner: document.getElementById('edit-planner')?.value.trim() ?? '',
    video: document.getElementById('edit-video')?.value.trim() ?? '',
  };
  const shortsEl = document.getElementById('edit-shortsTitle');
  if(shortsEl) fields.shortsTitle = shortsEl.value.trim();
  const imageEl = document.getElementById('edit-image');
  if(imageEl) fields.image = imageEl.value.trim();

  setEpOverrides(kind, ep, fields);
  closeModal();
  showToast("에피소드 정보를 저장했어요 ✏️");
  render();
}

function getStepState(kind, ep, stepKey){
  const base = state.progress[kind]?.[ep];
  if(base && stepKey in base) return base[stepKey];
  // fall back to original sheet data (오버라이드 우선)
  const item = (kind === "longform" ? TF_DATA.longform : TF_DATA.shorts).find(e=>e.ep===ep);
  if(!item) return false;
  if(stepKey === "done") return !!item.done;
  const val = getEpField(kind, item, stepKey);
  return !!(val && val.length > 0);
}
function toggleStep(kind, ep, stepKey){
  if(!state.progress[kind][ep]) state.progress[kind][ep] = {};
  const cur = getStepState(kind, ep, stepKey);
  state.progress[kind][ep][stepKey] = !cur;
  saveProgress();
  render();
  showToast(!cur ? "체크 완료! 발걸음이 한 칸 더 찍혔어요 🐾" : "체크를 해제했어요");
  ghPush(`Update Ep.${ep} (${kind}) ${stepKey}`);
}

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------
function escapeHtml(str){
  if(str===null||str===undefined) return "";
  return String(str).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function initials(name){
  if(!name) return "?";
  return name.slice(0,1);
}
function fmtDate(d){
  if(!d) return "";
  const dt = new Date(d);
  if(isNaN(dt)) return d;
  return `${dt.getMonth()+1}.${dt.getDate()}`;
}
function fmtNum(n){
  if(n===null||n===undefined) return "—";
  return Number(n).toLocaleString("ko-KR");
}
function showToast(msg){
  const t = document.getElementById("toast");
  t.innerHTML = msg;
  t.classList.add("show");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=> t.classList.remove("show"), 2400);
}

function stepsFor(kind){
  return kind === "longform" ? STEP_DEFS_LONGFORM : STEP_DEFS_SHORTS;
}
function progressRatio(kind, item){
  const steps = stepsFor(kind);
  const checked = steps.filter(s=>getStepState(kind, item.ep, s.key)).length;
  return checked / steps.length;
}
function allPeople(){
  const set = new Set();
  TF_DATA.rr.forEach(r=>set.add(r.name));
  TF_DATA.longform.forEach(e=>{ [e.planner,e.image,e.video].forEach(p=>p&&set.add(p)); });
  TF_DATA.shorts.forEach(e=>{ [e.planner,e.video].forEach(p=>p&&set.add(p)); });
  Object.values(state.epOverrides||{}).forEach(ov=>{
    [ov.planner, ov.image, ov.video].forEach(p=>p&&set.add(p));
  });
  set.add(UPLOAD_OWNER);
  return Array.from(set).filter(Boolean);
}
function sbKeyFor(kind, ep){ return `${kind}-${ep}`; }
function getSbFor(kind, ep){
  const key = sbKeyFor(kind, ep);
  if(state.sbLocal[key]) return state.sbLocal[key];
  if(kind === "longform" && SB_DATA.matched[String(ep)]) return SB_DATA.matched[String(ep)];
  return null;
}

// ------------------------------------------------------------
// per-episode YouTube video stats
// ------------------------------------------------------------
function extractVideoId(url){
  if(!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
  ];
  for(const p of patterns){
    const m = url.match(p);
    if(m) return m[1];
  }
  return null;
}
function videoKeyFor(kind, ep){ return `${kind}-${ep}`; }
function getVideoUrl(kind, ep){
  return state.videoUrls[videoKeyFor(kind, ep)] || "";
}
function setVideoUrl(kind, ep, url){
  const key = videoKeyFor(kind, ep);
  if(!url){ delete state.videoUrls[key]; }
  else state.videoUrls[key] = url;
  saveVideoUrls();
  const vid = extractVideoId(url);
  if(vid) fetchVideoStats(vid);
  render();
  ghPush(`Set video URL for ${key}`);
}
async function fetchVideoStats(videoId){
  const apiKey = localStorage.getItem(YT_API_KEY_STORAGE_KEY);
  if(!apiKey){ videoStatsCache[videoId] = { error: "no-key" }; render(); return; }
  if(videoStatsCache[videoId] && (videoStatsCache[videoId].loading || videoStatsCache[videoId].views !== undefined)) return;
  videoStatsCache[videoId] = { loading: true };
  try{
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}&key=${apiKey}`;
    const res = await fetch(url);
    const json = await res.json();
    if(json.error) throw new Error(json.error.message);
    const item = json.items && json.items[0];
    if(!item) throw new Error("영상을 찾을 수 없어요");
    videoStatsCache[videoId] = { views: Number(item.statistics.viewCount), loading:false };
  }catch(e){
    videoStatsCache[videoId] = { error: e.message, loading:false };
  }
  render();
}
function refreshAllVideoStats(){
  const apiKey = localStorage.getItem(YT_API_KEY_STORAGE_KEY);
  if(!apiKey) return;
  Object.keys(state.videoUrls).forEach(key=>{
    const vid = extractVideoId(state.videoUrls[key]);
    if(vid){
      videoStatsCache[vid] = null; // force refresh
      fetchVideoStats(vid);
    }
  });
}

function openVideoUrlModal(kind, ep, title){
  const current = getVideoUrl(kind, ep);
  renderModal(`
    <div class="modal-head">
      <div>
        <h3>${escapeHtml(title || ('Ep.'+ep))}</h3>
        <p>유튜브 영상 URL을 연결하면 조회수가 자동으로 표시돼요</p>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:12px;">
      <input id="video-url-input" type="text" value="${escapeHtml(current)}" placeholder="https://www.youtube.com/watch?v=... 또는 /shorts/..." style="padding:12px 14px; border-radius:10px; border:1.5px solid var(--line); font-size:13.5px;">
      <div style="display:flex; gap:10px;">
        <button onclick="saveVideoUrlFromModal('${kind}', ${ep})" style="flex:1; background:var(--ink); color:#fff; border:none; padding:12px; border-radius:10px; font-weight:700; font-size:14px;">저장</button>
        ${current ? `<button onclick="setVideoUrl('${kind}', ${ep}, ''); closeModal();" style="background:var(--cream-2); border:none; padding:12px 18px; border-radius:10px; font-weight:600; color:var(--ink-soft);">연결 해제</button>` : ''}
      </div>
      ${!localStorage.getItem(YT_API_KEY_STORAGE_KEY) ? `<div style="font-size:12px; color:var(--ink-faint); background:var(--mustard-pale); padding:10px 12px; border-radius:10px;">⚠️ 아직 유튜브 API 키가 등록되지 않아서, URL을 연결해도 조회수가 표시되지 않아요. 상단의 "API 키 등록하기"를 먼저 해주세요.</div>` : ''}
    </div>
  `);
}
function saveVideoUrlFromModal(kind, ep){
  const url = document.getElementById("video-url-input").value.trim();
  setVideoUrl(kind, ep, url);
  closeModal();
  showToast(url ? "영상을 연결했어요 🎥" : "연결을 해제했어요");
}

// ------------------------------------------------------------
// Ops checklist modal (free-form: 업로드, 고정댓글 등 운영 항목)
// ------------------------------------------------------------
function openOpsModal(kind, ep, title){
  const ops = getOps(kind, ep);
  renderModal(`
    <div class="modal-head">
      <div>
        <h3>${escapeHtml(title || ('Ep.'+ep))}</h3>
        <p>업로드, 고정댓글 등 운영 작업을 자유롭게 추가해보세요</p>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:16px;" id="ops-list-${kind}-${ep}">
      ${ops.length ? ops.map(op=>`
        <div style="display:flex; align-items:center; gap:10px; background:var(--card); padding:10px 12px; border-radius:10px;">
          <div class="tbl-check ${op.done?'on':''}" style="margin:0; cursor:pointer;" onclick="toggleOp('${kind}',${ep},'${op.id}')">${op.done?'✓':''}</div>
          <div style="flex:1; font-size:13.5px; ${op.done?'color:var(--ink-faint); text-decoration:line-through;':''}">${escapeHtml(op.label)}${op.assignee?`<span style="color:var(--coral-deep); font-weight:600; margin-left:8px; font-size:12px;">@${escapeHtml(op.assignee)}</span>`:''}</div>
          <button onclick="removeOp('${kind}',${ep},'${op.id}'); openOpsModal('${kind}',${ep}, ${JSON.stringify(title||'').replace(/"/g,'&quot;')});" style="border:none; background:transparent; color:var(--ink-faint); font-size:16px; padding:2px 6px;">✕</button>
        </div>
      `).join("") : `<div style="text-align:center; padding:20px; color:var(--ink-faint); font-size:13px;">아직 등록된 운영 작업이 없어요</div>`}
    </div>
    <div style="display:flex; gap:8px;">
      <input id="ops-label-input" type="text" placeholder="예: 고정댓글 작성, 업로드, 썸네일 교체..." style="flex:2; padding:11px 13px; border-radius:10px; border:1.5px solid var(--line); font-size:13.5px;">
      <input id="ops-assignee-input" type="text" placeholder="담당자(선택)" style="flex:1; padding:11px 13px; border-radius:10px; border:1.5px solid var(--line); font-size:13.5px;">
      <button onclick="submitNewOp('${kind}',${ep}, ${JSON.stringify(title||'').replace(/"/g,'&quot;')})" style="background:var(--ink); color:#fff; border:none; padding:11px 16px; border-radius:10px; font-weight:700; font-size:13px; white-space:nowrap;">+ 추가</button>
    </div>
  `);
}
function submitNewOp(kind, ep, title){
  const labelInput = document.getElementById("ops-label-input");
  const assigneeInput = document.getElementById("ops-assignee-input");
  const label = labelInput.value.trim();
  if(!label){ showToast("할 일을 입력해주세요"); return; }
  addOp(kind, ep, label, assigneeInput.value.trim());
  openOpsModal(kind, ep, title);
  render();
}

// ------------------------------------------------------------
// YouTube stats
// ------------------------------------------------------------
let ytStats = { subs: null, views: null, videos: null, title: null, loading: true, error: null };

async function fetchYoutubeStats(){
  const apiKey = localStorage.getItem(YT_API_KEY_STORAGE_KEY);
  if(!apiKey){
    ytStats = { ...ytStats, loading:false, error:"no-key" };
    render();
    return;
  }
  try{
    const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${CHANNEL_ID}&key=${apiKey}`;
    const res = await fetch(url);
    const json = await res.json();
    if(json.error){ throw new Error(json.error.message); }
    const item = json.items && json.items[0];
    if(!item){ throw new Error("채널 정보를 찾을 수 없어요"); }
    ytStats = {
      subs: Number(item.statistics.subscriberCount),
      views: Number(item.statistics.viewCount),
      videos: Number(item.statistics.videoCount),
      title: item.snippet.title,
      thumb: item.snippet.thumbnails?.default?.url,
      loading:false,
      error:null,
    };
  }catch(e){
    ytStats = { ...ytStats, loading:false, error: e.message || "불러오기 실패" };
  }
  render();
}

function openYtKeyModal(){
  const existing = localStorage.getItem(YT_API_KEY_STORAGE_KEY) || "";
  renderModal(`
    <div class="modal-head">
      <div>
        <h3>유튜브 API 키 설정</h3>
        <p>구독자 수를 실시간으로 보여주기 위한 키예요. 키는 이 브라우저에만 저장돼요.</p>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:14px;">
      <div style="font-size:13px; color:var(--ink-soft); line-height:1.6; background:var(--card); padding:14px 16px; border-radius:12px;">
        <b>발급 방법 (최초 1회, 약 3분)</b><br>
        1. <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" style="color:var(--coral-deep); text-decoration:underline;">Google Cloud Console</a> 접속 → 프로젝트 생성<br>
        2. "YouTube Data API v3" 사용 설정<br>
        3. 사용자 인증 정보 → API 키 만들기<br>
        4. 발급된 키를 아래에 붙여넣기<br>
        <span style="color:var(--ink-faint);">※ 키 하나를 만들어서 TF원 전체가 공유해도 괜찮아요. 조회 전용이라 위험은 낮지만, 도메인 제한을 걸어두는 걸 추천해요.</span>
      </div>
      <input id="yt-key-input" type="text" value="${escapeHtml(existing)}" placeholder="AIza..." style="padding:12px 14px; border-radius:10px; border:1.5px solid var(--line); font-size:14px; font-family:monospace;">
      <div style="display:flex; gap:10px;">
        <button onclick="saveYtKey()" style="flex:1; background:var(--ink); color:#fff; border:none; padding:12px; border-radius:10px; font-weight:700; font-size:14px;">저장하고 불러오기</button>
        ${existing ? '<button onclick="clearYtKey()" style="background:var(--cream-2); border:none; padding:12px 18px; border-radius:10px; font-weight:600; color:var(--ink-soft);">삭제</button>' : ''}
      </div>
    </div>
  `);
}
function saveYtKey(){
  const v = document.getElementById("yt-key-input").value.trim();
  if(!v){ showToast("키를 입력해주세요"); return; }
  localStorage.setItem(YT_API_KEY_STORAGE_KEY, v);
  closeModal();
  ytStats.loading = true;
  render();
  fetchYoutubeStats();
}
function clearYtKey(){
  localStorage.removeItem(YT_API_KEY_STORAGE_KEY);
  ytStats = { subs:null, views:null, videos:null, title:null, loading:false, error:"no-key" };
  closeModal();
  render();
}

// ------------------------------------------------------------
// GitHub 토큰 등록 모달
// ------------------------------------------------------------
function openGhTokenModal(){
  const existing = getGhToken();
  renderModal(`
    <div class="modal-head">
      <div>
        <h3>GitHub 공유 저장 설정</h3>
        <p>체크/입력한 내용을 TF원 모두와 같이 보려면, 토큰을 한 번 등록해주세요</p>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:14px;">
      <div style="font-size:13px; color:var(--ink-soft); line-height:1.6; background:var(--card); padding:14px 16px; border-radius:12px;">
        <b>발급 방법 (최초 1회, 약 2분)</b><br>
        1. <a href="https://github.com/settings/tokens?type=beta" target="_blank" style="color:var(--coral-deep); text-decoration:underline;">GitHub Fine-grained 토큰 발급 페이지</a> 접속<br>
        2. "Generate new token" 클릭<br>
        3. Repository access → "Only select repositories" → <code>${escapeHtml(GH_OWNER)}/${escapeHtml(GH_REPO)}</code> 선택<br>
        4. Permissions → "Contents" 를 <b>Read and write</b>로 설정<br>
        5. 발급된 토큰(<code>github_pat_...</code>)을 아래에 붙여넣기<br>
        <span style="color:var(--ink-faint);">※ 토큰은 본인 브라우저에만 저장돼요. 이 repo에만 접근 가능하게 범위를 좁혀서 만드는 걸 추천해요.</span>
      </div>
      <input id="gh-token-input" type="password" value="${escapeHtml(existing)}" placeholder="github_pat_..." style="padding:12px 14px; border-radius:10px; border:1.5px solid var(--line); font-size:13px; font-family:monospace;">
      <div style="display:flex; gap:10px;">
        <button onclick="saveGhToken()" style="flex:1; background:var(--ink); color:#fff; border:none; padding:12px; border-radius:10px; font-weight:700; font-size:14px;">저장하고 동기화</button>
        ${existing ? '<button onclick="clearGhToken()" style="background:var(--cream-2); border:none; padding:12px 18px; border-radius:10px; font-weight:600; color:var(--ink-soft);">삭제</button>' : ''}
      </div>
      ${ghSyncState.lastError ? `<div style="font-size:12px; color:var(--coral-deep); background:var(--coral-pale); padding:10px 12px; border-radius:10px;">⚠️ ${escapeHtml(ghSyncState.lastError)}</div>` : ''}
    </div>
  `);
}
async function saveGhToken(){
  const v = document.getElementById("gh-token-input").value.trim();
  if(!v){ showToast("토큰을 입력해주세요"); return; }
  setGhToken(v);
  closeModal();
  showToast("저장 중... TF원들의 최신 진행 상황을 불러올게요 🔄");
  await ghPull();
  showToast(ghSyncState.lastError ? "동기화에 실패했어요. 토큰 권한을 확인해주세요" : "동기화 완료! 이제부터 변경사항이 공유돼요 🎉");
}
function clearGhToken(){
  setGhToken("");
  ghSyncState = { status: "idle", lastError: null, lastSyncedAt: null };
  closeModal();
  showToast("GitHub 연동을 해제했어요. 이제부터는 이 브라우저에만 저장돼요");
  render();
}

// ------------------------------------------------------------
// Modal
// ------------------------------------------------------------
function renderModal(innerHtml){
  let overlay = document.getElementById("modal-overlay");
  if(!overlay){
    overlay = document.createElement("div");
    overlay.id = "modal-overlay";
    overlay.className = "modal-overlay";
    overlay.onclick = (e)=>{ if(e.target===overlay) closeModal(); };
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="modal-box">${innerHtml}</div>`;
  overlay.classList.add("open");
}
function closeModal(){
  const overlay = document.getElementById("modal-overlay");
  if(overlay) overlay.classList.remove("open");
}

const SB_STAGE_DEFS = [
  { key: "삽화", icon: "🖌️" },
  { key: "애니", icon: "🎞️" },
  { key: "촬영영상+ 캐릭터 모션", icon: "🎭" },
  { key: "촬영영상", icon: "🎥" },
  { key: "더빙만", icon: "🎙️" },
];
function sbStageKeyFor(kind, ep, stage){ return `${kind}-${ep}-stage-${stage}`; }
function getSbStageChecked(kind, ep, stage){
  return !!state.progress.sbStages?.[sbStageKeyFor(kind,ep,stage)];
}
function toggleSbStage(kind, ep, stage){
  if(!state.progress.sbStages) state.progress.sbStages = {};
  const k = sbStageKeyFor(kind,ep,stage);
  state.progress.sbStages[k] = !state.progress.sbStages[k];
  saveProgress();
  openSbModal(kind, ep, null);
  ghPush(`Toggle SB stage ${k}`);
}

function openSbModal(kind, ep, title){
  const sb = getSbFor(kind, ep);
  if(!sb){
    renderModal(`
      <div class="modal-head">
        <div>
          <h3>${escapeHtml(title || ('Ep.'+ep))}</h3>
          <p>아직 연결된 스토리보드가 없어요</p>
        </div>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="empty-state">
        <div class="big">📋</div>
        <p>이 에피소드에 스토리보드(씬별 장면/오디오/자막)를 연결해보세요.<br>한 번 연결해두면 TF원 모두가 볼 수 있어요.</p>
        <button onclick="openSbEditModal('${kind}','${ep}', ${JSON.stringify(title||'').replace(/"/g,'&quot;')})" style="margin-top:14px; background:var(--coral); color:#fff; border:none; padding:11px 20px; border-radius:12px; font-weight:700;">+ 스토리보드 추가하기</button>
      </div>
    `);
    return;
  }
  const stages = (sb.stages && sb.stages.length) ? sb.stages : SB_STAGE_DEFS.map(s=>s.key);
  const stagesHtml = `
    <div style="display:flex; gap:8px; margin-bottom:18px; flex-wrap:wrap;">
      ${stages.map(stage=>{
        const def = SB_STAGE_DEFS.find(d=>d.key===stage) || { icon:'🔹' };
        const checked = getSbStageChecked(kind, ep, stage);
        return `<div onclick="toggleSbStage('${kind}',${ep},${JSON.stringify(stage).replace(/"/g,'&quot;')})" style="cursor:pointer; display:flex; align-items:center; gap:6px; padding:8px 13px; border-radius:11px; font-size:12.5px; font-weight:700; background:${checked?'var(--sage)':'var(--cream-2)'}; color:${checked?'#fff':'var(--ink-soft)'}; border:1.5px solid ${checked?'var(--sage-deep)':'var(--line)'};">
          <span>${def.icon}</span>${escapeHtml(stage)}${checked ? ' ✓' : ''}
        </div>`;
      }).join("")}
    </div>`;

  const scenesHtml = sb.scenes.map((s, i)=>{
    const desc = s["장면 설명"] || s["장면설명"] || s["내용"] || "";
    const gubun = s["구분"] || "";
    const audio = s["오디오"] || "";
    const caption = s["자막"] || "";
    const ref = s["참고"] || s["링크(참고 레퍼런스 링크)"] || s["레퍼런스"] || "";
    const sceneNo = s["씬"] || s["샷 순서"] || (i+1);
    const metaParts = [];
    if(audio) metaParts.push(`<b>오디오</b> ${escapeHtml(audio)}`);
    if(caption) metaParts.push(`<b>자막</b> ${escapeHtml(caption)}`);
    if(ref) metaParts.push(`<b>참고</b> ${escapeHtml(ref)}`);
    return `
      <div class="scene-row">
        <div class="scene-num">#${escapeHtml(String(sceneNo))}</div>
        <div>
          ${gubun ? `<div style="font-size:11px; font-weight:700; color:var(--coral-deep); background:var(--coral-pale); display:inline-block; padding:2px 9px; border-radius:7px; margin-bottom:6px;">${escapeHtml(gubun)}</div>` : ""}
          <div class="scene-desc">${escapeHtml(desc)}</div>
          ${metaParts.length ? `<div class="scene-meta">${metaParts.join("<br>")}</div>` : ""}
        </div>
      </div>`;
  }).join("");
  renderModal(`
    <div class="modal-head">
      <div>
        <h3>${escapeHtml(sb.title || title || ('Ep.'+ep))}</h3>
        <p>씬 ${sb.scenes.length}개 · 스토리보드</p>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    ${stagesHtml}
    <div style="margin-bottom:14px; display:flex; gap:8px;">
      <button onclick="openSbEditModal('${kind}','${ep}', ${JSON.stringify(sb.title||'').replace(/"/g,'&quot;')})" style="background:var(--cream-2); border:none; padding:8px 14px; border-radius:10px; font-weight:600; font-size:12.5px; color:var(--ink-soft);">✏️ 직접 수정</button>
    </div>
    <div class="scene-list">
      ${scenesHtml || '<div class="empty-state">씬 정보가 비어있어요</div>'}
    </div>
  `);
}

function openSbEditModal(kind, ep, currentTitle){
  const sb = getSbFor(kind, ep) || { title: currentTitle || "", scenes: [] };
  const scenesText = sb.scenes.map(s=>{
    const desc = s["장면 설명"] || s["장면설명"] || s["내용"] || "";
    const gubun = s["구분"] || "";
    const audio = s["오디오"] || "";
    const caption = s["자막"] || "";
    const ref = s["참고"] || s["링크(참고 레퍼런스 링크)"] || s["레퍼런스"] || "";
    return `${desc}\n구분: ${gubun}\n오디오: ${audio}\n자막: ${caption}\n참고: ${ref}`;
  }).join("\n---\n");
  renderModal(`
    <div class="modal-head">
      <div>
        <h3>스토리보드 직접 입력</h3>
        <p>씬을 ---로 구분해서 적어주세요. 형식: 장면설명 / 구분: / 오디오: / 자막: / 참고:</p>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:12px;">
      <input id="sb-title-input" value="${escapeHtml(sb.title)}" placeholder="에피소드 제목" style="padding:11px 14px; border-radius:10px; border:1.5px solid var(--line); font-size:14px; font-weight:700;">
      <textarea id="sb-scenes-input" placeholder="장면설명 1...
구분: 상황 도입
오디오: ...
자막: ...
참고: ...
---
장면설명 2..." style="padding:14px; border-radius:12px; border:1.5px solid var(--line); font-size:13px; min-height:280px; font-family:inherit; line-height:1.6; resize:vertical;">${escapeHtml(scenesText)}</textarea>
      <button onclick="saveSbEdit('${kind}','${ep}')" style="background:var(--ink); color:#fff; border:none; padding:13px; border-radius:10px; font-weight:700; font-size:14px;">저장하기</button>
    </div>
  `);
}
function saveSbEdit(kind, ep){
  const title = document.getElementById("sb-title-input").value.trim();
  const raw = document.getElementById("sb-scenes-input").value;
  const blocks = raw.split(/\n---\n/).map(b=>b.trim()).filter(Boolean);
  const scenes = blocks.map(b=>{
    const lines = b.split("\n");
    let desc = [], gubun = "", audio = "", caption = "", ref = "";
    lines.forEach(line=>{
      if(/^구분\s*[:：]/.test(line)) gubun = line.replace(/^구분\s*[:：]/,"").trim();
      else if(/^오디오\s*[:：]/.test(line)) audio = line.replace(/^오디오\s*[:：]/,"").trim();
      else if(/^자막\s*[:：]/.test(line)) caption = line.replace(/^자막\s*[:：]/,"").trim();
      else if(/^참고\s*[:：]/.test(line)) ref = line.replace(/^참고\s*[:：]/,"").trim();
      else desc.push(line);
    });
    return { "장면 설명": desc.join("\n").trim(), "구분": gubun, "오디오": audio, "자막": caption, "참고": ref };
  });
  const key = sbKeyFor(kind, ep);
  state.sbLocal[key] = { sheet: key, title, stages: [], scenes };
  saveSbLocal();
  closeModal();
  showToast("스토리보드를 저장했어요 📋");
  render();
  ghPush(`Update storyboard ${key}`);
}

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------
function render(){
  const app = document.getElementById("app");
  app.innerHTML = `
    ${renderHeader()}
    ${renderYtStrip()}
    ${renderTabs()}
    ${state.tab === "rr" ? renderRR() : renderEpisodes(state.tab)}
    ${renderFooter()}
  `;
}

function renderHeader(){
  const lf = TF_DATA.longform, sh = TF_DATA.shorts;
  const totalDone = lf.filter(e=>getStepState("longform",e.ep,"done")).length + sh.filter(e=>getStepState("shorts",e.ep,"done")).length;
  const totalEp = lf.length + sh.length;
  const hasToken = !!getGhToken();
  let syncBadge;
  if(!hasToken){
    syncBadge = `<button onclick="openGhTokenModal()" style="font-size:11.5px; font-weight:700; color:var(--coral-deep); background:var(--coral-pale); border:none; padding:4px 11px; border-radius:20px; margin-top:2px;">👀 보기 전용 — 직접 체크하려면 등록하기</button>`;
  } else if(ghSyncState.status === 'saving'){
    syncBadge = `<span style="font-size:11.5px; font-weight:600; color:var(--ink-faint);">💾 저장 중…</span>`;
  } else if(ghSyncState.status === 'loading'){
    syncBadge = `<span style="font-size:11.5px; font-weight:600; color:var(--ink-faint);">🔄 불러오는 중…</span>`;
  } else if(ghSyncState.status === 'error'){
    syncBadge = `<button onclick="openGhTokenModal()" style="font-size:11.5px; font-weight:700; color:var(--coral-deep); background:var(--coral-pale); border:none; padding:4px 11px; border-radius:20px; margin-top:2px;">⚠️ 동기화 오류 — 확인하기</button>`;
  } else {
    syncBadge = `<button onclick="openGhTokenModal()" style="font-size:11.5px; font-weight:600; color:var(--sage-deep); background:var(--sage-pale); border:none; padding:4px 11px; border-radius:20px; margin-top:2px;">✓ 모두와 공유 중</button>`;
  }
  return `
  <header class="site">
    <div class="brand">
      <div class="brand-mark" style="background:none; box-shadow:none; overflow:hidden;">
        <img src="data:image/png;base64,${BRAND_MARK_B64}" alt="뚜루마리" style="width:100%; height:100%; object-fit:cover; border-radius:16px;">
      </div>
      <div class="brand-text">
        <h1>뚜루마리</h1>
        <p>바이럴 TF 콘텐츠 진행 현황판</p>
        <div>${syncBadge}</div>
      </div>
    </div>
    <div class="header-stats">
      <div class="hstat live">
        <div class="n">${totalDone}<span style="font-size:15px; color:var(--ink-faint); font-weight:600;">/${totalEp}</span></div>
        <div class="l">전체 완료 에피소드</div>
      </div>
      <div class="hstat">
        <div class="n">${lf.length}</div>
        <div class="l">롱폼</div>
      </div>
      <div class="hstat">
        <div class="n">${sh.length}</div>
        <div class="l">쇼츠</div>
      </div>
    </div>
  </header>`;
}

function renderYtStrip(){
  if(ytStats.loading){
    return `<div class="yt-strip">${[1,2,3,4].map(()=>`
      <div class="yt-card"><div class="yt-label">불러오는 중…</div><div class="yt-value">···</div></div>`).join("")}</div>`;
  }
  if(ytStats.error){
    return `
    <div class="yt-strip" style="grid-template-columns:1fr;">
      <div class="yt-card" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
        <div>
          <div class="yt-label">📺 유튜브 채널 연동이 아직 안 되어 있어요</div>
          <div class="yt-sub">${ytStats.error === "no-key" ? "API 키를 한 번만 등록하면 구독자/조회수가 실시간으로 보여요." : "오류: " + escapeHtml(ytStats.error)}</div>
        </div>
        <button onclick="openYtKeyModal()" style="background:var(--coral); color:#fff; border:none; padding:10px 18px; border-radius:12px; font-weight:700; font-size:13px; white-space:nowrap;">API 키 등록하기</button>
      </div>
    </div>`;
  }
  return `
  <div class="yt-strip">
    <div class="yt-card">
      <div class="yt-label"><span class="yt-dot"></span>구독자</div>
      <div class="yt-value">${fmtNum(ytStats.subs)}</div>
      <div class="yt-sub">실시간 · 뚜루마리</div>
    </div>
    <div class="yt-card alt">
      <div class="yt-label">누적 조회수</div>
      <div class="yt-value">${fmtNum(ytStats.views)}</div>
      <div class="yt-sub">전체 영상 합산</div>
    </div>
    <div class="yt-card alt2">
      <div class="yt-label">업로드 영상</div>
      <div class="yt-value">${fmtNum(ytStats.videos)}</div>
      <div class="yt-sub">롱폼 + 쇼츠</div>
    </div>
    <div class="yt-card alt3" style="display:flex; flex-direction:column; justify-content:space-between;">
      <div class="yt-label">채널 설정</div>
      <button onclick="openYtKeyModal()" style="margin-top:6px; background:var(--cream-2); border:none; padding:8px 12px; border-radius:10px; font-size:12px; font-weight:700; color:var(--ink-soft); align-self:flex-start;">🔑 API 키 변경</button>
    </div>
  </div>`;
}

function renderTabs(){
  const tabs = [
    {key:"longform", label:"롱폼", emoji:"🎬"},
    {key:"shorts", label:"쇼츠", emoji:"⚡"},
    {key:"rr", label:"R&R", emoji:"👥"},
  ];
  return `
  <div class="section-head">
    <h2><span class="eyebrow">Progress Board</span></h2>
    <div class="tabs">
      ${tabs.map(t=>`<button class="tab-btn ${state.tab===t.key?'active':''}" onclick="setTab('${t.key}')">${t.emoji} ${t.label}</button>`).join("")}
    </div>
  </div>`;
}

function setTab(tab){ state.tab = tab; state.filterPerson = null; render(); }
function setFilterPerson(name){
  state.filterPerson = state.filterPerson === name ? null : name;
  render();
}
function setViewMode(mode){
  state.viewMode = mode;
  saveViewMode();
  render();
}

function renderEpisodes(kind){
  const list = kind === "longform" ? TF_DATA.longform : TF_DATA.shorts;
  const steps = stepsFor(kind);

  // overall progress
  const totalSteps = list.length * steps.length;
  let doneSteps = 0;
  list.forEach(item=> steps.forEach(s=>{ if(getStepState(kind,item.ep,s.key)) doneSteps++; }));
  const pct = totalSteps ? Math.round((doneSteps/totalSteps)*100) : 0;

  const people = allPeople();
  const filtered = state.filterPerson
    ? list.filter(e=> {
        const p = getEpField(kind, e, 'planner');
        const img = getEpField(kind, e, 'image');
        const v = getEpField(kind, e, 'video');
        return [p, img, v].includes(state.filterPerson);
      })
    : list;

  return `
  <div class="overall-progress">
    <div class="op-top">
      <div class="title">${kind==='longform'?'롱폼':'쇼츠'} 전체 진행률</div>
      <div class="pct">${pct}%</div>
    </div>
    <div class="op-track"><div class="op-fill" style="width:${pct}%"></div></div>
    <div class="op-legend">
      ${steps.map(s=>`<span><i style="background:var(--sage)"></i>${s.icon} ${s.label}</span>`).join("")}
      <span style="color:var(--ink-faint);">체크박스를 클릭해서 단계를 토글할 수 있어요</span>
    </div>
  </div>

  <div class="filter-bar">
    <button class="filter-chip ${!state.filterPerson?'active':''}" onclick="setFilterPerson(null)">전체</button>
    ${people.map(p=>`<button class="filter-chip ${state.filterPerson===p?'active':''}" onclick="setFilterPerson('${p}')">${escapeHtml(p)}</button>`).join("")}
  </div>

  <div class="view-toggle-row">
    <div class="view-toggle">
      <button class="${state.viewMode==='table'?'active':''}" onclick="setViewMode('table')">☰ 표로 보기</button>
      <button class="${state.viewMode==='card'?'active':''}" onclick="setViewMode('card')">▦ 카드로 보기</button>
    </div>
  </div>

  ${state.viewMode === 'table' ? renderEpTable(kind, filtered) : `<div class="ep-grid">${filtered.map(item=>renderEpCard(kind, item)).join("")}</div>`}
  `;
}

function roleColor(roleKey){
  // 기획=coral, 이미지=mustard, 영상=sage, 완료(업로드)=ink — 역할별 고정 색
  if(roleKey === 'planner') return { bg:'var(--coral-pale)', fg:'var(--coral-deep)' };
  if(roleKey === 'image') return { bg:'var(--mustard-pale)', fg:'#9C6B14' };
  if(roleKey === 'video') return { bg:'var(--sage-pale)', fg:'var(--sage-deep)' };
  if(roleKey === 'done') return { bg:'#E4E7F0', fg:'var(--ink)' };
  return { bg:'var(--cream-2)', fg:'var(--ink-soft)' };
}
const UPLOAD_OWNER = "홍신영"; // 완료=업로드 담당자 (고정)

function renderEpTable(kind, list){
  const isLongform = kind === 'longform';
  return `
  <div class="ep-table-wrap">
    <table class="ep-table">
      <thead>
        <tr>
          <th>Ep.</th>
          <th>발행일</th>
          <th>${isLongform?'롱폼 제목':'쇼츠 제목'}</th>
          ${isLongform ? '<th>쇼츠 제목</th>' : ''}
          <th>기획</th>
          ${isLongform ? '<th>이미지</th>' : ''}
          <th>영상</th>
          <th>완료</th>
          <th>조회수</th>
          <th>SB</th>
          <th>운영</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${list.map(item=>renderEpRow(kind, item)).join("")}
      </tbody>
    </table>
  </div>`;
}

function renderEpRow(kind, item){
  const isLongform = kind === 'longform';
  const titleVal = getEpField(kind, item, 'title');
  const shortsTitleVal = getEpField(kind, item, 'shortsTitle');
  const plannerVal = getEpField(kind, item, 'planner');
  const imageVal = getEpField(kind, item, 'image');
  const videoVal = getEpField(kind, item, 'video');
  const isEmpty = !titleVal && !shortsTitleVal;
  const ratio = progressRatio(kind, item);
  const isDone = ratio === 1;
  const titleText = titleVal || shortsTitleVal || "";
  const titleSafe = JSON.stringify(titleText).replace(/"/g,'&quot;');
  const sb = getSbFor(kind, item.ep);
  const ops = getOps(kind, item.ep);
  const opsDone = ops.filter(o=>o.done).length;
  const videoUrl = getVideoUrl(kind, item.ep);
  const videoId = extractVideoId(videoUrl);
  const vstat = videoId ? videoStatsCache[videoId] : null;
  if(videoId && !vstat) fetchVideoStats(videoId);

  const doneChecked = getStepState(kind, item.ep, 'done');

  function roleCell(roleKey, person){
    const c = roleColor(roleKey);
    const checked = getStepState(kind, item.ep, roleKey);
    return `<td class="col-person check-cell" onclick="toggleStep('${kind}', ${item.ep}, '${roleKey}')" title="클릭해서 토글">
      <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
        <div class="tbl-check ${checked?'on':''}">${checked?'✓':''}</div>
        ${person ? `<span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:6px; background:${c.bg}; color:${c.fg};">${escapeHtml(person)}</span>` : `<span style="font-size:10.5px; color:var(--ink-faint);">미정</span>`}
      </div>
    </td>`;
  }

  let viewsCell;
  const playLink = videoUrl ? `<a href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener" title="영상 보러가기" style="margin-left:6px; text-decoration:none; color:var(--coral-deep); font-size:13px;" onclick="event.stopPropagation()">▶</a>` : '';
  if(!videoUrl){
    viewsCell = `<td class="col-views"><span class="views-empty" onclick="openVideoUrlModal('${kind}', ${item.ep}, ${titleSafe})">+ URL 연결</span></td>`;
  } else if(!videoId){
    viewsCell = `<td class="col-views"><span class="views-empty" onclick="openVideoUrlModal('${kind}', ${item.ep}, ${titleSafe})" style="color:var(--coral-deep);">URL 오류</span>${playLink}</td>`;
  } else if(!localStorage.getItem(YT_API_KEY_STORAGE_KEY)){
    viewsCell = `<td class="col-views"><span class="views-empty" onclick="openVideoUrlModal('${kind}', ${item.ep}, ${titleSafe})">API키 필요</span>${playLink}</td>`;
  } else if(!vstat || vstat.loading){
    viewsCell = `<td class="col-views"><span class="views-empty">불러오는 중…</span>${playLink}</td>`;
  } else if(vstat.error){
    viewsCell = `<td class="col-views"><span class="views-empty" onclick="openVideoUrlModal('${kind}', ${item.ep}, ${titleSafe})" style="color:var(--coral-deep);">오류</span>${playLink}</td>`;
  } else {
    viewsCell = `<td class="col-views"><span class="views-num" onclick="openVideoUrlModal('${kind}', ${item.ep}, ${titleSafe})">${fmtNum(vstat.views)}</span>${playLink}</td>`;
  }

  return `
  <tr class="${isDone?'row-done':''} ${isEmpty?'row-empty':''}">
    <td class="col-ep">${item.ep}</td>
    <td class="col-date">${fmtDate(item.date)}</td>
    <td class="col-title">${isEmpty ? '<span style="color:var(--ink-faint); font-weight:500;">미정</span>' : escapeHtml(titleVal || '')}</td>
    ${isLongform ? `<td class="col-shorts">${escapeHtml(shortsTitleVal || '')}</td>` : ''}
    ${roleCell('planner', plannerVal)}
    ${isLongform ? roleCell('image', imageVal) : ''}
    ${roleCell('video', videoVal)}
    ${(()=>{
      const c = roleColor('done');
      return `<td class="col-person check-cell" onclick="toggleStep('${kind}', ${item.ep}, 'done')" title="업로드 완료 토글">
        <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
          <div class="tbl-check ${doneChecked?'on':''}">${doneChecked?'✓':''}</div>
          <span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:6px; background:${c.bg}; color:${c.fg};">${escapeHtml(UPLOAD_OWNER)}</span>
        </div>
      </td>`;
    })()}
    ${viewsCell}
    <td class="col-sb">
      <button class="sb-link-btn ${sb?'has-sb':''}" style="font-size:11px; padding:5px 9px;" onclick="openSbModal('${kind}', ${item.ep}, ${titleSafe})">
        ${sb ? `📋 ${sb.scenes.length}` : '+ 연결'}
      </button>
    </td>
    <td class="col-sb">
      <button class="sb-link-btn ${ops.length?'has-sb':''}" style="font-size:11px; padding:5px 9px;" onclick="openOpsModal('${kind}', ${item.ep}, ${titleSafe})">
        ${ops.length ? `📌 ${opsDone}/${ops.length}` : '+ 운영'}
      </button>
    </td>
    <td class="col-sb">
      <button class="sb-link-btn" style="font-size:11px; padding:5px 9px;" onclick="openEditEpModal('${kind}', ${item.ep})">✏️ 편집</button>
    </td>
  </tr>`;
}

function renderEpCard(kind, item){
  const steps = stepsFor(kind);
  const titleVal = getEpField(kind, item, 'title');
  const shortsTitleVal = getEpField(kind, item, 'shortsTitle');
  const plannerVal = getEpField(kind, item, 'planner');
  const imageVal = getEpField(kind, item, 'image');
  const videoVal = getEpField(kind, item, 'video');
  const isEmpty = !titleVal && !shortsTitleVal;
  const ratio = progressRatio(kind, item);
  const isDone = ratio === 1;
  const titleText = titleVal || shortsTitleVal || "";
  const subText = kind === "longform" ? shortsTitleVal : "";
  const sb = getSbFor(kind, item.ep);
  const videoUrl = getVideoUrl(kind, item.ep);
  const videoId = extractVideoId(videoUrl);
  const vstat = videoId ? videoStatsCache[videoId] : null;
  if(videoId && !vstat) fetchVideoStats(videoId);

  let viewsLine = '';
  if(videoUrl){
    const viewsText = (videoId && vstat && !vstat.loading && !vstat.error) ? `${fmtNum(vstat.views)}회 조회` : '조회수 불러오는 중';
    viewsLine = `<div style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--sage-deep); font-weight:600;">
      <a href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener" style="color:var(--coral-deep); text-decoration:none;">▶ 영상 보기</a>
      <span style="color:var(--ink-faint);">·</span>${viewsText}
    </div>`;
  }

  const peopleMap = kind === "longform"
    ? { planner: plannerVal, image: imageVal, video: videoVal, done: UPLOAD_OWNER }
    : { planner: plannerVal, video: videoVal, done: UPLOAD_OWNER };

  return `
  <div class="ep-card ${isDone?'is-done':''} ${isEmpty?'is-empty':''}">
    <div class="ep-top">
      <span class="ep-num">Ep.${item.ep}</span>
      <span class="ep-date">${fmtDate(item.date)}</span>
    </div>
    <div class="ep-title ${isEmpty?'empty':''}">${isEmpty ? '아직 소재 미정이에요' : escapeHtml(titleText)}</div>
    ${subText ? `<div class="ep-sub">${escapeHtml(subText)}</div>` : ""}
    ${viewsLine}
    <div class="footprints">
      ${steps.map(s=>{
        const checked = getStepState(kind, item.ep, s.key);
        const person = peopleMap[s.key];
        return `
        <div class="fp-step ${checked?'checked':''}" onclick="toggleStep('${kind}', ${item.ep}, '${s.key}')" title="${s.label} ${checked?'완료':'미완료'} — 클릭해서 토글">
          <div class="fp-icon">${s.icon}</div>
          <div class="fp-label">${s.label}</div>
          ${person ? `<div class="fp-name">${escapeHtml(person)}</div>` : ""}
        </div>`;
      }).join("")}
    </div>
    <div class="ep-bottom">
      <span class="ep-status-badge ${isEmpty?'empty':(isDone?'done':'progress')}">
        ${isEmpty?'미정':(isDone?'완료':'진행중')}
      </span>
      <div style="display:flex; gap:6px;">
        <button class="sb-link-btn" onclick="openEditEpModal('${kind}', ${item.ep})">✏️ 편집</button>
        <button class="sb-link-btn" onclick="openVideoUrlModal('${kind}', ${item.ep}, ${JSON.stringify(titleText).replace(/"/g,'&quot;')})">🔗 URL</button>
        <button class="sb-link-btn ${sb?'has-sb':''}" onclick="openSbModal('${kind}', ${item.ep}, ${JSON.stringify(titleText).replace(/"/g,'&quot;')})">
          ${sb ? `📋 SB (${sb.scenes.length})` : '+ SB'}
        </button>
      </div>
    </div>
  </div>`;
}

function renderRR(){
  return `
  <div class="rr-grid">
    ${TF_DATA.rr.map(r=>`
      <div class="rr-card">
        <div class="rr-name"><span class="rr-avatar">${initials(r.name)}</span>${escapeHtml(r.name)}</div>
        <div class="rr-role">${escapeHtml(r.role)}</div>
        <div class="rr-output">${escapeHtml(r.output)}</div>
        ${r.detail ? `<div class="rr-detail">${escapeHtml(r.detail)}</div>` : ""}
      </div>
    `).join("")}
  </div>`;
}

function renderFooter(){
  return `<footer class="site">뚜루마리 바이럴 TF · 함께 만드는 진행 현황판 🐾</footer>`;
}

// ------------------------------------------------------------
// init
// ------------------------------------------------------------
render();
fetchYoutubeStats();
refreshAllVideoStats();
ghPull();
