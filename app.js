import { createApp, ref, computed, watch, onMounted, nextTick, reactive } from './vendor/vue-3.5.13.esm-browser.prod.js'

// Firebase 設定改由外部檔案提供：自架者請編輯 firebase-config.js
import { firebaseConfig } from './firebase-config.js';

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { initializeFirestore, collection, doc, setDoc, onSnapshot, getDocs, persistentLocalCache, persistentMultipleTabManager } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { CHECKLIST_CATEGORIES, LUGGAGE_META, CHECKLIST_TEMPLATE } from './checklist-data.js';
import { EXPENSE_CATEGORIES, PAYMENT_METHODS } from './expense-data.js';

createApp({
    setup() {
        console.log('Vue Setup started');
        const viewMode = ref('plan');
        const currentDayIdx = ref(0);
        const amountInputRef = ref(null);
        const isAmountInvalid = ref(false);
        const weatherInputRef = ref(null);

        const showTripMenu = ref(false);
        const tripList = ref([]);
        const currentTripId = ref(null);
        const showSetupModal = ref(false);
        const isEditing = ref(false);
        const isDataLoading = ref(false);
        const isLoggedIn = ref(false);
        const dbError = ref(false);
        const dbErrorCode = ref('');
        const syncStatus = ref('synced');
        const shareUrl = ref('');
        const showShareModal = ref(false);
        const showJoinInput = ref(false);
        const joinTripUrl = ref('');

        const errorMap = {
            'unavailable': '無法連線到伺服器，請檢查網路。',
            'permission-denied': '存取被拒絕，請確認您有權限。',
            'not-found': '找不到此行程，可能已被刪除。',
            'resource-exhausted': '配額已滿，請稍後再試。',
            'not-configured': '尚未設定 Firebase：請編輯 firebase-config.js，填入你自己的 Firebase 專案設定（步驟見 README）。'
        };

        const dbErrorMessage = computed(() => errorMap[dbErrorCode.value] || `發生未知錯誤 (${dbErrorCode.value})`);

        let db = null;
        let auth = null;
        let unsubscribeTripData = null;
        let ignoreRemoteUpdate = false;

        const editingState = reactive({ dayTitle: false, flight: false });

        const days = ref([]);
        const savedLocations = ref([]);
        const expenses = ref([]);
        const checklist = ref([]);
        const prepTasks = ref([]);
        const newPrepTask = ref('');
        const addPrepTask = () => {
            const title = newPrepTask.value.trim();
            if (!title) return;
            prepTasks.value.push({ id: generateId(), title, completed: false });
            newPrepTask.value = '';
        };
        const togglePrepTask = (task) => { task.completed = !task.completed; };
        const deletePrepTask = (id) => {
            const idx = prepTasks.value.findIndex(t => t.id === id);
            if (idx === -1) return;
            const removed = prepTasks.value.splice(idx, 1)[0];
            showToast('已刪除項目', { icon: 'ph-bold ph-trash', undo: () => { prepTasks.value.splice(Math.min(idx, prepTasks.value.length), 0, removed); } });
        };
        const collapsedCats = reactive({});
        const participants = ref([]);
        const participantsStr = ref('');
        const exchangeRate = ref(0.215);

        // 6. 新增台幣 (TWD) 預付標記支援
        const newExpense = ref({ item: '', amount: '', payer: '', category: 'other', paymentMethod: 'cash', splitWith: [], isTWD: false });
        
        // 5. 擴充分類選單（包含 ✈️ 機票）與自訂分類
        const customCategories = ref([]);
        const baseCategories = [
            { slug: 'flight', label: '機票', emoji: '✈️' },
            ...EXPENSE_CATEGORIES
        ];
        const allExpenseCategories = computed(() => [
            ...baseCategories,
            ...customCategories.value.map(name => ({ slug: name, label: name, emoji: '🏷️' }))
        ]);
        const newCustomCategory = ref('');
        const showCustomCategoryInput = ref(false);
        const addCustomCategory = (targetDraftRefGetter) => {
            const name = newCustomCategory.value.trim();
            if (!name) { showCustomCategoryInput.value = false; return; }
            if (!customCategories.value.includes(name) && !allExpenseCategories.value.some(c => c.slug === name)) {
                customCategories.value.push(name);
            }
            const target = targetDraftRefGetter();
            if (target) target.category = name;
            newCustomCategory.value = '';
            showCustomCategoryInput.value = false;
        };

        const isRateLoading = ref(false);
        const weather = ref({ temp: null, icon: 'ph-sun', code: 0, location: '', daily: [] });
        const isWeatherEditing = ref(false);
        const setup = ref({ destination: '', startDate: new Date().toISOString().split('T')[0], days: 5, rate: 1, currency: 'TWD', langCode: 'zh-TW', langName: '中文', mapProvider: 'google' });

        const currentDay = computed(() => days.value[currentDayIdx.value] || { items: [], flight: null, date: '', title: '' });
        const totalExpense = computed(() => expenses.value.reduce((sum, item) => sum + (item.amount || 0), 0));
        const paidByPerson = computed(() => {
            const map = {}; participants.value.forEach(p => map[p] = 0);
            expenses.value.forEach(e => { if (map[e.payer] === undefined) map[e.payer] = 0; map[e.payer] += (e.amount || 0); }); return map;
        });

        const effectiveSplitWith = (exp) => (exp.splitWith && exp.splitWith.length) ? exp.splitWith : participants.value;
        const owedByPerson = computed(() => {
            const map = {}; participants.value.forEach(p => map[p] = 0);
            expenses.value.forEach(e => {
                const who = effectiveSplitWith(e);
                if (!who.length) return;
                const share = (e.amount || 0) / who.length;
                who.forEach(p => { if (map[p] === undefined) map[p] = 0; map[p] += share; });
            });
            return map;
        });

        const categoryTotals = computed(() => {
            const map = {};
            expenses.value.forEach(e => {
                const key = e.category || 'other';
                map[key] = (map[key] || 0) + (e.amount || 0);
            });
            return map;
        });
        const PIE_COLORS = ['#ff69b4', '#5eead4', '#fbbf24', '#818cf8', '#fb923c', '#34d399', '#f472b6', '#60a5fa'];
        const categoryPieSlices = computed(() => {
            const total = totalExpense.value;
            if (!total) return [];
            const cx = 50, cy = 50, r = 45;
            let startAngle = -Math.PI / 2;
            const polar = (angle) => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
            const entries = Object.entries(categoryTotals.value).filter(([, amt]) => amt > 0);
            return entries.map(([slug, amt], idx) => {
                const cat = allExpenseCategories.value.find(c => c.slug === slug) || { slug, label: slug, emoji: '💰' };
                const pct = amt / total;
                const endAngle = startAngle + pct * Math.PI * 2;
                const [x1, y1] = polar(startAngle);
                const [x2, y2] = polar(endAngle);
                const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
                const path = pct >= 0.999
                    ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
                    : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
                const slice = { slug, label: cat.label, emoji: cat.emoji, amount: amt, pct, path, color: PIE_COLORS[idx % PIE_COLORS.length] };
                startAngle = endAngle;
                return slice;
            });
        });

        const personBarData = computed(() => {
            const data = participants.value.map(p => ({ name: p, amount: owedByPerson.value[p] || 0 }));
            const max = Math.max(1, ...data.map(d => d.amount));
            return data.sort((a, b) => b.amount - a.amount).map(d => ({ ...d, pct: d.amount / max }));
        });

        const dayLabel = (idx) => (idx === null || idx === undefined || !days.value[idx]) ? '未指定' : `Day ${idx + 1}`;

        // 5. 成員精簡管理邏輯
        const newParticipant = ref('');
        const addParticipant = () => {
            const name = newParticipant.value.trim();
            if (!name || participants.value.includes(name)) { newParticipant.value = ''; return; }
            participants.value.push(name);
            participantsStr.value = participants.value.join(', ');
            if (!newExpense.value.payer) newExpense.value.payer = name;
            if (newExpense.value.splitWith && newExpense.value.splitWith.length) newExpense.value.splitWith.push(name);
            newParticipant.value = '';
        };
        const removeParticipant = (name) => {
            participants.value = participants.value.filter(p => p !== name);
            participantsStr.value = participants.value.join(', ');
            if (newExpense.value.payer === name) newExpense.value.payer = participants.value[0] || '';
            if (newExpense.value.splitWith) newExpense.value.splitWith = newExpense.value.splitWith.filter(p => p !== name);
        };

        const toggleSplitMember = (draftLike, name) => {
            if (!draftLike.splitWith || !draftLike.splitWith.length) draftLike.splitWith = [...participants.value];
            const idx = draftLike.splitWith.indexOf(name);
            if (idx === -1) draftLike.splitWith.push(name); else draftLike.splitWith.splice(idx, 1);
        };
        const isSplitChecked = (draftLike, name) => {
            if (!draftLike.splitWith || !draftLike.splitWith.length) return true;
            return draftLike.splitWith.includes(name);
        };

        const currencyLabel = computed(() => setup.value.currency || '外幣');
        const currencySymbol = computed(() => { const map = { 'JPY': '¥', 'CNY': '¥', 'USD': '$', 'EUR': '€', 'KRW': '₩', 'GBP': '£', 'TWD': 'NT$', 'HKD': 'HK$', 'THB': '฿', 'VND': '₫' }; return map[setup.value.currency] || '$'; });
        const mapProviderLabel = computed(() => { const map = { 'google': 'Google Maps', 'naver': 'Naver Map', 'amap': '高德地圖' }; return map[setup.value.mapProvider] || '地圖'; });

        const weatherDisplay = computed(() => {
            if (!weather.value) return { temp: '--', icon: 'ph-sun', label: '載入中...', isForecast: false };
            const loc = weather.value.location || (setup.value ? setup.value.destination : '') || '當地';
            if (!currentDay.value || !currentDay.value.fullDate || !weather.value.daily || weather.value.daily.length === 0) {
                return { temp: weather.value.temp !== null ? `${weather.value.temp}°` : '--', icon: weather.value.icon || 'ph-sun', label: loc, isForecast: false };
            }
            const targetDate = currentDay.value.fullDate;
            if (weather.value.daily.time) {
                const idx = weather.value.daily.time.indexOf(targetDate);
                if (idx !== -1) {
                    const max = Math.round(weather.value.daily.temperature_2m_max[idx]);
                    const min = Math.round(weather.value.daily.temperature_2m_min[idx]);
                    return { temp: `${min}°-${max}°`, icon: getWeatherIcon(weather.value.daily.weathercode[idx]), label: loc, isForecast: true };
                }
            }
            return { temp: weather.value.temp !== null ? `${weather.value.temp}°` : '--', icon: weather.value.icon || 'ph-sun', label: loc, isForecast: false };
        });

        const generateId = () => 'item_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        const localDateStr = (dt = new Date()) => { const m = dt.getMonth() + 1, d = dt.getDate(); return `${dt.getFullYear()}-${m < 10 ? '0' + m : m}-${d < 10 ? '0' + d : d}`; };
        const fmtExpDate = (s) => { if (!s) return ''; const p = String(s).split('-'); return p.length === 3 ? `${p[1]}/${p[2]}` : s; };
        const getWeatherIcon = (c) => { if (c === 0) return 'ph-sun'; if (c < 4) return 'ph-cloud-sun'; if (c < 50) return 'ph-cloud-fog'; if (c < 70) return 'ph-cloud-rain'; return 'ph-cloud'; };

        // 1. 純 24 小時制時間邏輯（移除「上午/下午」字樣）
        const getTimePeriod = (t) => { if (!t) return '24h'; return t; };

        // App 內回饋與對話框系統
        const dialog = reactive({ show: false, title: '', message: '', confirmText: '確定', cancelText: '取消', danger: false, showCancel: true, link: '' });
        let dialogResolve = null;
        const appConfirm = (message, opts = {}) => new Promise((resolve) => {
            dialog.title = opts.title || '';
            dialog.message = message;
            dialog.confirmText = opts.confirmText || '確定';
            dialog.cancelText = opts.cancelText || '取消';
            dialog.danger = !!opts.danger;
            dialog.showCancel = opts.showCancel !== false;
            dialog.link = opts.link || '';
            dialogResolve = resolve;
            dialog.show = true;
        });
        const dialogAnswer = (ok) => {
            dialog.show = false;
            if (dialogResolve) { dialogResolve(ok); dialogResolve = null; }
        };

        const toast = reactive({ show: false, message: '', icon: '', hasUndo: false });
        let toastUndoFn = null;
        let toastTimer = null;
        const showToast = (message, opts = {}) => {
            if (toastTimer) clearTimeout(toastTimer);
            toast.message = message;
            toast.icon = opts.icon || 'ph-bold ph-check-circle';
            toastUndoFn = opts.undo || null;
            toast.hasUndo = !!toastUndoFn;
            toast.show = true;
            toastTimer = setTimeout(() => { toast.show = false; toastUndoFn = null; }, opts.duration || (toastUndoFn ? 5000 : 2200));
        };
        const undoToast = () => {
            if (toastUndoFn) toastUndoFn();
            toastUndoFn = null;
            toast.show = false;
            if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        };

        const toggleFlightCard = () => { if (currentDay.value.flight) { } else { currentDay.value.flight = { type: 'arrival', startTime: '10:00', startAirport: 'TPE', startTerminal: '', number: '', endTime: '14:00', endAirport: 'DEST', endTerminal: '', gate: '', seat: '', arrivalOffset: 0 }; editingState.flight = true; } };
        const removeFlight = () => {
            const day = days.value[currentDayIdx.value];
            if (!day || !day.flight) return;
            const removed = day.flight;
            day.flight = null;
            editingState.flight = false;
            showToast('已移除航班資訊', { icon: 'ph-bold ph-trash', undo: () => { day.flight = removed; } });
        };

        // 2. 自由行交通詳細選項定義
        const COMMUTE_MODES = [
            { slug: 'walk', label: '步行', icon: 'ph-bold ph-person-simple-walk' },
            { slug: 'subway', label: '地鐵/捷運', icon: 'ph-bold ph-subway' },
            { slug: 'bus', label: '市公車/巴士', icon: 'ph-bold ph-bus' },
            { slug: 'train', label: '火車/高鐵', icon: 'ph-bold ph-train' },
            { slug: 'taxi', label: '計程車', icon: 'ph-bold ph-taxi' },
            { slug: 'other', label: '其他', icon: 'ph-bold ph-arrows-clockwise' },
        ];
        const commuteMeta = (mode) => COMMUTE_MODES.find(m => m.slug === mode) || null;
        const updateParticipants = () => { participants.value = participantsStr.value.split(',').map(s => s.trim()).filter(s => s); };
        const isUrl = (str) => { if (!str) return false; try { new URL(str); return true; } catch { return /^https?:\/\//i.test(str); } };

        const linkedPlace = (item) => item.placeId ? savedLocations.value.find(l => l.id === item.placeId) : null;
        const itemNavTarget = (item) => { const p = linkedPlace(item); return p ? (p.link || p.name) : (item.link || item.location); };
        const itemLocationLabel = (item) => { const p = linkedPlace(item); return p ? p.name : (item.location || item.link); };

        const sortItemsByTime = (items) => items.sort((a, b) => {
            if (!a.time && !b.time) return 0;
            if (!a.time) return 1;
            if (!b.time) return -1;
            return a.time.localeCompare(b.time);
        });

        // 3. 行程項目彈窗（包含路線與乘車備註 routeNote）
        const itemModal = reactive({ show: false, mode: 'add', targetId: null, draft: null });
        const openItemModal = (item = null) => {
            if (item) {
                itemModal.mode = 'edit'; itemModal.targetId = item.id;
                itemModal.draft = JSON.parse(JSON.stringify(item));
            } else {
                itemModal.mode = 'add'; itemModal.targetId = null;
                itemModal.draft = { id: generateId(), time: '', type: 'spot', activity: '', location: '', link: '', placeId: null, routeNote: '', note: '', reserved: false, commuteMode: '', commuteMinutes: '' };
            }
            itemModal.show = true;
            if (!item) nextTick(() => { document.querySelector('.js-item-activity')?.focus(); });
        };
        const saveItemModal = () => {
            const day = days.value[currentDayIdx.value];
            if (!day) { itemModal.show = false; return; }
            if (itemModal.mode === 'edit') {
                const target = day.items.find(i => i.id === itemModal.targetId);
                if (target) Object.assign(target, itemModal.draft);
            } else {
                day.items.push({ ...itemModal.draft });
            }
            sortItemsByTime(day.items);
            itemModal.show = false;
        };
        const deleteItemFromModal = () => {
            const day = days.value[currentDayIdx.value];
            itemModal.show = false;
            if (!day) return;
            const idx = day.items.findIndex(i => i.id === itemModal.targetId);
            if (idx === -1) return;
            const removed = day.items.splice(idx, 1)[0];
            showToast('已刪除行程', { icon: 'ph-bold ph-trash', undo: () => { day.items.splice(Math.min(idx, day.items.length), 0, removed); } });
        };

        const addDay = () => days.value.push({ date: `Day ${days.value.length + 1}`, title: '', items: [] });

        // 口袋名單彈窗
        const locModal = reactive({ show: false, mode: 'add', targetId: null, draft: null });
        const openLocModal = (loc = null) => {
            if (loc) {
                locModal.mode = 'edit'; locModal.targetId = loc.id;
                locModal.draft = JSON.parse(JSON.stringify(loc));
                if (!locModal.draft.type) locModal.draft.type = 'spot';
            } else {
                locModal.mode = 'add'; locModal.targetId = null;
                locModal.draft = { id: generateId(), name: '', type: 'spot', link: '', note: '' };
            }
            locModal.show = true;
            if (!loc) nextTick(() => { document.querySelector('.js-loc-name')?.focus(); });
        };
        const saveLocModal = () => {
            if (locModal.mode === 'edit') {
                const target = savedLocations.value.find(l => l.id === locModal.targetId);
                if (target) Object.assign(target, locModal.draft);
            } else {
                savedLocations.value.push({ ...locModal.draft });
            }
            locModal.show = false;
        };
        const deleteLocFromModal = () => {
            locModal.show = false;
            const idx = savedLocations.value.findIndex(l => l.id === locModal.targetId);
            if (idx === -1) return;
            const removed = savedLocations.value.splice(idx, 1)[0];
            showToast('已刪除地點', { icon: 'ph-bold ph-trash', undo: () => { savedLocations.value.splice(Math.min(idx, savedLocations.value.length), 0, removed); } });
        };

        // 清單與角色邏輯
        const seedChecklist = () => CHECKLIST_TEMPLATE.map(t => ({ ...t, id: generateId(), checkedBy: {} }));
        const seedDefaultChecklist = () => {
            checklist.value = seedChecklist();
            showToast(`已帶入預設清單（${CHECKLIST_TEMPLATE.length} 項）`, { icon: 'ph-bold ph-suitcase-rolling' });
        };
        const checklistMembers = computed(() => participants.value.length ? participants.value : ['__shared__']);
        const memberLabel = (m) => m === '__shared__' ? '' : m;
        const activeChecklistMember = ref(localStorage.getItem('wetravel_active_checklist_member') || '');
        watch(checklistMembers, (ms) => {
            if (!ms.includes(activeChecklistMember.value)) activeChecklistMember.value = ms[0];
        }, { immediate: true });
        watch(activeChecklistMember, (v) => { if (v) localStorage.setItem('wetravel_active_checklist_member', v); });
        
        const toggleCheck = (item, member) => {
            if (!item.checkedBy) item.checkedBy = {};
            item.checkedBy[member] = !item.checkedBy[member];
        };

        const isCheckNameInvalid = ref(false);
        const checkModal = reactive({ show: false, mode: 'add', targetId: null, draft: null });
        const openCheckModal = (item = null) => {
            isCheckNameInvalid.value = false;
            if (item) {
                checkModal.mode = 'edit'; checkModal.targetId = item.id;
                checkModal.draft = JSON.parse(JSON.stringify(item));
            } else {
                checkModal.mode = 'add'; checkModal.targetId = null;
                checkModal.draft = { id: generateId(), name: '', category: 'misc', luggage: 'any', note: '', checkedBy: {} };
            }
            checkModal.show = true;
            if (!item) nextTick(() => { document.querySelector('.js-check-name')?.focus(); });
        };
        const saveCheckModal = () => {
            if (!checkModal.draft.name.trim()) {
                isCheckNameInvalid.value = true;
                nextTick(() => { document.querySelector('.js-check-name')?.focus(); });
                return;
            }
            if (checkModal.mode === 'edit') {
                const target = checklist.value.find(i => i.id === checkModal.targetId);
                if (target) Object.assign(target, checkModal.draft);
            } else {
                checklist.value.push({ ...checkModal.draft });
            }
            checkModal.show = false;
        };

        // 6. 記帳新增 (含台幣標記與日單對應)
        const itemInputRef = ref(null);
        const isItemInvalid = ref(false);
        const addExpense = () => {
            if (!newExpense.value.item) { isItemInvalid.value = true; nextTick(() => { itemInputRef.value?.focus(); }); return; }
            if (!newExpense.value.amount) { isAmountInvalid.value = true; nextTick(() => { amountInputRef.value?.focus(); }); return; }
            expenses.value.unshift({
                ...newExpense.value,
                id: generateId(),
                dayIndex: currentDayIdx.value,
                splitWith: (newExpense.value.splitWith && newExpense.value.splitWith.length) ? [...newExpense.value.splitWith] : []
            });
            newExpense.value.item = ''; newExpense.value.amount = ''; isItemInvalid.value = false; isAmountInvalid.value = false;
        };

        const expModal = reactive({ show: false, targetId: null, draft: null });
        const openExpModal = (exp) => {
            expModal.targetId = exp.id;
            expModal.draft = JSON.parse(JSON.stringify(exp));
            if (!expModal.draft.category) expModal.draft.category = 'other';
            if (!expModal.draft.paymentMethod) expModal.draft.paymentMethod = 'cash';
            if (expModal.draft.dayIndex === undefined || expModal.draft.dayIndex === null) expModal.draft.dayIndex = currentDayIdx.value;
            if (!Array.isArray(expModal.draft.splitWith)) expModal.draft.splitWith = [];
            expModal.show = true;
        };
        const saveExpModal = () => {
            const target = expenses.value.find(e => e.id === expModal.targetId);
            if (target) Object.assign(target, expModal.draft);
            expModal.show = false;
        };
        const deleteExpFromModal = () => {
            expModal.show = false;
            const idx = expenses.value.findIndex(e => e.id === expModal.targetId);
            if (idx === -1) return;
            const removed = expenses.value.splice(idx, 1)[0];
            showToast('已刪除支出', { icon: 'ph-bold ph-trash', undo: () => { expenses.value.splice(Math.min(idx, expenses.value.length), 0, removed); } });
        };

        const getExternalMapLink = (loc) => { if (!loc) return '#'; if (isUrl(loc)) return loc; const encodedLoc = encodeURIComponent(loc); if (setup.value.mapProvider === 'naver') return `https://map.naver.com/v5/search/${encodedLoc}`; else if (setup.value.mapProvider === 'amap') return `https://www.amap.com/search?query=${encodedLoc}`; else return `https://www.google.com/maps/search/?api=1&query=${encodedLoc}`; };
        const countryInfoMap = { 'jp': { c: 'JPY', l: 'ja', n: '日文', m: 'google' }, 'kr': { c: 'KRW', l: 'ko', n: '韓文', m: 'naver' }, 'us': { c: 'USD', l: 'en', n: '英文', m: 'google' }, 'cn': { c: 'CNY', l: 'zh-CN', n: '簡中', m: 'amap' }, 'th': { c: 'THB', l: 'th', n: '泰文', m: 'google' }, 'tw': { c: 'TWD', l: 'zh-TW', n: '中文', m: 'google' } };

        const toggleWeatherEdit = () => { isWeatherEditing.value = !isWeatherEditing.value; if (isWeatherEditing.value) { nextTick(() => weatherInputRef.value?.focus()); } };
        const updateWeatherLocation = () => { isWeatherEditing.value = false; if (weather.value.location) { fetchWeather(weather.value.location); } };
        const fetchWeather = async (locName) => {
            try {
                weather.value.location = locName;
                const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locName)}&limit=1`);
                const geoData = await geoRes.json();
                if (geoData?.[0]) {
                    const { lat, lon } = geoData[0];
                    const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=16`);
                    const wData = await wRes.json();
                    weather.value.temp = Math.round(wData.current_weather.temperature);
                    weather.value.icon = getWeatherIcon(wData.current_weather.weathercode);
                    if (wData.daily) weather.value.daily = wData.daily;
                }
            } catch (e) { weather.value.temp = '--'; }
        };

        const initSortable = () => {
            const el = document.getElementById('saved-locations-list');
            if (!el) return false;
            if (Sortable.get && Sortable.get(el)) return true;
            Sortable.create(el, {
                animation: 150, handle: '.loc-drag-handle', ghostClass: 'sortable-ghost', dragClass: 'sortable-drag',
                onEnd: (evt) => {
                    const item = savedLocations.value.splice(evt.oldIndex, 1)[0];
                    savedLocations.value.splice(evt.newIndex, 0, item);
                }
            });
            return true;
        };

        const initSortableWhenReady = () => {
            let attempts = 0;
            const timer = setInterval(() => {
                attempts++;
                if (initSortable() || attempts > 20) clearInterval(timer);
            }, 100);
        };

        watch(viewMode, (v) => { if (v === 'saved') initSortableWhenReady(); });

        onMounted(() => {
            if (window.__hideSplash) window.__hideSplash();
            // 預設建立一組空資料
            if (days.value.length === 0) {
                days.value = Array.from({ length: 5 }, (_, i) => ({
                    date: `Day ${i + 1}`,
                    shortDate: `D${i + 1}`,
                    title: i === 0 ? '出發與景點' : '行程規劃',
                    items: [],
                    flight: i === 0 ? { startAirport: 'TPE', startTime: '10:00', endAirport: 'NRT', endTime: '14:00', number: 'BR198' } : null
                }));
            }
            if (participants.value.length === 0) {
                participants.value = ['我'];
                participantsStr.value = '我';
                newExpense.value.payer = '我';
            }
        });

        return {
            viewMode, currentDayIdx, amountInputRef, isAmountInvalid, weatherInputRef,
            showTripMenu, tripList, currentTripId, showSetupModal, isEditing, isDataLoading, isLoggedIn,
            dbError, dbErrorMessage, syncStatus, shareUrl, showShareModal, showJoinInput, joinTripUrl,
            editingState, days, savedLocations, expenses, checklist, prepTasks, newPrepTask,
            addPrepTask, togglePrepTask, deletePrepTask, collapsedCats, participants, participantsStr,
            exchangeRate, newExpense, customCategories, allExpenseCategories, newCustomCategory,
            showCustomCategoryInput, addCustomCategory, isRateLoading, weather, isWeatherEditing, setup,
            currentDay, totalExpense, paidByPerson, effectiveSplitWith, owedByPerson, categoryTotals,
            categoryPieSlices, personBarData, dayLabel, newParticipant, addParticipant, removeParticipant,
            toggleSplitMember, isSplitChecked, currencyLabel, currencySymbol, mapProviderLabel, weatherDisplay,
            generateId, localDateStr, fmtExpDate, getWeatherIcon, getTimePeriod, dialog, appConfirm, dialogAnswer,
            toast, showToast, undoToast, toggleFlightCard, removeFlight, COMMUTE_MODES, commuteMeta,
            updateParticipants, isUrl, linkedPlace, itemNavTarget, itemLocationLabel, itemModal, openItemModal,
            saveItemModal, deleteItemFromModal, addDay, locModal, openLocModal, saveLocModal, deleteLocFromModal,
            seedChecklist, seedDefaultChecklist, checklistMembers, memberLabel, activeChecklistMember,
            toggleCheck, isCheckNameInvalid, checkModal, openCheckModal, saveCheckModal, itemInputRef,
            isItemInvalid, addExpense, expModal, openExpModal, saveExpModal, deleteExpFromModal,
            getExternalMapLink, toggleWeatherEdit, updateWeatherLocation
        };
    }
}).mount('#app');
