# API Mock v2 — Thiết kế

- **Ngày:** 2026-09-21
- **Trạng thái:** chờ duyệt
- **Tên tạm:** API Mock v2 (thư mục `api-mock-v2`, đổi tên được)
- **UI:** xem [`2026-09-21-api-mock-v2-ui-design.md`](2026-09-21-api-mock-v2-ui-design.md)
- **Tham khảo:** `~/Study/MAPI/mock-extension` ("API Mock Master" v1.1.0, đã trim về core-only ở commit `d3d0de5`). README và CLAUDE.md của bản đó còn mô tả groups, drag-drop, import/export đã bị bỏ khỏi code, nên chỉ dùng **code** làm nguồn tham chiếu.

## 1. Mục tiêu và phạm vi

Extension Chrome (Manifest V3) chặn `fetch` và `XMLHttpRequest` tới URL bất kỳ và trả về response do người dùng cung cấp (status, header, body, delay). Đây là bản làm lại "API Mock Master" trên nền tảng vững hơn.

**Tiêu chí thành công**

1. **Không race:** khớp rule đồng bộ ngay trong trang. Không còn vòng 3 hop cho mỗi request, không còn timeout 1.5s âm thầm cho request đi ra network thật.
2. **Trung thực:** URL tương đối khớp đúng. `Response` và `XMLHttpRequest` bị mock hoạt động như thật (`url`, `Content-Type`, `readyState`, `responseType`, header, `abort`).
3. **Im lặng:** không log ra console của trang, không chèn DOM vào trang.
4. **Quan sát được qua UI của extension:** log theo tab (DevTools panel), popup, badge.
5. **Riêng tư:** trang web không đọc được rule (URL, body) của người dùng.

**Ngoài phạm vi (đã chấp nhận)**

- Không dùng `chrome.debugger` (thanh cảnh báo "started debugging this browser") và không dùng `declarativeNetRequest`.
- Chỉ bắt `fetch`/`XHR` trên luồng chính của trang. Không bắt `<img>`, `<script>`, `<link>`, điều hướng iframe, `sendBeacon`, WebSocket, EventSource, và request phát ra từ Worker/Service Worker.
- Request bị mock không hiện trong tab Network của DevTools vì không có request thật. Extension thay bằng log trong panel của nó.
- v1 chưa có: khớp theo body/header (ví dụ GraphQL `operationName`), regex tự do, nhóm rule, kéo-thả sắp xếp, "Mock request này" từ danh sách request thật của DevTools.

## 2. Nhật ký quyết định

| # | Quyết định | Lý do |
|---|---|---|
| 1 | Hướng A: nền tảng chặn vững hơn (không phải B: mock thông minh, C: trải nghiệm và chia sẻ) | Bạn chọn A. Các giới hạn của bản cũ nằm ở lớp chặn |
| 2 | Không dùng `chrome.debugger` | Bạn chọn hướng A2, không có thanh cảnh báo debugger |
| 3 | Patch trong trang, chạy im lặng | Yêu cầu của bạn: patch trong page không hiện debug. Vì vậy panel log của extension là bắt buộc |
| 4 | Chỉ page engine, không làm DNR | Bạn chọn phương án đơn giản nhất, chấp nhận không bắt request không phải fetch/XHR |
| 5 | Không build step (T1), test e2e bằng Playwright + Chromium | Engine chỉ vài trăm dòng. Bản cũ từng phải lùi về cấu trúc phẳng vì nhảy file quá nhiều (MEMORY.md, 2026-08-23). Nâng lên esbuild + `node:test` nếu engine vượt khoảng 500 dòng |
| 6 | Editor ở DevTools panel, popup chỉ điều khiển nhanh | Popup tối đa 800×600 và đóng khi mất focus, dở cho việc gõ JSON body |
| 7 | Phong cách thị giác B: navy + cam, luôn tối (không phải A: hòa vào DevTools) | Bạn chọn B. Hệ quả chấp nhận: trên DevTools theme sáng, panel là một khối tối nổi bật |
| 8 | Popup có dải trạng thái cho tab hiện tại, kiểm tra tab bằng `PING` | Engine im lặng nên popup và badge là nơi duy nhất cho biết mock có chạy không. `PING` phản ánh đúng thực tế, còn suy luận từ `PAGE_START` sẽ sai khi tab điều hướng sang trang không hỗ trợ (`chrome://`) |
| 9 | Badge theo thứ tự ưu tiên `OFF` > `!` > số request đã mock | Sự cố không bị bỏ sót khi không mở DevTools |

