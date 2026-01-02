/**
 * MoveCar Worker - 单码多车版
 * * 环境变量 (Environment Variables):
 * CAR_LIST: 必需。格式为CSV，每行一条: 车牌号,BarkURL,电话号码(可选)
 * 示例:
 * 沪A888666,https://api.day.app/yyy/,02166668888
 * 苏E12345,https://api.day.app/xxx/,13800000000
 * * KV 绑定 (KV Namespace Bindings):
 * MOVE_CAR_STATUS: 必需。用于存储挪车状态和位置信息。
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = { KV_TTL: 3600 } // 缓存1小时

async function handleRequest(request) {

  const country = request.cf?.country;
  // 如果能识别到国家且不是中国（CN），则拒绝访问
  if (country && country !== 'CN') {
    return new Response('访问被拒绝（仅限中国大陆地区访问）。', { status: 403 });
  }

  const url = new URL(request.url)
  const path = url.pathname

  // API: 验证车牌是否存在
  if (path === '/api/verify-license' && request.method === 'POST') {
    return handleVerifyLicense(request);
  }

  // API: 发起挪车通知
  if (path === '/api/notify' && request.method === 'POST') {
    return handleNotify(request, url);
  }

  // API: 获取位置 (车主获取挪车人位置)
  if (path === '/api/get-location') {
    return handleGetLocation(url);
  }

  // API: 车主确认 (POST)
  if (path === '/api/owner-confirm' && request.method === 'POST') {
    return handleOwnerConfirmAction(request);
  }

  // API: 检查状态 (挪车人轮询)
  if (path === '/api/check-status') {
    return handleCheckStatus(url);
  }

  // 页面: 挪车操作页 (验证车牌后跳转)
  if (path === '/notify') {
    const license = url.searchParams.get('plate');
    if (!license || !getCarConfig(license)) {
      return new Response('无效的链接或车牌', { status: 400 });
    }
    return renderNotifyPage(url.origin, license);
  }

  // 页面: 车主确认页
  if (path === '/owner-confirm') {
    const license = url.searchParams.get('plate');
    if (!license) return new Response('缺少参数', { status: 400 });
    return renderOwnerPage(license);
  }

  // 默认首页: 输入车牌页
  return renderIndexPage();
}

// --- 核心逻辑 ---

// 从环境变量 CAR_LIST 中解析车辆配置
function getCarConfig(license) {
  if (typeof CAR_LIST === 'undefined') return null;
  
  const targetPlate = license.trim().toUpperCase();
  const lines = CAR_LIST.split('\n');
  
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(',').map(s => s.trim());
    if (parts[0].toUpperCase() === targetPlate) {
      return {
        license: parts[0],
        barkUrl: parts[1],
        phone: parts[2] || ''
      };
    }
  }
  return null;
}

// 验证车牌 API
async function handleVerifyLicense(request) {
  try {
    const body = await request.json();
    const license = body.license;
    
    if (!license) throw new Error('请输入车牌号');
    
    const config = getCarConfig(license);
    if (config) {
      return new Response(JSON.stringify({ success: true, license: config.license }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({ success: false, message: '未找到该车辆信息，请检查车牌是否输入正确' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ success: false, message: error.message }), { status: 400 });
  }
}

// 发起通知 API
async function handleNotify(request, url) {
  try {
    const body = await request.json();
    const license = body.license;
    const message = body.message || '车旁有人等待';
    const location = body.location || null;
    const delayed = body.delayed || false;

    const config = getCarConfig(license);
    if (!config) throw new Error('车辆配置不存在');

    // 构造车主确认链接
    const confirmUrl = encodeURIComponent(`${url.origin}/owner-confirm?plate=${encodeURIComponent(license)}`);

    let notifyBody = `🚗 挪车请求: ${license}`;
    if (message) notifyBody += `\n💬 留言: ${message}`;

    // 存储 Requester 位置信息
    if (location && location.lat && location.lng) {
      const urls = generateMapUrls(location.lat, location.lng);
      notifyBody += '\n📍 已附带位置信息，点击查看';

      await MOVE_CAR_STATUS.put(`req_loc:${license}`, JSON.stringify({
        lat: location.lat,
        lng: location.lng,
        ...urls
      }), { expirationTtl: CONFIG.KV_TTL });
    } else {
      notifyBody += '\n⚠️ 未提供位置信息';
    }

    await MOVE_CAR_STATUS.put(`status:${license}`, 'waiting', { expirationTtl: 600 });

    if (delayed) {
      await new Promise(resolve => setTimeout(resolve, 30000));
    }

    let barkBase = config.barkUrl;
    if (barkBase.endsWith('/')) barkBase = barkBase.slice(0, -1);
    
    const barkApiUrl = `${barkBase}/挪车请求/${encodeURIComponent(notifyBody)}?group=MoveCar&level=critical&call=1&sound=minuet&icon=https://cdn-icons-png.flaticon.com/512/741/741407.png&url=${confirmUrl}`;

    const barkResponse = await fetch(barkApiUrl);
    if (!barkResponse.ok) throw new Error('Bark API 请求失败');

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

async function handleGetLocation(url) {
  const license = url.searchParams.get('plate');
  if(!license) return new Response(JSON.stringify({ error: 'No license' }), { status: 400 });

  const data = await MOVE_CAR_STATUS.get(`req_loc:${license}`);
  if (data) {
    return new Response(data, { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'No location' }), { status: 404 });
}

async function handleCheckStatus(url) {
  const license = url.searchParams.get('plate');
  if(!license) return new Response(JSON.stringify({ status: 'unknown' }), { headers: { 'Content-Type': 'application/json' } });

  const status = await MOVE_CAR_STATUS.get(`status:${license}`);
  const ownerLocation = await MOVE_CAR_STATUS.get(`owner_loc:${license}`);
  
  return new Response(JSON.stringify({
    status: status || 'waiting',
    ownerLocation: ownerLocation ? JSON.parse(ownerLocation) : null
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleOwnerConfirmAction(request) {
  try {
    const body = await request.json();
    const license = body.license;
    const ownerLocation = body.location || null;

    if (!license) throw new Error('Missing license');

    if (ownerLocation) {
      const urls = generateMapUrls(ownerLocation.lat, ownerLocation.lng);
      await MOVE_CAR_STATUS.put(`owner_loc:${license}`, JSON.stringify({
        lat: ownerLocation.lat,
        lng: ownerLocation.lng,
        ...urls,
        timestamp: Date.now()
      }), { expirationTtl: CONFIG.KV_TTL });
    }

    await MOVE_CAR_STATUS.put(`status:${license}`, 'confirmed', { expirationTtl: 600 });
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// --- 地图算法工具函数 ---
function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  if (outOfChina(lat, lng)) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}
function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}
function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}
function generateMapUrls(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    amapUrl: `https://uri.amap.com/marker?position=${gcj.lng},${gcj.lat}&name=位置`,
    appleUrl: `https://maps.apple.com/?ll=${gcj.lat},${gcj.lng}&q=位置`
  };
}

// --- 页面渲染函数 ---

// 1. 首页：车牌输入验证
function renderIndexPage() {
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>自助挪车服务</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
      .card { background: white; padding: 30px; border-radius: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 400px; text-align: center; }
      h1 { color: #333; margin-bottom: 20px; font-size: 24px; }
      /* 输入框样式优化 */
      input { width: 100%; padding: 15px; border: 2px solid #ddd; border-radius: 12px; font-size: 18px; margin-bottom: 20px; box-sizing: border-box; text-align: center; text-transform: uppercase; transition: border-color 0.3s; }
      input:focus { border-color: #0093E9; outline: none; }
      input::placeholder { color: #aaa; opacity: 1; }
      button { width: 100%; padding: 15px; background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%); color: white; border: none; border-radius: 12px; font-size: 18px; font-weight: bold; cursor: pointer; transition: transform 0.1s; }
      button:active { transform: scale(0.98); }
      .toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.8); color: white; padding: 10px 20px; border-radius: 20px; font-size: 14px; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
      .toast.show { opacity: 1; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>验证车牌</h1>
      <div style="font-size: 60px; margin-bottom: 10px;">🚗</div>
      <p style="color: #666; margin-bottom: 25px;">请输入车牌联系车主</p>
      <input type="text" id="licenseInput" placeholder="例如:沪A888666" autocomplete="on">
      <button onclick="verifyLicense()" id="btn">下一步</button>
    </div>
    <div id="toast" class="toast"></div>
    <script>
      async function verifyLicense() {
        const input = document.getElementById('licenseInput');
        const btn = document.getElementById('btn');
        const plate = input.value.trim().toUpperCase();
        
        if (!plate) return showToast('请输入车牌');
        
        btn.disabled = true;
        btn.innerText = '查询中...';
        
        try {
          const res = await fetch('/api/verify-license', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ license: plate })
          });
          const data = await res.json();
          
          if (data.success) {
            window.location.href = '/notify?plate=' + encodeURIComponent(data.license);
          } else {
            showToast(data.message);
            btn.disabled = false;
            btn.innerText = '下一步';
          }
        } catch (e) {
          showToast('网络错误，请重试');
          btn.disabled = false;
          btn.innerText = '下一步';
        }
      }
      
      function showToast(msg) {
        const t = document.getElementById('toast');
        t.innerText = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
      }
    </script>
  </body>
  </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// 2. 挪车页面
