/**
 * 聯鑫企業股份有限公司 (LIEN XIN ENTERPRISE CO., LTD.)
 * Cloudflare Worker — 靜態網站託管 + LINE Messaging API 線上詢價推播
 *
 * 必填 Cloudflare 變數與機密 (Variables and Secrets):
 *   - LINE_CHANNEL_ACCESS_TOKEN : LINE Messaging API Channel access token (long-lived)
 *   - LINE_USER_ID              : 接收通知之私人 LINE User ID (U 開頭共 33 碼)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Client-Source',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

function formatTaiwanTime(isoString) {
  try {
    const date = isoString ? new Date(isoString) : new Date();
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return new Date().toISOString();
  }
}

function generateTicketId() {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `LX-${yy}${mm}${dd}-${rand}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. 處理 CORS 預檢請求
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. 健康檢查端點 GET /api/health
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse({
        ok: true,
        service: 'lienxin-website-worker',
        configured: {
          hasLineChannelAccessToken: Boolean(env.LINE_CHANNEL_ACCESS_TOKEN),
          hasLineUserId: Boolean(env.LINE_USER_ID),
        },
      });
    }

    // 3. 處理線上規格諮詢與報價表單 POST /api/quote
    if (
      (url.pathname === '/api/quote' || url.pathname === '/api/v1/quote') &&
      request.method === 'POST'
    ) {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: '無效的 JSON 請求格式 (Invalid JSON payload)' }, 400);
      }

      const company = String(payload.company || '').trim();
      const contact = String(payload.contact || '').trim();
      const phone = String(payload.phone || '').trim();
      const requirement = String(payload.requirement || '').trim();
      const locale = String(payload.locale || 'zh').trim();

      if (!company || !contact || !phone || !requirement) {
        return jsonResponse(
          {
            ok: false,
            error: '請完整填寫所有必填欄位 (company, contact, phone, requirement)',
          },
          400
        );
      }

      const token = (
        env.LINE_CHANNEL_ACCESS_TOKEN ||
        env.CHANNEL_ACCESS_TOKEN ||
        env.LINE_ACCESS_TOKEN ||
        env.LINE_TOKEN ||
        ''
      ).trim();
      const userId = (
        env.LINE_USER_ID ||
        env.USER_ID ||
        env.LINE_TO ||
        ''
      ).trim();

      if (!token || !userId) {
        const missing = [];
        if (!token) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
        if (!userId) missing.push('LINE_USER_ID');
        const envKeys = Object.keys(env || {}).filter((k) => k !== 'ASSETS');
        return jsonResponse(
          {
            ok: false,
            error: `Cloudflare Worker 尚未讀到環境變數：${missing.join('、')}（目前執行時已綁定之變數名稱：${
              envKeys.length ? envKeys.join(', ') : '無 — 請確認是加在「執行時變數與機密」而非「組建變數」'
            }）`,
          },
          500
        );
      }

      const ticketId = generateTicketId();
      const timestamp = formatTaiwanTime(payload.submittedAt);

      // 組合簡潔清晰的純文字 LINE 訊息 (Text Message)
      const messageText = [
        '🟢【聯鑫官網｜新線上詢價單】',
        '━━━━━━━━━━━━━━',
        `📋 單號：${ticketId}`,
        `🏢 公司名稱：${company}`,
        `👤 聯絡人與職稱：${contact}`,
        `📞 聯絡電話：${phone}`,
        `🛠 油品與加工材質需求：\n${requirement}`,
        '━━━━━━━━━━━━━━',
        `🌐 語系：${locale.toUpperCase()} | 🕒 ${timestamp}`,
      ].join('\n');

      try {
        const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            to: userId,
            messages: [
              {
                type: 'text',
                text: messageText,
              },
            ],
          }),
        });

        if (!lineRes.ok) {
          const errDetail = await lineRes.text();
          console.error('[LINE Messaging API Error]', lineRes.status, errDetail);
          return jsonResponse(
            {
              ok: false,
              error: `LINE Messaging API 回傳錯誤 (HTTP ${lineRes.status})`,
              detail: errDetail,
            },
            502
          );
        }

        return jsonResponse({
          ok: true,
          ticketId,
          submittedAt: timestamp,
        });
      } catch (err) {
        console.error('[Worker LINE Push Exception]', err);
        return jsonResponse(
          {
            ok: false,
            error: '連線至 LINE Messaging API 失敗，請稍後再試',
          },
          502
        );
      }
    }

    // 4. 其他路由交由靜態資源 (index.html) 處理
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
