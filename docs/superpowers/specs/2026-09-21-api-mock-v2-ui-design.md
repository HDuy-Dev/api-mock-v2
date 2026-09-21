# API Mock v2 — Thiết kế UI

- **Ngày:** 2026-09-21
- **Trạng thái:** chờ duyệt
- **Thuộc về:** [`2026-09-21-api-mock-v2-design.md`](2026-09-21-api-mock-v2-design.md), mục 6. Tài liệu này chứa phần thị giác và trạng thái. Hợp đồng ảnh hưởng tới kiến trúc (thông điệp, storage, badge) nằm ở spec chính.
- **Mockup** (mở bằng trình duyệt, các trang này chỉ là tài liệu tham chiếu, không phải code của extension):
  - [`../ui/panel-style.html`](../ui/panel-style.html): hai hướng thị giác đã so sánh (A và B). Đã chọn B.
  - [`../ui/panel-states.html`](../ui/panel-states.html): panel ở trạng thái rỗng, lỗi validate và log có cảnh báo.
  - [`../ui/popup-and-icon.html`](../ui/popup-and-icon.html): 5 trạng thái của popup, icon và badge.

## 1. Nguyên tắc

1. **Panel là nơi làm việc, popup là điều khiển nhanh.** Popup không có editor.
2. **Engine im lặng, nên UI của extension là nơi duy nhất cho biết mock có chạy:** dải trạng thái của popup, badge và log.
3. **Request bị mock không hiện trong tab Network.** UI phải nói điều này ngay từ trạng thái rỗng.
4. **Sai thì báo tại chỗ, không bao giờ lưu giá trị sai.**
5. **Chữ giao diện là tiếng Anh** như bản cũ, viết cứng trong code. Chưa làm i18n.

## 2. Phong cách thị giác: B (navy + cam, luôn tối)

Đã so sánh hai hướng và chọn **B**. A (hòa vào DevTools, tự chuyển sáng/tối theo theme) bị loại. Hệ quả chấp nhận: khi DevTools dùng theme sáng, panel là một khối tối nổi bật.

| Token | Giá trị | Dùng cho |
|---|---|---|
| `--bg` | `#1a1d27` | Nền panel/popup |
| `--surface` | `#21253a` | Thanh công cụ, header log, hàng đang chọn |
| `--input` | `#181b28` | Nền ô nhập |
| `--code` | `#141720` | Nền editor code (body, headers) |
| `--bd` / `--bd-soft` | `#2e3350` / `#252840` | Viền / đường kẻ mảnh |
| `--tx` / `--mu` | `#e2e4f0` / `#8a8fb0` | Chữ chính / chữ phụ (khoảng 5:1 trên `--bg`) |
| `--ac` / `--ac-tx` | `#f59e0b` / `#1a1d27` | Điểm nhấn (nút chính, công tắc bật) / chữ trên nền điểm nhấn |
| `--ok` / `--warn` | `#10b981` / `#f59e0b` | Thành công / cảnh báo |
| `--err` | `#ef4444` | Lỗi: viền, nền nhạt |
| `--err-text` | `#f87171` | Lỗi: chữ nhỏ trên nền tối. Mockup dùng `--err` (khoảng 4.46:1, sát ngưỡng AA), bản thật dùng màu sáng hơn này |

**Màu method** (đồng bộ với bản cũ): GET `#10b981`, POST `#f59e0b`, PUT `#3b82f6`, PATCH `#8b5cf6`, DELETE `#ef4444`, HEAD `#06b6d4`, OPTIONS `#9ca3af`, ANY dùng `--mu`. Nhãn rút gọn: DELETE → `DEL`, OPTIONS → `OPT`.

**Kiểu chữ:** `system-ui` 13px cho UI. Monospace 11.5px cho code, URL, nhãn method và status. Nhãn field 10.5px, chữ hoa, giãn chữ 0.04em.

**Kích thước:** bo góc 6px cho control, 8–10px cho khung. Thanh công cụ panel 36px. Hàng rule 48px (panel) và 46px (popup). Hàng log tối thiểu 30px. Công tắc 28×16 (panel), 32×18 (popup). Cột danh sách của panel rộng 270px. Popup rộng 380px.

## 3. Panel "API Mock"

**Bố cục:** thanh trên cùng (tiêu đề, ô search, nút `+ Add rule`, công tắc tổng "Mocking"), thân chia đôi (danh sách rule 270px, editor co giãn), log cố định phía dưới (cao khoảng 118px, cuộn được).

