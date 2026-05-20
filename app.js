// アプリの状態管理
let state = {
    notificationsEnabled: false,
    properties: [],
    favorites: JSON.parse(localStorage.getItem('favorites') || '[]'),
    filters: ['全エリア', '23区', '多摩地域', '港区', '新宿区', '渋谷区', '世田谷区', '杉並区'],
    activeFilter: '全エリア',
    activeTab: 'home',
    lastCheck: null
};

// Service Worker登録
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('Service Worker登録成功', reg))
        .catch(err => console.error('Service Worker登録失敗', err));
}

// PWAインストールプロンプト
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('installPrompt').style.display = 'block';
});

function installApp() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                console.log('PWAインストール承諾');
            }
            deferredPrompt = null;
            document.getElementById('installPrompt').style.display = 'none';
        });
    }
}

function dismissInstall() {
    document.getElementById('installPrompt').style.display = 'none';
    localStorage.setItem('installDismissed', 'true');
}

// 通知許可のリクエスト
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
            updateStatusBanner('監視開始', 'リアルタイム監視中 - 新着物件を自動チェック', 'success');
            
            // プッシュ通知のサブスクリプション
            subscribeToPush();
            
            // 定期チェック開始
            startPropertyCheck();
        } else {
            alert('通知を有効にするには、ブラウザの設定で通知を許可してください');
        }
    } else {
        state.notificationsEnabled = false;
        btn.classList.add('disabled');
        updateStatusBanner('監視停止', '通知をオンにすると新着物件を即座にお知らせします', 'warning');
        stopPropertyCheck();
    }
}

// プッシュ通知のサブスクリプション
async function subscribeToPush() {
    try {
        const registration = await navigator.serviceWorker.ready;
        
        // 公開鍵（実際のサーバーと連携する場合はサーバーから取得）
        const vapidPublicKey = 'YOUR_VAPID_PUBLIC_KEY_HERE';
        
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
        });
        
        console.log('プッシュ通知サブスクリプション成功:', subscription);
        
        // サーバーにサブスクリプション情報を送信（実装時）
        // await sendSubscriptionToServer(subscription);
        
    } catch (error) {
        console.error('プッシュ通知サブスクリプション失敗:', error);
    }
}

// Base64変換ユーティリティ
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// ステータスバナー更新
function updateStatusBanner(title, message, type) {
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

// フィルターボタン初期化
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

// 物件データの取得（デモ用サンプルデータ）
function getSampleProperties() {
    return [
        {
            id: 1,
            name: '平山住宅',
            address: '日野市平山5丁目',
            rent: 67000,
            layout: '3DK',
            area: '56.82',
            region: '多摩地域',
            isNew: true,
            postedAt: new Date(Date.now() - 2 * 60000)
        },
        {
            id: 2,
            name: '東大和向原住宅',
            address: '東大和市向原6丁目',
            rent: 52000,
            layout: '2DK',
            area: '45.12',
            region: '多摩地域',
            isNew: true,
            postedAt: new Date(Date.now() - 5 * 60000)
        },
        {
            id: 3,
            name: '青山北町アパート',
            address: '港区北青山2丁目',
            rent: 128000,
            layout: '2LDK',
            area: '58.94',
            region: '港区',
            isNew: false,
            postedAt: new Date(Date.now() - 60 * 60000)
        },
        {
            id: 4,
            name: '代々木住宅',
            address: '渋谷区代々木1丁目',
            rent: 95000,
            layout: '1LDK',
            area: '42.18',
            region: '渋谷区',
            isNew: false,
            postedAt: new Date(Date.now() - 120 * 60000)
        },
        {
            id: 5,
            name: '世田谷上馬アパート',
            address: '世田谷区上馬4丁目',
            rent: 78000,
            layout: '2DK',
            area: '48.32',
            region: '世田谷区',
            isNew: false,
            postedAt: new Date(Date.now() - 180 * 60000)
        }
    ];
}

// 経過時間のフォーマット
function formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'たった今';
    if (diffMins < 60) return `${diffMins}分前`;
    if (diffHours < 24) return `${diffHours}時間前`;
    return `${diffDays}日前`;
}

// 物件リストのレンダリング
function renderProperties() {
    const container = document.getElementById('propertyList');
    let filteredProperties = state.properties;

    // フィルター適用
    if (state.activeFilter !== '全エリア') {
        if (state.activeFilter === '23区') {
            filteredProperties = state.properties.filter(p => 
                ['港区', '新宿区', '渋谷区', '世田谷区', '杉並区'].includes(p.region)
            );
        } else {
            filteredProperties = state.properties.filter(p => p.region === state.activeFilter);
        }
    }

    if (filteredProperties.length === 0) {
        container.innerHTML = '<div class="loading">物件が見つかりませんでした</div>';
        return;
    }

    container.innerHTML = filteredProperties.map(property => `
        <div class="property-card ${property.isNew ? 'new' : ''}">
            ${property.isNew ? '<div class="new-badge">NEW</div>' : ''}
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
                    <div class="rent-amount">¥${property.rent.toLocaleString()}</div>
                    <div class="rent-label">月額賃料</div>
                    <button class="favorite-btn ${state.favorites.includes(property.id) ? 'active' : ''}" 
                            onclick="toggleFavorite(${property.id})">
                        <svg width="20" height="20" fill="${state.favorites.includes(property.id) ? 'white' : '#999'}" viewBox="0 0 24 24">
                            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="property-footer">
                <span class="posted-time">掲載: ${formatTimeAgo(property.postedAt)}</span>
                <button class="detail-btn" onclick="openDetail(${property.id})">詳細を見る</button>
            </div>
        </div>
    `).join('');
}