## 3. Kiến trúc và luồng dữ liệu

Ba ngữ cảnh chạy như bản cũ, nhưng **service worker không nằm trên đường đi của request**.

```
 Sửa rule (popup / panel)
        │  runtime.sendMessage
        ▼
 Service worker ──ghi──▶ chrome.storage.local
                               │ storage.onChanged (key "state")
                               ▼
 Bridge (ISOLATED) ──postMessage: RULES──▶ Engine (MAIN)
        ▲                                     │ khớp rule tại chỗ, đồng bộ
        └──────postMessage: sự kiện───────────┘
        │  runtime.sendMessage
        ▼
 Service worker ──▶ log theo tab + hit count + badge ──▶ panel / popup
```

| Thành phần | Vai trò |
|---|---|
| **Engine** (`engine.js`, MAIN world, `document_start`, `all_frames`) | Patch `fetch` và `XMLHttpRequest`. Giữ rule đã biên dịch, khớp đồng bộ. Không console, không DOM |
| **Bridge** (`bridge.js`, ISOLATED, `document_start`, `all_frames`) | Nạp rule từ storage, đẩy vào engine mỗi khi `state` đổi, chuyển sự kiện của engine về service worker. Frame cấp cao nhất còn gửi `PAGE_START` |
| **Service worker** (`background.js`) | Chủ sở hữu state (rule, công tắc tổng), hit count, log theo tab, icon và badge. Không tham gia khớp request |
| **Popup** và **DevTools panel** | Sửa rule, xem log (xem mục 6) |

**Thông điệp**

- Engine ↔ bridge qua `window.postMessage`, tiền tố kiểu `__API_MOCK__`:
  - bridge → engine: `RULES { rules }`
  - engine → bridge: `MOCK_EVENT { ruleId, url, method, status, ts }`, `RULES_UNAVAILABLE`, `ENGINE_ERROR { message, ruleId? }`
- Bridge → service worker (`runtime.sendMessage`): các sự kiện trên và `PAGE_START`. Service worker lấy `tabId` từ `sender.tab.id`.
- UI → service worker: `SAVE_RULE`, `DELETE_RULE`, `REORDER { id, dir }`, `SET_GLOBAL`, `CLEAR_LOG { tabId }`. UI **đọc** state, hits và log trực tiếp từ storage và render lại khi `storage.onChanged`.
- Popup → bridge của tab đang hoạt động (`chrome.tabs.sendMessage`): `PING`. Bridge trả `{ ok: true }`, không kèm dữ liệu. Không có phản hồi nghĩa là tab chưa có engine (tab mở trước khi cài hoặc cập nhật extension, hoặc trang không hỗ trợ như `chrome://`).
- Mọi handler `onMessage` trả `true` để giữ kênh `sendResponse` mở.

**Khác bản cũ**

- Hết vòng 3 hop cho mỗi request, nên hết timeout 1.5s và hết mock biến mất im lặng.
- Lúc trang vừa mở, engine giữ request lại tối đa 1 giây cho tới khi nhận bản rule đầu tiên. Quá hạn thì cho request đi qua và báo `RULES_UNAVAILABLE` lên panel/popup. Vẫn fail-open nhưng không còn im lặng.
- Hit count được gom ở service worker và ghi có debounce, thay vì đọc-sửa-ghi cả state ở mỗi request.

## 4. Mô hình dữ liệu và khớp URL

### 4.1 Storage

| Nơi | Key | Nội dung | Ai ghi |
|---|---|---|---|
| `storage.local` | `state` | `State` (bên dưới) | Service worker (theo yêu cầu từ UI) |
| `storage.local` | `hits` | `Record<ruleId, number>` | Service worker, debounce khoảng 1 giây |
| `storage.session` | `log:<tabId>` | Tối đa 200 `LogEntry`, cũ nhất bị bỏ trước | Service worker, debounce khoảng 200ms |
| `storage.session` | `tab:<tabId>` | `{ mocked: number, issues: number }` (xem mục 6.3) | Service worker |

`hits` tách khỏi `state` vì bridge lắng nghe `storage.onChanged` trên `state` để đẩy lại rule vào mọi frame. Nếu hit count nằm chung, mỗi request bị mock sẽ kích hoạt một lần đẩy lại toàn bộ rule, và ghi hit có thể đè lên thay đổi vừa sửa từ UI.