function renderNotifyPage(origin, license) {
  const config = getCarConfig(license);
  const phone = config ? config.phone : '';

  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <title>通知车主挪车</title>
    <style>
      :root { --sat: env(safe-area-inset-top, 0px); --sar: env(safe-area-inset-right, 0px); --sab: env(safe-area-inset-bottom, 0px); --sal: env(safe-area-inset-left, 0px); }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
      html { font-size: 16px; -webkit-text-size-adjust: 100%; }
      html, body { height: 100%; }
      body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif; background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%); min-height: 100vh; padding: 20px; display: flex; justify-content: center; align-items: flex-start; }
      .container { width: 100%; max-width: 500px; display: flex; flex-direction: column; gap: 20px; }
      .card { background: rgba(255, 255, 255, 0.95); border-radius: 20px; padding: 24px; box-shadow: 0 10px 40px rgba(0, 147, 233, 0.2); }
      .header { text-align: center; } 
      .icon-wrap { width: 80px; height: 80px; background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%); border-radius: 20px; display: flex; align-items: center; justify-content: center; margin: 0 auto 15px; font-size: 40px; }
      .input-card textarea { width: 100%; border: none; padding: 10px; font-size: 16px; resize: none; outline: none; background: #f7fafc; border-radius: 12px; min-height: 100px; }
      .tags { display: flex; gap: 10px; overflow-x: auto; padding-top: 10px; }
      .tag { background: #e0f7fa; color: #00796b; padding: 8px 12px; border-radius: 20px; font-size: 14px; white-space: nowrap; cursor: pointer; }
      .btn-main { width: 100%; background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%); color: white; border: none; padding: 18px; border-radius: 16px; font-size: 18px; font-weight: bold; cursor: pointer; display: flex; justify-content: center; gap: 10px; }
      .btn-main:disabled { background: #cbd5e0; }
      .loc-card { display: flex; align-items: center; gap: 15px; cursor: pointer; }
      .loc-icon { font-size: 24px; }
      #successView { display: none; }
      .hidden { display: none; }
      .map-links a { display: block; padding: 10px; text-align: center; background: #eee; margin-top: 5px; border-radius: 8px; text-decoration: none; color: #333; }
      .btn-retry, .btn-phone { width: 100%; padding: 15px; border-radius: 12px; border: none; font-weight: bold; color: white; margin-top: 10px; cursor: pointer; display: flex; justify-content: center; text-decoration: none; box-sizing: border-box; }
      .btn-retry { background: orange; }
      .btn-phone { background: #ef4444; }
      .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 999; }
      .modal-overlay.show { display: flex; }
      .modal-box { background: white; padding: 20px; border-radius: 15px; width: 80%; text-align: center; }
      .toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: white; padding: 10px 20px; border-radius: 20px; display: none; }
      .toast.show { display: block; }
    </style>
  </head>
  <body>
    <div id="toast" class="toast"></div>

    <div id="locationTipModal" class="modal-overlay">
      <div class="modal-box">
        <h3>📍 位置信息</h3>
        <p>分享位置可让车主确认您在车旁<br>不分享将延迟30秒发送通知</p>
        <button onclick="hideModalAndReq()" style="padding:10px 20px; margin-top:15px; background:#0093E9; color:white; border:none; border-radius:10px;">我知道了</button>
      </div>
    </div>

    <div class="container" id="mainView">
      <div class="card header">
        <h1>通知车主-${license}</h1>
        <div style="font-size: 60px; margin-bottom: 5px;">🚗</div>
      </div>

      <div class="card input-card">
        <textarea id="msgInput" placeholder="输入留言给车主...（可选）"></textarea>
        <div class="tags">
          <div class="tag" onclick="addTag('您的车挡住我了')">🚧挡路</div>
          <div class="tag" onclick="addTag('临时停靠一下')">⏱️临停</div>
          <div class="tag" onclick="addTag('电话打不通')">📞没接</div>
          <div class="tag" onclick="addTag('麻烦请尽快')">🙏加急</div>
        </div>
      </div>

      <div class="card loc-card" onclick="requestLocation()">
        <div id="locIcon" class="loc-icon">📍</div>
        <div>
          <div style="font-weight:bold">我的位置</div>
          <div id="locStatus" style="font-size:12px; color:#666">点击获取位置</div>
        </div>
      </div>

      <button id="notifyBtn" class="btn-main" onclick="sendNotify()">
        <span>🔔</span><span>通知车主</span>
      </button>
    </div>

    <div class="container" id="successView">
      <div class="card" style="text-align:center">
        <div style="font-size:50px">✅</div>
        <h2>通知已发送</h2>
        <p id="waitingText">等待车主回应...</p>
      </div>

      <div id="ownerFeedback" class="card hidden" style="text-align:center; border:2px solid #80D0C7">
        <h3>车主已收到通知</h3>
        <p>正在赶来，点击查看车主位置</p>
        <div id="ownerMapLinks" class="map-links" style="display:none">
          <a id="ownerAmapLink" href="#" target="_blank">🗺️ 高德地图</a>
          <a id="ownerAppleLink" href="#" target="_blank">🍎 Apple地图</a>
        </div>
      </div>

      <div class="card">
        <p style="text-align:center; color:#666; margin-bottom:10px">车主没反应？</p>
        <button id="retryBtn" class="btn-retry" onclick="retryNotify()">🔔 再次通知</button>
        ${phone ? `<a href="tel:${phone}" class="btn-phone">📞 直接打电话</a>` : ''}
      </div>
    </div>

    <script>
      const LICENSE = "${license}";
      let userLocation = null;
      let checkTimer = null;

      window.onload = () => document.getElementById('locationTipModal').classList.add('show');
      function hideModalAndReq() {
        document.getElementById('locationTipModal').classList.remove('show');
        requestLocation();
      }

      function requestLocation() {
        const txt = document.getElementById('locStatus');
        txt.innerText = '获取中...';
        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              txt.innerText = '已获取位置 ✓';
              txt.style.color = 'green';
            },
            () => { txt.innerText = '获取失败'; txt.style.color = 'red'; },
            { enableHighAccuracy: true, timeout: 5000 }
          );
        } else {
          txt.innerText = '不支持定位';
        }
      }

      function addTag(text) { document.getElementById('msgInput').value = text; }
      function showToast(text) { 
        const t = document.getElementById('toast'); 
        t.innerText = text; 
        t.classList.add('show'); 
        setTimeout(() => t.classList.remove('show'), 3000); 
      }

      async function sendNotify() {
        const btn = document.getElementById('notifyBtn');
        const msg = document.getElementById('msgInput').value;
        const delayed = !userLocation;
        
        btn.disabled = true;
        btn.innerText = '发送中...';

        try {
          const res = await fetch('/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ license: LICENSE, message: msg, location: userLocation, delayed: delayed })
          });
          if(res.ok) {
            document.getElementById('mainView').style.display = 'none';
            document.getElementById('successView').style.display = 'flex';
            if(delayed) showToast('未获取位置，通知将延迟30秒');
            startPolling();
          } else { throw new Error('Failed'); }
        } catch(e) {
          showToast('发送失败');
          btn.disabled = false;
          btn.innerHTML = '<span>🔔</span><span>通知车主</span>';
        }
      }

      function startPolling() {
        let count = 0;
        checkTimer = setInterval(async () => {
          count++;
          if (count > 60) clearInterval(checkTimer); // 3分钟后停止
          try {
            const res = await fetch('/api/check-status?plate=' + encodeURIComponent(LICENSE));
            const data = await res.json();
            if (data.status === 'confirmed') {
              document.getElementById('ownerFeedback').classList.remove('hidden');
              if (data.ownerLocation) {
                document.getElementById('ownerMapLinks').style.display = 'block';
                document.getElementById('ownerAmapLink').href = data.ownerLocation.amapUrl;
                document.getElementById('ownerAppleLink').href = data.ownerLocation.appleUrl;
              }
              clearInterval(checkTimer);
              if(navigator.vibrate) navigator.vibrate([200, 100, 200]);
            }
          } catch(e){}
        }, 3000);
      }

      async function retryNotify() {
        sendNotify();
      }
    </script>
  </body>
  </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// 3. 车主页面