**Hàng rule:** nhãn method, tên (đậm), URL (mono, cắt bằng dấu …), hit count, công tắc. Hàng đang chọn có nền `--surface` và vạch cam 2px bên trái. Rule đang tắt mờ còn 40%. Bấm hàng để chọn, bấm công tắc không chọn hàng.

**Editor**
- Đầu editor: tên rule (đổi tên inline), chỉ báo lưu, menu ⋮ (Duplicate, Move up, Move down, Delete có hộp xác nhận).
- Chỉ báo lưu có 3 trạng thái: `Saving…` (đang chờ debounce), `✓ Saved` (2 giây rồi ẩn), `● Not saved — fix N errors` (màu lỗi, giữ tới khi sửa xong).
- Các ô: method (chọn, tô màu theo method), URL (mono, gợi ý `https://api.example.com/users  or  /api/users*`), Status (số 200–599), Delay (ms, 0–60000), Headers (mỗi dòng `Key: Value`), Body (mono).
- Body có nút `Format JSON` (mở rộng cả chuỗi JSON lồng nhau như bản cũ) và một dòng ghi chú: `✓ Valid JSON` (xanh) hoặc `Not JSON — sent as text/plain` (trung tính, không phải lỗi).
- Thông báo lỗi nằm ngay dưới ô sai, chữ `--err-text`, ô có viền đỏ: `URL is required`, `Must be 200–599`, `Must be 0–60000`, `Line 2: invalid header name`.

**Bản nháp:** rule có lỗi validate không được lưu và không đẩy vào engine. Trên hàng rule:
- Rule mới chưa hợp lệ: nhãn đỏ **Not applied**.
- Rule đã lưu nhưng đang sửa dở có lỗi: nhãn đỏ **Unsaved edits**. Bản đã lưu trước đó vẫn đang được áp dụng.

Bản nháp chỉ tồn tại trong bộ nhớ của panel, đóng DevTools thì mất.

**Trạng thái rỗng** (chưa có rule): biểu tượng, `No rules yet`, một dòng mô tả, hộp gợi ý *"Mocked requests are answered inside the page, so they won't appear in the Network tab. Watch them in the Log below."* và nút chính `+ Add your first rule`.

**Log**
- Đầu log: `Log`, `this tab · N`, bộ lọc (`All`, `Mocked N`, `Issues N`, luôn hiển thị), nút `Clear`.
- Dòng thường: giờ (mono, mờ), nhãn method, URL (kèm query), `→ tên rule`, thẻ status, delay. Thẻ status: 2xx `--ok`, 3xx `#3b82f6`, 4xx `--warn`, 5xx `--err`.
- Dòng sự cố có biểu tượng tròn và một câu giải thích: `rules-unavailable` (cảnh báo, biểu tượng `!`, màu cam) và `engine-error` (lỗi, biểu tượng `×`, màu đỏ). Hai nhãn này ứng với `LogEntry.kind` là `unavailable` và `error` trong spec chính (mục 4.1).
- Dòng mới nằm dưới cùng, tự cuộn xuống khi đang ở đáy. Tối đa 200 dòng.
- Log rỗng: `No mocked requests on this tab yet.`

## 4. Popup

**Bố cục:** tiêu đề (44px: logo, `API Mock`, công tắc tổng "Mocking"), dải trạng thái, danh sách rule (hàng giống panel, không sửa được ngoài công tắc), chân trang.

**Dải trạng thái**, chọn theo thứ tự ưu tiên, dừng ở điều kiện đầu tiên đúng:

| # | Điều kiện | Kiểu | Nội dung |
|---|---|---|---|
| 1 | Tắt toàn cục | `off` (xám) | **Off** · requests go straight to the network. Danh sách mờ 50% nhưng vẫn bật/tắt được từng rule |
| 2 | Tab không có engine (`PING` không có phản hồi) | `warn` (cam) | **Not active on this tab yet** + giải thích: tab mở trước khi extension khởi động thì reload; không dùng được trên trang `chrome://` và Chrome Web Store |
| 3 | Tab có sự cố (`issues > 0`) | `warn` (cam) | **N issue(s) on this tab** + lý do ngắn + chỉ dẫn "DevTools → API Mock → Log" |
| 4 | Chưa có rule nào | `ok` (xanh) | **Active** · no rules yet. Thay danh sách bằng hướng dẫn mở DevTools → API Mock → `+ Add rule` |
| 5 | Còn lại | `ok` (xanh) | **Active** · N mocked on this tab (hoặc "nothing mocked on this tab yet" nếu N = 0) |