```ts
interface State {
  version: 1;                 // để migrate về sau
  globalEnabled: boolean;
  rules: Rule[];              // thứ tự trong mảng = độ ưu tiên
}

interface Rule {
  id: string;
  enabled: boolean;
  name: string;               // mặc định lấy từ path của URL lúc tạo
  method: 'ANY' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  url: string;                // pattern, xem 4.2
  response: {
    status: number;           // 200–599
    headers: { name: string; value: string }[];
    body: string;
    delay: number;            // ms
  };
}

interface LogEntry {
  ts: number;
  kind: 'mock' | 'unavailable' | 'error';
  method?: string;
  url?: string;
  ruleId?: string;
  ruleName?: string;          // service worker tra từ state lúc ghi log
  status?: number;
  delay?: number;
  message?: string;           // cho 'error'
}
```

**Validate** (`shared/rule.js`, dùng ở service worker, popup và panel): `method` thuộc enum; `url` là chuỗi không rỗng, tối đa 2048 ký tự; `status` là số nguyên 200–599; `delay` là số nguyên 0–60000 (mặc định đề xuất, plan có thể chỉnh); tên header khớp token HTTP (`^[!#$%&'*+.^_`|~0-9A-Za-z-]+$`); `body` là chuỗi. Giá trị sai thì service worker trả `{ ok: false, error }` và không lưu.

### 4.2 Chuẩn hoá và khớp

**Chuẩn hoá request trước khi khớp**

- URL luôn được đổi thành tuyệt đối bằng `new URL(input, document.baseURI)`, bỏ `#fragment`. Việc này sửa lỗi `fetch('/api/users')` không khớp pattern đầy đủ ở bản cũ.
- Method được viết hoa.

**Cách khớp**

- `*` khớp mọi ký tự (kể cả `/` và `?`). Các ký tự regex khác được escape.
- Pattern **không có `?`** so với URL đã bỏ query. Pattern **có `?`** so cả query.
- Pattern **bắt đầu bằng `/`** chỉ so phần path, **trên mọi origin**. Ví dụ `/api/users` khớp cả `fetch('/api/users')` lẫn `https://staging.foo.com/api/users`.
- Rule khớp **đầu tiên** trong danh sách thắng. Rule mới thêm nằm ở đầu danh sách.
- Rule tắt hoặc `globalEnabled = false` thì bỏ qua.

**Biên dịch:** khi nhận snapshot, engine biên dịch mỗi rule thành `{ id, method, test(url), response }` một lần. Hàm khớp nhận object `{ url, method }` để thêm body/header về sau không đổi giao diện.

## 5. Engine: trung thực với fetch/XHR thật

Nguyên tắc: request **không khớp** chạy y hệt bản gốc. Request **khớp** trông giống response thật nhất có thể.

**Khởi tạo:** chặn cài hai lần bằng một cờ. Lưu bản gốc của `fetch`, các phương thức và getter của `XMLHttpRequest.prototype` sẽ bị patch.

**fetch**

- Xác định `url`, `method` và `signal` từ tham số. Không dựng lại `Request` từ input để khỏi tiêu thụ body của request gốc.
- Nếu chưa nhận bản rule đầu tiên thì chờ (tối đa 1 giây tính từ lúc cài, sau đó không bao giờ chờ nữa).
- Không khớp: gọi `fetch` gốc với nguyên tham số.
- Khớp: phát `MOCK_EVENT`, chờ `delay` (huỷ được bằng `AbortSignal`, ném `AbortError` như thật), rồi trả `Response`.
- `Response`: status 200–599. Status 204, 205, 304 thì body là `null`. `url` được đặt thành URL đã chuẩn hoá của request (bản cũ để `''`).
- `Content-Type`: header do người dùng nhập thắng. Nếu không có mà body là JSON hợp lệ thì `application/json`, còn lại giữ mặc định `text/plain`. Bản cũ luôn ép `application/json`. Giá trị này tính một lần lúc biên dịch.
- `statusText`: bảng mã phổ biến, mã khác để `''`.

**XMLHttpRequest: patch prototype, không thay class**