function renderOwnerPage(license) {
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>确认挪车 - ${license}</title>
    <style>
      body { font-family: sans-serif; background: #667eea; color: #333; padding: 20px; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; }
      .card { background: white; padding: 30px; border-radius: 20px; text-align: center; width:100%; max-width:400px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
      .btn { background: #10b981; color: white; border: none; padding: 15px; width: 100%; border-radius: 10px; font-size: 18px; font-weight: bold; cursor: pointer; margin-top: 20px; }
      .btn:disabled { background: #ccc; }
      .map-box { background: #f3f4f6; padding: 15px; border-radius: 10px; margin-top: 15px; display: none; }
      .map-box.show { display: block; }
      .map-links { display: flex; gap: 10px; margin-top: 10px; }
      .map-link { flex: 1; padding: 10px; background: white; border-radius: 5px; text-decoration: none; font-size: 14px; border: 1px solid #ddd; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>👋 收到挪车请求</h1>
      <h1>${license}</h1>
      <div id="mapArea" class="map-box">
        <p>📍 对方位置</p>
        <div class="map-links">
          <a id="amap" href="#" class="map-link">高德地图</a>
          <a id="apple" href="#" class="map-link">Apple地图</a>
        </div>
      </div>

      <button id="confirmBtn" class="btn" onclick="confirmMove()">🚀 我已知晓，正在前往</button>
      <div id="doneMsg" style="display:none; margin-top:20px; color:green; font-weight:bold;">✅ 已发送确认！</div>
    </div>

    <script>
      const LICENSE = "${license}";
      let ownerLocation = null;

      window.onload = async () => {
        try {
          const res = await fetch('/api/get-location?plate=' + encodeURIComponent(LICENSE));
          if(res.ok) {
            const data = await res.json();
            if(data.amapUrl) {
              document.getElementById('mapArea').classList.add('show');
              document.getElementById('amap').href = data.amapUrl;
              document.getElementById('apple').href = data.appleUrl;
            }
          }
        } catch(e) {}
      }

      async function confirmMove() {
        const btn = document.getElementById('confirmBtn');
        btn.disabled = true;
        btn.innerText = '获取位置中...';

        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              ownerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              doConfirm();
            },
            () => { ownerLocation = null; doConfirm(); },
            { enableHighAccuracy: true, timeout: 5000 }
          );
        } else {
          doConfirm();
        }
      }

      async function doConfirm() {
        const btn = document.getElementById('confirmBtn');
        btn.innerText = '确认中...';
        try {
          await fetch('/api/owner-confirm', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ license: LICENSE, location: ownerLocation })
          });
          btn.style.display = 'none';
          document.getElementById('doneMsg').style.display = 'block';
        } catch(e) {
          btn.innerText = '重试';
          btn.disabled = false;
        }
      }
    </script>
  </body>
  </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
