/**
 * DynaPM 管理界面
 */

const API_BASE = '/_dynapm/api';

/**
 * 格式化运行时长
 */
function formatUptime(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}秒`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}分钟 ${seconds % 60}秒`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}小时 ${remainingMinutes}分钟`;
}

/**
 * 格式化相对时间
 */
function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 1000) {
    return '刚刚';
  }
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {
    return `${seconds}秒前`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}小时前`;
  }
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

/**
 * 获取状态显示文本
 */
function getStatusText(status) {
  const statusMap = {
    'online': '运行中',
    'starting': '启动中',
    'offline': '离线',
  };
  return statusMap[status] || status;
}

/**
 * 获取状态 CSS 类
 */
function getStatusClass(status) {
  return `status-${status}`;
}

/**
 * 创建服务卡片 HTML
 */
function createServiceCard(service) {
  const isOnline = service.status === 'online';
  const isStarting = service.status === 'starting';
  const isOffline = service.status === 'offline';

  return `
    <div class="service-card" data-service-name="${service.name}">
      <div class="service-header">
        <div class="service-name">${service.name}</div>
        <div class="service-status ${getStatusClass(service.status)}">
          ${getStatusText(service.status)}
        </div>
      </div>

      <div class="service-info">
        <div class="info-item">
          <div class="info-label">域名</div>
          <div class="info-value">${service.hostname}</div>
        </div>
        <div class="info-item">
          <div class="info-label">运行时长</div>
          <div class="info-value">${formatUptime(service.uptime)}</div>
        </div>
        <div class="info-item">
          <div class="info-label">最后活动</div>
          <div class="info-value">${formatRelativeTime(service.lastAccessTime)}</div>
        </div>
        <div class="info-item">
          <div class="info-label">活动连接</div>
          <div class="info-value">${service.activeConnections}</div>
        </div>
        <div class="info-item">
          <div class="info-label">闲置超时</div>
          <div class="info-value">${Math.floor(service.idleTimeout / 60000)}分钟</div>
        </div>
        ${service.proxyOnly ? `
        <div class="info-item">
          <div class="info-label">模式</div>
          <div class="info-value">纯代理</div>
        </div>
        ` : ''}
      </div>

      <div class="service-actions">
        ${isOffline ? `
          <button class="btn btn-primary" onclick="startService('${service.name}')">
            ▶️ 启动服务
          </button>
        ` : ''}
        ${isOnline ? `
          <button class="btn btn-danger" onclick="stopService('${service.name}')">
            ⏸️ 停止服务
          </button>
        ` : ''}
        ${isStarting ? `
          <button class="btn btn-secondary" disabled>
            ⏳ 启动中...
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

/**
 * 加载服务列表
 */
async function loadServices() {
  try {
    const response = await fetch(`${API_BASE}/services`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    displayServices(data.services);
  } catch (error) {
    console.error('加载服务列表失败:', error);
    displayError(`加载失败: ${error.message}`);
  }
}

/**
 * 显示服务列表
 */
function displayServices(services) {
  const container = document.getElementById('services-container');
  const serviceCount = document.getElementById('service-count');

  if (!services || services.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <h2>暂无服务</h2>
        <p>请在 dynapm.config.ts 中配置服务</p>
      </div>
    `;
    serviceCount.textContent = '0 个服务';
    return;
  }

  container.innerHTML = services.map(createServiceCard).join('');
  serviceCount.textContent = `${services.length} 个服务`;
}

/**
 * 显示错误信息
 */
function displayError(message) {
  const container = document.getElementById('services-container');
  container.innerHTML = `
    <div class="error">
      <h2>❌ 错误</h2>
      <p>${message}</p>
    </div>
  `;
}

/**
 * 启动服务
 */
async function startService(serviceName) {
  const card = document.querySelector(`[data-service-name="${serviceName}"]`);
  if (card) {
    const actionsDiv = card.querySelector('.service-actions');
    actionsDiv.innerHTML = `
      <button class="btn btn-secondary" disabled>
        ⏳ 启动中...
      </button>
    `;
  }

  try {
    const response = await fetch(`${API_BASE}/services/${serviceName}/start`, {
      method: 'POST',
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '启动失败');
    }

    // 刷新服务列表
    setTimeout(loadServices, 1000);
  } catch (error) {
    console.error('启动服务失败:', error);
    alert(`启动失败: ${error.message}`);
    loadServices();
  }
}

/**
 * 停止服务
 */
async function stopService(serviceName) {
  if (!confirm(`确定要停止服务 "${serviceName}" 吗？`)) {
    return;
  }

  const card = document.querySelector(`[data-service-name="${serviceName}"]`);
  if (card) {
    const actionsDiv = card.querySelector('.service-actions');
    actionsDiv.innerHTML = `
      <button class="btn btn-secondary" disabled>
        ⏳ 停止中...
      </button>
    `;
  }

  try {
    const response = await fetch(`${API_BASE}/services/${serviceName}/stop`, {
      method: 'POST',
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '停止失败');
    }

    // 刷新服务列表
    setTimeout(loadServices, 500);
  } catch (error) {
    console.error('停止服务失败:', error);
    alert(`停止失败: ${error.message}`);
    loadServices();
  }
}

/**
 * 初始化应用
 */
function init() {
  // 加载服务列表
  loadServices();

  // 绑定刷新按钮
  document.getElementById('refresh-btn').addEventListener('click', loadServices);

  // 自动刷新（每 5 秒）
  setInterval(loadServices, 5000);
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);

// 将函数暴露到全局作用域
window.startService = startService;
window.stopService = stopService;
