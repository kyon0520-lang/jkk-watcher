const SERVER_URL = 'https://jkk-server.onrender.com';
const VAPID_PUBLIC_KEY = 'BAd096iDmIS3vOKee-wVqysH5F2YGqY7OsAqEKtxPbZDbMfmNKwxw0xZ1s6zgePtL1IDhWvryMpugudtp-ZNiDA';

let state = {
    notificationsEnabled: false,
    properties: [],
    favorites: JSON.parse(localStorage.getItem('favorites') || '[]'),
    filters: ['全エリア', '23区', '多摩地域', '港区', '新宿区', '渋谷区'],
    activeFilter: '全エリア',
    activeTab: 'home',
    notifyFilters: JSON.parse(localStorage.getItem('notifyFilters') || '[]'),
};

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('Service Worker登録成功', reg))
        .catch(err => console.error('Service Worker登録失敗', err));
}

let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('installPrompt').style.display = 'block';
});

function installApp() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(() => {
            deferredPrompt = null;
            document.getElementById('installPrompt').style.display = 'none';
        });
    }
}

function dismissInstall() {
    document.getElementById('installPrompt').style.display = 'none';
}

async function toggleNotifications() {
    const btn = document.getElementById('notificationBtn');
    if (!state.notificationsEnabled) {
        if (!('Notification' in window)) {
            alert('このブラウザは通知に対応していません');
            return;
        }
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            state.notificationsEnabled = true;
            btn.classList.remove('disabled');
            updateStatusBanner('リアルタイム監視中 - 新着物件を自動チェック', 'success');
            await subscribeToPush();
        }
    } else {
        state.notificationsEnabled = false;
        btn.classList.add('disabled');
        updateStatusBanner('通知をオンにすると新着物件を即座にお知らせします', 'warning');
    }
}

async function subscribeToPush() {
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
        await fetch(`${SERVER_URL}/api/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subscription,
                filters: state.notifyFilters
            })
        });
        console.log('サーバーにサブスクリプション登録完了！フィルター:', state.notifyFilters);
    } catch (error) {
        console.error('プッシュ通知サブスクリプション失敗:', error);
    }
}

async function updateFiltersOnServer() {
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
            await fetch(`${SERVER_URL}/api/subscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subscription,
                    filters: state.notifyFilters
                })
            });
            console.log('フィルター更新完了:', state.notifyFilters);
        }
    } catch (error) {
        console.error('フィルター更新失敗:', error);
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

function updateStatusBanner(message, type) {
    const banner = document.getElementById('statusBanner');
    banner.style.display = 'flex';
    banner.className = `status-banner ${type === 'warning' ? 'warning' : ''}`;
    banner.innerHTML = `
        <svg width="20" height="20" fill="white" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
        </svg>
        <span>${message}</span>
    `;
}

function initFilters() {
    const container = document.getElementById('filterButtons');
    container.innerHTML = state.filters.map(filter => `
        <button class="filter-btn ${filter === state.activeFilter ? 'active' : ''}"
                onclick="setFilter('${filter}')">
            ${filter}
        </button>
    `).join('');
}

function setFilter(filter) {
    state.activeFilter = filter;
    initFilters();
    renderProperties();
}

async function loadPropertiesFromServer() {
    try {
        const response = await fetch(`${SERVER_URL}/api/properties`);
        const data = await response.json();
        if (data.success) {
            state.properties = data.properties;
            renderProperties();
        }
    } catch (error) {
        console.error('データ取得エラー:', error);
    }
}

function formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - new Date(date);
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'たった今';
    if (diffMins < 60) return `${diffMins}分前`;
    if (diffHours < 24) return `${diffHours}時間前`;
    return `${diffDays}日前`;
}

function renderProperties() {
    const container = document.getElementById('propertyList');
    let filteredProperties = state.properties;
    if (state.activeFilter !== '全エリア') {
        filteredProperties = state.properties.filter(p => {
            if (state.activeFilter === '23区') {
                return ['港区', '新宿区', '渋谷区', '世田谷区', '杉並区'].some(k => p.address?.includes(k));
            }
            return p.address?.includes(state.activeFilter);
        });
    }
    if (filteredProperties.length === 0) {
        container.innerHTML = '<div class="loading">物件が見つかりませんでした</div>';
        return;
    }
    container.innerHTML = filteredProperties.map(property => `
        <div class="property-card">
            <div class="property-header">
                <div class="property-info">
                    <div class="property-name">${property.name}</div>
                    <div class="property-address">
                        <svg width="16" height="16" fill="#666" viewBox="0 0 24 24">
                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
                        </svg>
                        <span>${property.address}</span>
                    </div>
                    <div class="property-tags">
                        <span class="tag tag-layout">${property.layout}</span>
                        <span class="tag tag-area">${property.area}㎡</span>
                    </div>
                </div>
                <div class="property-price">
                    <div class="rent-amount">¥${property.rent}</div>
                    <div class="rent-label">月額賃料</div>
                    <button class="favorite-btn ${state.favorites.includes(property.id) ? 'active' : ''}"
                            onclick="toggleFavorite('${property.id}')">
                        <svg width="20" height="20" fill="${state.favorites.includes(property.id) ? 'white' : '#999'}" viewBox="0 0 24 24">
                            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="property-footer">
                <span class="posted-time">取得: ${formatTimeAgo(property.foundAt)}</span>
                <button class="detail-btn" onclick="window.open('${property.url}', '_blank')">詳細を見る</button>
            </div>
        </div>
    `).join('');
}