- Bản cũ thay `window.XMLHttpRequest` bằng class bọc mọi XHR, làm mất danh tính native (hằng số, prototype chain). Bản mới patch trên prototype `open`, `send`, `abort`, `getResponseHeader`, `getAllResponseHeaders` và 6 getter (`readyState`, `status`, `statusText`, `response`, `responseText`, `responseURL`). Trạng thái từng instance nằm trong một `WeakMap`. XHR không khớp đi thẳng xuống native.
- XHR khớp vẫn gọi native `open()` nhưng **không bao giờ** gọi native `send()`. Sự kiện được mô phỏng bất đồng bộ (tối thiểu một macrotask): `loadstart` → (delay) → `readyState` 2 → 3 → `progress` → 4 → `load` → `loadend`.
- Tôn trọng `responseType` (text, json, arraybuffer, blob). `getResponseHeader` và `getAllResponseHeaders` trả header của rule. `abort()` trong lúc chờ delay sẽ huỷ mock và bắn `abort`.
- XHR đồng bộ (`open(..., false)`) trả ngay và bỏ qua delay. Nếu lúc đó chưa có rule thì đi thẳng qua và báo `RULES_UNAVAILABLE`.

**An toàn và im lặng**

- Mọi lỗi trong engine đều bị bắt: request chạy tiếp bằng bản gốc và engine phát `ENGINE_ERROR`. Rule biên dịch lỗi bị bỏ qua và báo `ENGINE_ERROR` kèm `ruleId`. Engine không được phép làm hỏng request của trang.
- Không console, không chèn DOM. Chỉ gửi các sự kiện ở mục 3.

## 6. UI

Thiết kế UI chi tiết (phong cách thị giác, các trạng thái, chuỗi chữ, mockup) nằm ở [`2026-09-21-api-mock-v2-ui-design.md`](2026-09-21-api-mock-v2-ui-design.md). Mục này chỉ giữ các hợp đồng ảnh hưởng tới kiến trúc.