**Chân trang:** `Edit rules: DevTools → API Mock tab`. Ở trạng thái 4 đổi thành `Mocked requests won't appear in the Network tab.`

**Ô search** chỉ hiện khi có hơn 5 rule (các mockup không vẽ ô này). Panel luôn có search.

**Kiểm tra tab:** khi mở, popup lấy tab đang hoạt động rồi `chrome.tabs.sendMessage(tabId, { type: 'PING' })`. Bridge trả `{ ok: true }`. Lỗi hoặc không phản hồi nghĩa là tab chưa có engine. Cách này phản ánh đúng thực tế, không suy luận từ `PAGE_START` (suy luận sẽ sai khi tab điều hướng sang trang không hỗ trợ).

## 5. Icon và badge

**Icon** vẽ lúc chạy bằng `OffscreenCanvas` như bản cũ: hình vuông bo góc (bán kính 22%) và dấu `>` ở giữa. Bật: nền `#f59e0b`, dấu `#1c1917`. Tắt: nền `#4b5563`, dấu `#9ca3af`.

**Badge** đặt theo từng tab (`setBadgeText({ tabId })`), chọn theo thứ tự ưu tiên:

| # | Điều kiện | Chữ | Nền / màu chữ |
|---|---|---|---|
| 1 | Tắt toàn cục | `OFF` | `#4b5563` / trắng |
| 2 | Tab có sự cố | `!` | `#ef4444` / trắng |
| 3 | Đã mock ít nhất 1 request từ lần tải trang cấp cao nhất gần nhất | Số đếm (tối đa `99+`) | `#10b981` / `#06281c` |
| 4 | Còn lại | (không có badge) | |

Màu chữ badge đặt bằng `chrome.action.setBadgeTextColor` (Chrome 110+, khớp `minimum_chrome_version: 111`). Tooltip của icon (`setTitle`): `API Mock — Active · N mocked on this tab`, `… — N issue(s) on this tab`, hoặc `… — Off`.

## 6. Chuỗi chữ chính (English)

| Chỗ dùng | Chuỗi |
|---|---|
| Log, `rules-unavailable` | `Rules didn't load in time — request passed through to the network` |
| Log, `engine-error` có rule | `Rule "<name>": couldn't build the response — request passed through` |
| Log, `engine-error` không rõ rule | `Engine error — request passed through` |
| Xác nhận xoá rule | `Delete rule "<name>"?` (nút `Cancel` / `Delete`) |
| Ghi chú body | `✓ Valid JSON` / `Not JSON — sent as text/plain` |

Các chuỗi khác lấy đúng theo mockup.

## 7. Trợ năng

- Công tắc dùng `role="switch"` và `aria-checked`. Mọi phần tử tương tác có vòng focus rõ (viền 2px `--ac`, lệch 1px) và cao tối thiểu 24px.
- Danh sách rule dùng được bằng bàn phím: ↑/↓ để chuyển hàng, Enter để chọn.
- Màu không phải tín hiệu duy nhất: thẻ status có số, dòng sự cố có biểu tượng và chữ, ô lỗi có thông báo.

## 8. Khác biệt giữa mockup và tài liệu này

Mockup chỉ minh hoạ. Khi lệch, tài liệu này là chuẩn:

- Nhãn hàng rule: mockup chỉ vẽ **Not applied**. **Unsaved edits** (rule đã lưu nhưng đang sửa dở) chưa được vẽ.
- Bộ lọc log (`All / Mocked / Issues`) luôn hiển thị. Mockup 1 và bản panel chính chưa vẽ.
- Màu chữ lỗi nhỏ dùng `--err-text`.
- Ô search của popup (chỉ khi hơn 5 rule) chưa được vẽ.
- Mockup 3 của panel minh hoạ các loại dòng log, không phải một chế độ "log mở rộng" riêng. Trong v1 chiều cao log cố định.

## 9. Ngoài phạm vi UI của v1

Kéo chỉnh chiều cao log, kéo-thả sắp xếp rule, theme sáng, i18n, nút "Mock request này" từ danh sách request thật của DevTools.

## 10. Mặc định cần bạn xác nhận

1. **Ngôn ngữ giao diện:** English, viết cứng.
2. **Tên hiển thị:** `API Mock` (tên tạm, khớp bản cũ).
3. **Bản nháp mất khi đóng DevTools.** Không lưu nháp vào storage.
4. **Nút Clear của log cũng đặt lại bộ đếm sự cố** của tab (coi như đã xem), nhưng không đụng tới bộ đếm số request đã mock.