function toggleFavorite(id) {
    if (state.favorites.includes(id)) {
        state.favorites = state.favorites.filter(fav => fav !== id);
    } else {
        state.favorites.push(id);
    }
    localStorage.setItem('favorites', JSON.stringify(state.favorites));
    renderProperties();
}

function renderSettings() {
    const container = document.getElementById('propertyList');
    container.innerHTML = `
        <div class="property-card">
            <h3 style="margin-bottom:15px;font-size:18px;font-weight:700;">🔔 通知フィルター設定</h3>
            <p style="color:#666;font-size:14px;margin-bottom:15px;">
                通知したい物件名を入力してください。<br>
                空欄の場合は全ての新着物件を通知します。
            </p>
            <div style="display:flex;gap:10px;margin-bottom:15px;">
                <input id="filterInput" type="text" placeholder="物件名を入力（例：落合）"
                    style="flex:1;padding:10px;border-radius:10px;border:2px solid #eee;font-size:14px;">
                <button onclick="addNotifyFilter()"
                    style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;padding:10px 20px;border-radius:10px;font-size:14px;cursor:pointer;">
                    追加
                </button>
            </div>
            <div id="filterList">
                ${renderFilterList()}
            </div>
        </div>
    `;
}

function renderFilterList() {
    if (state.notifyFilters.length === 0) {
        return '<p style="color:#999;font-size:14px;">フィルターなし（全物件を通知）</p>';
    }
    return state.notifyFilters.map(f => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:#f5f5f5;border-radius:10px;margin-bottom:8px;">
            <span style="font-size:14px;font-weight:600;">${f}</span>
            <button onclick="removeNotifyFilter('${f}')"
                style="background:#f5576c;color:white;border:none;padding:5px 10px;border-radius:8px;font-size:12px;cursor:pointer;">
                削除
            </button>
        </div>
    `).join('');
}

function addNotifyFilter() {
    const input = document.getElementById('filterInput');
    const value = input.value.trim();
    if (value && !state.notifyFilters.includes(value)) {
        state.notifyFilters.push(value);
        localStorage.setItem('notifyFilters', JSON.stringify(state.notifyFilters));
        input.value = '';
        document.getElementById('filterList').innerHTML = renderFilterList();
        updateFiltersOnServer();
    }
}

function removeNotifyFilter(filter) {
    state.notifyFilters = state.notifyFilters.filter(f => f !== filter);
    localStorage.setItem('notifyFilters', JSON.stringify(state.notifyFilters));
    document.getElementById('filterList').innerHTML = renderFilterList();
    updateFiltersOnServer();
}

function switchTab(tab) {
    state.activeTab = tab;
    const buttons = document.querySelectorAll('.nav-btn');
    buttons.forEach((btn, index) => {
        const tabs = ['home', 'search', 'favorites', 'settings'];
        if (tabs[index] === tab) btn.classList.add('active');
        else btn.classList.remove('active');
    });
    if (tab === 'favorites') {
        const favoriteProperties = state.properties.filter(p => state.favorites.includes(p.id));
        const container = document.getElementById('propertyList');
        if (favoriteProperties.length === 0) {
            container.innerHTML = '<div class="loading">お気に入りの物件がありません</div>';
        } else {
            const temp = state.properties;
            state.properties = favoriteProperties;
            renderProperties();
            state.properties = temp;
        }
    } else if (tab === 'home') {
        loadPropertiesFromServer();
    } else if (tab === 'settings') {
        renderSettings();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initFilters();
    loadPropertiesFromServer();
    if (window.matchMedia('(display-mode: standalone)').matches) {
        document.getElementById('installPrompt').style.display = 'none';
    }
    const notificationBtn = document.getElementById('notificationBtn');
    if (Notification.permission === 'granted') {
        notificationBtn.classList.remove('disabled');
        state.notificationsEnabled = true;
        updateStatusBanner('リアルタイム監視中 - 新着物件を自動チェック', 'success');
    } else {
        notificationBtn.classList.add('disabled');
        updateStatusBanner('通知をオンにすると新着物件を即座にお知らせします', 'warning');
    }
    setInterval(loadPropertiesFromServer, 5 * 60 * 1000);
});