**Chia vai:** DevTools panel "API Mock" là nơi làm việc chính (danh sách rule, editor, log). Popup chỉ là điều khiển nhanh, không có editor. Phong cách thị giác: navy + cam, luôn tối (quyết định #7).

### 6.1 Panel (`panel/`)

- Rule tự lưu (debounce 700ms, không có nút Save). Giá trị sai (mục 4.1) thì báo lỗi tại chỗ, không lưu và không đẩy vào engine. Rule đang sửa hiện là bản nháp. Bản nháp chỉ tồn tại trong panel, đóng DevTools thì mất.
- Header hiển thị và sửa dưới dạng các dòng `Key: Value`, lưu dưới dạng mảng `{ name, value }`. Đổi tên inline, sắp xếp bằng menu ⋮ (lên/xuống).
- Log của tab đang inspect (`chrome.devtools.inspectedWindow.tabId`), đọc từ `storage.session`. Log giữ qua các lần điều hướng, xoá bằng nút Clear hoặc khi tab đóng. Có bộ lọc All / Mocked / Issues.
- Trạng thái rỗng phải nói rõ request bị mock không hiện trong tab Network.

### 6.2 Popup (`popup/`)

- Công tắc tổng, dải trạng thái cho tab hiện tại, danh sách rule với công tắc từng rule và hit count. Không có editor.
- Popup hỏi tab đang hoạt động có engine không bằng `PING` (mục 3). Cùng với công tắc tổng và bộ đếm `tab:<tabId>`, kết quả quyết định dải trạng thái theo thứ tự ưu tiên ở UI doc mục 4.

### 6.3 Icon và badge

- Icon vẽ lúc chạy bằng `OffscreenCanvas` như bản cũ (cam = bật, xám = tắt). Không có file PNG.
- Badge theo tab, thứ tự ưu tiên: `OFF` (tắt toàn cục) > `!` (tab có sự cố) > số request đã bị mock kể từ lần tải trang cấp cao nhất gần nhất (để trống nếu bằng 0).
- Bộ đếm nằm ở `storage.session`, key `tab:<tabId>` = `{ mocked, issues }`. `MOCK_EVENT` tăng `mocked`. `RULES_UNAVAILABLE` và `ENGINE_ERROR` tăng `issues`. Cả hai reset khi service worker nhận `PAGE_START` của tab đó. Nút Clear của log đặt lại `issues` về 0. Service worker dọn khi `chrome.tabs.onRemoved`.

### 6.4 Đồng bộ

Popup và panel đọc `state`, `hits`, `log:<tabId>`, `tab:<tabId>` từ storage và render lại khi `storage.onChanged`. Mọi thao tác ghi đi qua service worker, tức chỉ có một writer, nên popup và panel sửa cùng lúc không đè nhau.

## 7. Bảo mật và riêng tư

Thiết kế đẩy rule vào trang để khớp đồng bộ, nên rule (URL, body) có thể lộ cho script của trang nếu không chặn. Bản cũ chỉ trả về mock đã khớp cho từng URL cụ thể.

1. Bridge chỉ đẩy các rule **đang bật** và **không kèm `name`**. Khi `globalEnabled = false`, bridge đẩy danh sách rỗng.
2. Listener nhận `message` của engine được đăng ký **đầu tiên** trên `window` (capture) và gọi `stopImmediatePropagation()` cho các loại thông điệp của engine, để script của trang đăng ký sau không nhận được `RULES`. Đây là biện pháp best-effort và phải có test (mục 10).
3. Rule chỉ nằm trong closure của engine, không gắn lên `window`.
4. Mọi dữ liệu từ trang gửi tới bridge đều coi là **không tin cậy**: bridge kiểm tra hình dạng và kích thước, giới hạn tần suất, rồi service worker kiểm tra lại. Trang giả mạo `MOCK_EVENT` không được làm hỏng log hay hit count.
5. `MOCK_EVENT` chỉ mang `ruleId` và metadata của chính request mà trang đã phát, không mang nội dung rule.

## 8. Cấu trúc project và manifest

```
api-mock-v2/
├── manifest.json
├── engine.js            # MAIN world: patch fetch/XHR (một file, chia bằng banner)
├── bridge.js            # ISOLATED: storage ⇄ postMessage ⇄ runtime
├── background.js        # service worker (ES module): state, hits, log, icon/badge
├── devtools.html + .js  # đăng ký panel
├── panel/               # panel.html/.js/.css — editor + log
├── popup/               # popup.html/.js/.css — điều khiển nhanh
├── shared/rule.js       # schema, mặc định, validate (SW/popup/panel dùng)
├── test/                # e2e + trang test + server cục bộ
└── docs/superpowers/    # specs/ (thiết kế) và ui/ (mockup HTML)
```

- `engine.js` và `bridge.js` là content script khai báo trong manifest nên phải là classic script (không `import`). Service worker, popup và panel dùng được ES module. Vì vậy engine tự chứa, `shared/` chỉ phục vụ ba nơi còn lại.
- Cấu trúc phẳng, không thư mục riêng cho từng component. Trong file dùng banner `// ── Section ──` như bản cũ.
- Manifest phác thảo (quyền cần xác nhận, xem mục 11):

```json
{
  "manifest_version": 3,
  "minimum_chrome_version": "111",
  "permissions": ["storage"],
  "action": { "default_popup": "popup/popup.html" },
  "background": { "service_worker": "background.js", "type": "module" },
  "devtools_page": "devtools.html",
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["engine.js"], "run_at": "document_start", "world": "MAIN", "all_frames": true },
    { "matches": ["<all_urls>"], "js": ["bridge.js"], "run_at": "document_start", "all_frames": true }
  ]
}
```

## 9. Xử lý lỗi

Nguyên tắc chung: engine luôn fail-open. Lỗi hiện ở UI của extension, không bao giờ ở console của trang.

- **Engine:** như mục 5. Thêm: chờ bản rule đầu tiên tối đa 1 giây, XHR đồng bộ không chờ được nên đi thẳng qua và báo `RULES_UNAVAILABLE`.
- **Bridge:** nếu `chrome.runtime` ném lỗi (extension vừa reload hoặc update), bridge ngừng gửi sự kiện. Engine giữ bản rule cuối cùng tới khi trang được tải lại.
- **Service worker:** mọi thao tác ghi đều validate bằng `shared/rule.js`. Nếu sai hoặc ghi storage thất bại thì trả `{ ok: false, error }` để UI báo tại chỗ. Hit count và log gom trong bộ nhớ rồi ghi có debounce. Worker bị tắt đột ngột có thể mất tối đa khoảng 1 giây hit count hoặc vài dòng log gần nhất, chấp nhận được vì đây là số liệu tham khảo.
- **Schema:** trường `version` để migrate về sau. Gặp `version` lớn hơn bản hiểu được thì không ghi đè và báo lỗi cho UI.

## 10. Kiểm thử

Playwright + **Chromium** chạy extension thật. Dùng Chromium chứ không phải Google Chrome vì Chrome bản chính thức bỏ qua cờ `--load-extension` (phát hiện ghi ở MEMORY.md của bản cũ, 2026-08-23). `test/` gồm server HTTP cục bộ (trả response đã biết, phục vụ trang test) và bộ khởi chạy nạp extension, gieo rule bằng cách ghi thẳng vào `chrome.storage.local` qua service worker.

1. **Conformance (đối chứng):** cùng một lời gọi chạy với server thật và với rule mock có status/header/body y hệt, rồi so mọi thứ trang quan sát được. Fetch: `status`, header, `.json()/.text()/.blob()`, `response.url`. XHR: thứ tự `readyState` và sự kiện, `responseType`, `getResponseHeader`, `abort()`.
2. **Khớp URL:** tương đối và tuyệt đối, `/path` mọi origin, query, wildcard, `ANY`, first-match-wins, rule tắt, công tắc tổng tắt.
3. **Race lúc khởi động:** `fetch` gọi từ `<script>` inline đầu `<head>` vẫn bị mock.
4. **Fail-open và im lặng:** giả lập lỗi engine thì request vẫn tới server thật. Console của trang không có dòng nào từ extension.
5. **Cập nhật nóng:** sửa rule thì request kế tiếp dùng bản mới mà không cần reload. Hit count tăng mà không kích hoạt đẩy lại rule.
6. **Riêng tư:** listener `message` do trang đăng ký sau không nhận được `RULES`. `MOCK_EVENT` giả mạo từ trang bị bridge loại bỏ hoặc giới hạn, không làm hỏng log và hit count.
7. **Smoke UI:** mở `panel.html` và `popup.html` ở `chrome-extension://<id>/…` (Playwright không điều khiển được khung DevTools thật nhưng điều khiển được chính trang đó). Thêm rule qua UI, request bị mock, log có dòng tương ứng.
8. **Popup và badge:** thứ tự ưu tiên của badge (`OFF` > `!` > số đếm), bộ đếm reset khi tải lại trang, `PING` có phản hồi ở tab có engine và không có phản hồi ở tab chưa có engine, dải trạng thái đúng cho cả 5 trạng thái.

Không tự động hoá: việc nhúng panel vào DevTools thật, kiểm tay một lần.

## 11. Giả định cần xác nhận khi triển khai

Các điểm dưới đây chưa được kiểm chứng. Plan phải có bước xác nhận sớm cho từng điểm, và nếu sai thì quay lại chỉnh spec.

1. Quyền tối thiểu chỉ cần `storage`, không cần `tabs` hay `host_permissions` (bản cũ khai cả hai). `sender.tab.id` có sẵn cho message từ content script. `chrome.tabs.onRemoved` và `chrome.tabs.query` (lấy `id` tab đang hoạt động cho popup) dùng được mà không cần quyền `tabs`.
2. Listener đăng ký đầu tiên trên `window` kèm `stopImmediatePropagation()` ngăn được script trang đăng ký sau nhận thông điệp của engine.
3. Ở `document_start`, engine sẵn sàng nhận `RULES` trước script đầu tiên của trang, và kênh bridge → engine hoạt động (thứ tự content script, kiểu dữ liệu truyền qua `postMessage` giữa hai world).
4. Panel và popup đọc được `storage.session` và nhận `storage.onChanged` từ vùng này.
5. `Object.defineProperty(response, 'url', …)` hoạt động trên `Response` dựng tay.
6. Sự kiện XHR mô phỏng bằng `dispatchEvent` kích hoạt được các thuộc tính `on*`.
7. Chrome 111+ hỗ trợ `world: "MAIN"` (theo README bản cũ).
8. `chrome.tabs.sendMessage` tới tab đang hoạt động dùng được mà không cần quyền `tabs` và bridge nhận được `PING` từ popup. `chrome.action.setBadgeTextColor` (Chrome 110+) đặt được màu chữ badge.

## 12. Câu hỏi mở (chưa bàn)

1. **Phạm vi theo trang:** rule hiện là toàn cục như bản cũ. Rule dạng `/path` sẽ mock cả trên những site không liên quan (ví dụ `/api/users` trên một site bất kỳ). Có muốn thêm danh sách trang được áp dụng cho rule (hoặc cho công tắc tổng) không?
2. **Import/export rule** và nhập dữ liệu từ API Mock Master (v1.1.0 từng có import/export rồi bị trim).
3. **Tên chính thức và icon** (dự kiến dùng lại kiểu icon vẽ lúc chạy).
4. **Mặc định UI cần xác nhận** (ngôn ngữ giao diện, tên hiển thị, bản nháp mất khi đóng DevTools, nút Clear đặt lại bộ đếm sự cố): xem UI doc mục 10.