// お気に入りトグル
function toggleFavorite(id) {
    if (state.favorites.includes(id)) {
        state.favorites = state.favorites.filter(fav => fav !== id);
    } else {
        state.favorites.push(id);
    }
    localStorage.setItem('favorites', JSON.stringify(state.favorites));
    renderProperties();
}

// 詳細表示
function openDetail(id) {
    const property = state.properties.find(p => p.id === id);
    if (property) {
        // 実際のアプリではJKKねっとの該当ページを開く
        alert(`物件詳細:\n\n${property.name}\n${property.address}\n家賃: ¥${property.rent.toLocaleString()}\n間取り: ${property.layout}\n面積: ${property.area}㎡\n\n実際のアプリではJKKねっとのページを開きます。`);
    }
}

// タブ切り替え
function switchTab(tab) {
    state.activeTab = tab;
    const buttons = document.querySelectorAll('.nav-btn');
    buttons.forEach((btn, index) => {
        const tabs = ['home', 'search', 'favorites', 'settings'];
        if (tabs[index] === tab) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // タブに応じた表示切り替え（簡易実装）
    if (tab === 'favorites') {
        const favoriteProperties = state.properties.filter(p => state.favorites.includes(p.id));
        const container = document.getElementById('propertyList');
        if (favoriteProperties.length === 0) {
            container.innerHTML = '<div class="loading">お気に入りの物件がありません</div>';
        } else {
            state.properties = favoriteProperties;
            renderProperties();
        }
    } else if (tab === 'home') {
        loadProperties();
    }
}

// 物件チェック開始
let checkInterval;
function startPropertyCheck() {
    // 初回チェック
    checkForNewProperties();
    
    // 30秒ごとに定期チェック
    checkInterval = setInterval(checkForNewProperties, 30000);
}

function stopPropertyCheck() {
    if (checkInterval) {
        clearInterval(checkInterval);
    }
}

// 新着物件チェック（実際のアプリではサーバーAPIを呼び出す）
async function checkForNewProperties() {
    console.log('新着物件をチェック中...');
    state.lastCheck = new Date();
    
    // デモ: ランダムで新着物件を追加
    if (Math.random() > 0.7) {
        const newProperty = {
            id: Date.now(),
            name: ['新宿御苑アパート', '代官山住宅', '吉祥寺南町住宅', '三鷹台住宅'][Math.floor(Math.random() * 4)],
            address: ['新宿区内藤町', '渋谷区代官山町', '武蔵野市吉祥寺南町', '三鷹市井の頭'][Math.floor(Math.random() * 4)],
            rent: Math.floor(Math.random() * 80000) + 50000,
            layout: ['1K', '1DK', '2DK', '2LDK', '3DK'][Math.floor(Math.random() * 5)],
            area: `${Math.floor(Math.random() * 40) + 35}.${Math.floor(Math.random() * 100)}`,
            region: ['新宿区', '渋谷区', '多摩地域'][Math.floor(Math.random() * 3)],
            isNew: true,
            postedAt: new Date()
        };
        
        // 既存物件のNEWフラグを解除
        state.properties.forEach(p => p.isNew = false);
        
        // 新着物件を追加
        state.properties.unshift(newProperty);
        state.properties = state.properties.slice(0, 20); // 最新20件のみ保持
        
        renderProperties();
        
        // 通知を送信
        if (state.notificationsEnabled) {
            sendNotification(newProperty);
        }
    }
}

// 通知送信
function sendNotification(property) {
    if ('Notification' in window && Notification.permission === 'granted') {
        const notification = new Notification('🏠 JKK新着物件', {
            body: `${property.name}\n${property.layout} ¥${property.rent.toLocaleString()}/月\n${property.address}`,
            icon: 'icon-192.png',
            badge: 'icon-192.png',
            tag: `property-${property.id}`,
            requireInteraction: true,
            data: { propertyId: property.id }
        });

        notification.onclick = function() {
            window.focus();
            this.close();
            openDetail(property.id);
        };
    }
}

// 物件データ読み込み
function loadProperties() {
    state.properties = getSampleProperties();
    renderProperties();
}

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    initFilters();
    loadProperties();
    
    // インストール済みの場合はプロンプトを非表示
    if (window.matchMedia('(display-mode: standalone)').matches) {
        document.getElementById('installPrompt').style.display = 'none';
    }
    
    // 通知ボタンの初期状態
    const notificationBtn = document.getElementById('notificationBtn');
    if (Notification.permission === 'granted') {
        notificationBtn.classList.remove('disabled');
    } else {
        notificationBtn.classList.add('disabled');
    }
    
    // 初期ステータス
    updateStatusBanner('待機中', '通知をオンにすると新着物件を即座にお知らせします', 'warning');
});
