/* 웹푸시 서비스 워커 — 브라우저가 닫혀 있거나 사이트가 백그라운드일 때 알림을 받는다.
 *
 * ⚠️ 이 파일은 **사이트 루트(docs/)에 그대로 배포돼야** 한다. 서비스 워커는 자기 파일이
 *    놓인 경로 이하만 제어할 수 있어서, 하위 폴더에 두면 브리핑 페이지를 못 잡는다.
 *    GitHub Pages 프로젝트 사이트라 실제 스코프는 /daily_investment_briefing/ 이며,
 *    사이트 전체가 그 아래 있으므로 문제없다.
 *
 * ⚠️ **배포 게이트 주의** — SKILL.md 5-2단계의 게이트는 docs/에 .html·feed.xml 외
 *    파일이 있으면 배포를 중단시킨다. 이 파일(.js)이 예외로 등록돼 있어야 한다.
 *    게이트를 손볼 때 이 파일을 빠뜨리면 웹푸시가 조용히 죽는다.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⛔ 이 워커에 Firebase SDK를 넣지 마라 (2026-08-16 실증, 등록 자체가 실패했다)
 * ══════════════════════════════════════════════════════════════════════════
 * Firebase 공식 문서는 서비스 워커에서
 *   importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js')
 * 를 부르고 `firebase.messaging().onBackgroundMessage(...)`를 쓰라고 안내한다.
 * 이 사이트(Chrome 151)에서는 그 방식이 두 단계 모두에서 깨졌다:
 *
 *   1) CDN에서 부르면      → importScripts(gstatic)  "failed to load"
 *                            importScripts(jsdelivr) "failed to load"  ← CDN을 바꿔도 같다
 *      (같은 URL을 fetch 하면 200이므로 네트워크·배포 문제가 아니다)
 *   2) SDK를 동일 출처로 자체 호스팅해도
 *                          → importScripts('./firebase-app-compat.js')
 *                            "ReferenceError: window is not defined"
 *      즉 compat 번들이 워커 스코프에서 평가되다 죽는다. 그 결과 워커 전체가
 *      평가 실패하고, 브라우저는 구독 시점에
 *      "ServiceWorker script evaluation failed" 만 뱉는다(원인 줄은 안 알려준다).
 *
 * → 그래서 **SDK를 아예 쓰지 않고 표준 Push API로 직접 처리한다.**
 *   FCM은 결국 표준 Web Push로 전달되므로, push 이벤트에서 페이로드를 직접 읽으면 된다.
 *   토큰 발급(getToken)은 SDK가 잘 도는 **페이지 쪽(notify.html)** 에서 하고,
 *   이 워커의 등록 객체만 넘겨준다. 워커는 알림을 띄우는 일만 한다.
 *   부수 효과로 워커가 70KB SDK를 안 받으므로 더 가볍고, SDK 버전 관리도 사라진다.
 *
 * 원인 규명 기록: docs/sw-diag.js(임시 진단 워커)로 단계별 try/catch를 돌려
 * importApp 단계에서 터진다는 것을 확인했다. 규명 후 그 파일은 삭제했다.
 */

const SITE = '/daily_investment_briefing/';

// 발송 스크립트(send_push.py)는 data-only 메시지를 보낸다.
// FCM이 표준 Web Push로 전달할 때의 페이로드는 { data: {...}, from, fcmMessageId, ... } 형태다.
// 혹시 notification 페이로드로 오는 경우까지 함께 받아낸다.
function readPayload(event) {
  if (!event.data) return {};
  let raw;
  try { raw = event.data.json(); }
  catch (e) { return { body: event.data.text() }; }
  return Object.assign({}, raw.notification || {}, raw.data || {}, raw.data ? {} : raw);
}

self.addEventListener('push', (event) => {
  const d = readPayload(event);
  event.waitUntil(
    self.registration.showNotification(d.title || '한국경제 시황 브리핑', {
      body: d.body || '새 브리핑이 올라왔습니다.',
      icon: d.icon || undefined,
      tag: d.tag || 'briefing',      // 같은 tag는 덮어써서 알림이 쌓이지 않는다
      data: { url: d.url || SITE },
    })
  );
});

// 알림 클릭 → 이미 열려 있는 탭이 있으면 그 탭을 target으로 이동시킨 뒤 살리고, 없으면 새로 연다.
//
// ⛔ 2026-09-13 실증 버그: 기존엔 c.url.includes(SITE) && focus()만 했다. SITE는 사이트
//    루트 경로라 사실상 그 사이트의 어떤 탭이든 걸리는데, navigate 없이 focus만 하면
//    그 탭이 이미 보고 있던(예: notify.html) 화면 그대로 포커스만 돼서 "알림을 눌러도
//    브리핑이 안 열리는 것처럼" 보인다(포트폴리오 브리핑 웹푸시에서 실측·수정 후 이식).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || SITE;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      for (const c of list) {
        if ('focus' in c) {
          if ('navigate' in c) { try { await c.navigate(target); } catch (e) {} }
          return c.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});

// 새 버전을 배포했을 때 곧바로 넘겨받게 한다(구버전 워커가 남아 옛 동작을 하지 않도록).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
