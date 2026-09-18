const { createApp, ref, computed } = Vue;

const EXPENSE_CATEGORIES = [
    { slug: 'flight', label: '機票', emoji: '✈️' },
    { slug: 'transport', label: '交通', emoji: '🚗' },
    { slug: 'lodging', label: '住宿', emoji: '🏨' },
    { slug: 'food', label: '餐飲', emoji: '🍜' },
    { slug: 'shopping', label: '購物/伴手禮', emoji: '🛍️' },
    { slug: 'ticket', label: '票券', emoji: '🎫' },
    { slug: 'other', label: '其他', emoji: '💰' },
];

const PAYMENT_METHODS = [
    { slug: 'cash', label: '現金', emoji: '💵' },
    { slug: 'credit', label: '信用卡', emoji: '💳' },
    { slug: 'mobile', label: '行動支付', emoji: '📱' },
    { slug: 'other', label: '其他', emoji: '🔖' },
];

createApp({
    setup() {
        const currentTab = ref('itinerary');
        const currentCurrency = ref('CNY');

        const tripDays = ref([
            {
                date: '09/18',
                week: '五',
                title: '抵達 & 探索',
                flight: {
                    airline: '春秋航空',
                    code: '9C8880',
                    startAirport: 'KHH',
                    startTime: '18:15',
                    startTerminal: 'T1',
                    endAirport: 'PVG',
                    endTime: '20:35',
                    endTerminal: 'T2',
                    gate: 'A12',
                    seat: '18A'
                },
                items: [
                    {
                        id: 1,
                        time: '21:00',
                        period: '晚上',
                        title: '機場-旅館',
                        location: '如家商旅酒店(上海陸家嘴世紀大道地鐵站店)',
                        transit: '地鐵【2號線】到【世紀大道】',
                        note: '搭乘 2 號線約 60 分鐘，直達世紀大道站。'
                    },
                    {
                        id: 2,
                        time: '21:30',
                        period: '晚上',
                        title: '如家 陸家嘴世紀大道',
                        location: '上海市浦東新區世紀大道',
                        note: '辦理入住，12點前退房。'
                    }
                ]
            },
            { date: '09/19', week: '六', title: '水鄉巡禮', items: [] },
            { date: '09/20', week: '日', title: '宮宴。武...', items: [] },
            { date: '09/21', week: '一', title: '行程規劃', items: [] }
        ]);

        const selectedDayIndex = ref(0);
        const currentDay = computed(() => tripDays.value[selectedDayIndex.value] || tripDays.value[0]);

        // 行程編輯 Modal (預設 false 關閉)
        const isEditModalOpen = ref(false);
        const editingItem = ref(null);
        const targetDayIndex = ref(0);

        function openEditModal(item, dayIdx) {
            editingItem.value = JSON.parse(JSON.stringify(item));
            selectedDayIndex.value = dayIdx;
            targetDayIndex.value = dayIdx;
            isEditModalOpen.value = true;
        }

        function saveScheduleItem() {
            if (!editingItem.value) return;

            if (targetDayIndex.value !== selectedDayIndex.value) {
                const sourceList = tripDays.value[selectedDayIndex.value].items;
                const idx = sourceList.findIndex(i => i.id === editingItem.value.id);
                if (idx !== -1) sourceList.splice(idx, 1);

                tripDays.value[targetDayIndex.value].items.push(editingItem.value);
                tripDays.value[targetDayIndex.value].items.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
            } else {
                const list = tripDays.value[selectedDayIndex.value].items;
                const idx = list.findIndex(i => i.id === editingItem.value.id);
                if (idx !== -1) list[idx] = { ...editingItem.value };
            }
            isEditModalOpen.value = false;
        }

        // 清單資料
        const checklistData = ref({
            prep: [
                { id: 101, name: '網卡 / 台胞證準備', done: true },
                { id: 102, name: '填寫海關指尖服務預約', done: false }
            ],
            carryOn: [
                { id: 201, name: '護照 / 身分證', done: true },
                { id: 202, name: '行動電源與充電線', done: true },
                { id: 203, name: '少量現金 (CNY)', done: false }
            ],
            luggage: [
                { id: 301, name: '換洗衣物 4 套', done: false },
                { id: 302, name: '個人盥洗保養品', done: false },
                { id: 303, name: '常備藥品', done: true }
            ]
        });

        const checklistSections = ref({ prep: true, carryOn: true, luggage: true });

        const totalChecklistItems = computed(() => {
            const d = checklistData.value;
            return d.prep.length + d.carryOn.length + d.luggage.length;
        });

        const completedChecklistItems = computed(() => {
            const d = checklistData.value;
            return [...d.prep, ...d.carryOn, ...d.luggage].filter(i => i.done).length;
        });

        const checklistProgress = computed(() => {
            if (totalChecklistItems.value === 0) return 0;
            return Math.round((completedChecklistItems.value / totalChecklistItems.value) * 100);
        });

        function toggleCheck(item) {
            item.done = !item.done;
        }

        // 記帳編輯 Modal (預設 false 關閉)
        const isExpenseModalOpen = ref(false);
        const editingExpense = ref({
            title: '春秋來回機票',
            amount: 8880,
            category: 'flight',
            payment: 'credit',
            payer: '佳'
        });

        return {
            currentTab,
            currentCurrency,
            tripDays,
            selectedDayIndex,
            currentDay,
            isEditModalOpen,
            editingItem,
            targetDayIndex,
            openEditModal,
            saveScheduleItem,

            // 清單
            checklistData,
            checklistSections,
            totalChecklistItems,
            completedChecklistItems,
            checklistProgress,
            toggleCheck,

            // 記帳
            isExpenseModalOpen,
            editingExpense,
            categories: EXPENSE_CATEGORIES,
            payments: PAYMENT_METHODS
        };
    }
}).mount('#app');
