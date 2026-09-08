/**
 * 本地桥接：绕开 VPN 的 Fake-IP DNS。
 *
 * 原理：浏览器访问 127.0.0.1:1xxxx，本进程直连真实公网 IP，
 * 并用正确的 SNI/Host 去和 Caddy 握手 —— DNS 完全不参与。
 *
 * 用法：node pool-bridge.mjs
 *   Console → http://127.0.0.1:18090
 *   API     → http://127.0.0.1:18091
 */
import http from 'node:http';
import https from 'node:https';

const REAL_IP = '20.78.139.35';

const ROUTES = [
  { port: 18090, host: `console.${REAL_IP}.nip.io`, label: 'Console 管理界面' },
  { port: 18091, host: `api.${REAL_IP}.nip.io`, label: 'API 端点' },
];

for (const route of ROUTES) {
  http
    .createServer((req, res) => {
      const upstream = https.request(
        {
          host: REAL_IP,          // 直连真实 IP，不查 DNS
          servername: route.host, // SNI 用真实域名，Caddy 才会给对的证书
          port: 443,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: route.host },
          rejectUnauthorized: false,
        },
        (up) => {
          const headers = { ...up.headers };
          // 去掉会让浏览器强制升级 HTTPS / 换协议的头
          delete headers['strict-transport-security'];
          delete headers['alt-svc'];
          // Cookie 的 Domain/Secure 在 http://127.0.0.1 上会失效，剥掉
          if (headers['set-cookie']) {
            headers['set-cookie'] = [].concat(headers['set-cookie']).map((c) =>
              c
                .replace(/;\s*Domain=[^;]*/gi, '')
                .replace(/;\s*Secure/gi, '')
                .replace(/;\s*SameSite=None/gi, '; SameSite=Lax'),
            );
          }
          // 重定向里的绝对地址改回本地
          if (headers.location) {
            headers.location = String(headers.location)
              .replace(`https://${route.host}`, `http://127.0.0.1:${route.port}`)
              .replace(`http://${route.host}`, `http://127.0.0.1:${route.port}`);
          }
          res.writeHead(up.statusCode || 502, headers);
          up.pipe(res);
        },
      );
      upstream.on('error', (err) => {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`桥接上游错误: ${err.message}`);
      });
      req.pipe(upstream);
    })
    .listen(route.port, '127.0.0.1', () => {
      console.log(`  ${route.label.padEnd(16)} http://127.0.0.1:${route.port}   →  ${route.host}`);
    });
}

console.log('本地桥接已启动（绕过 VPN Fake-IP DNS）。按 Ctrl+C 停止。\n');
