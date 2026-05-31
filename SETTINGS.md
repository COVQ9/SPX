# SETTINGS — SPX Helpers Volume & Gain

## Audio Gain Table

Tất cả HTMLAudioElement (MP3) đi qua Web Audio API GainNode trong `spx-shared`.
Gain mặc định = **1.0** (giữ nguyên âm lượng gốc). Chỉnh trong `spx-shared.user.js`:

```javascript
const _gainTable  = { rok: 4.0, hv: 2.0 };
```

| Key | Gain | Sound | Script |
|-----|------|-------|--------|
| `rok` | **4.0** | `rok_covq9.mp3` / `rok_tsov.mp3` — Received Successfully | scan-job |
| `hv` | **2.0** | `hv.mp3` — HV alert | find-details |
| `welcome` | 1.0 | `welcome_covq9.mp3` / `welcome_tsov.mp3` — lời chào khi scan đầu tiên | scan-job |
| `sfx` | 1.0 | 17 error sounds (not-created, pending-canceled, too-many, ...) | scan-job |
| `silent` | 1.0 | silent 1s — dùng để unlock AudioContext | scan-job |
| `cod` | 1.0 | `cod.mp3` — tiền cước thay đổi | open-2-end |

## Cách thay đổi gain

### Thay đổi cố định (persist qua reload)
Sửa `_gainTable` trong `spx-shared.user.js`, bump `@version`, deploy.

### Thay đổi tạm thời tại runtime (console DevTools)
```javascript
document.documentElement.SpxShared.setGain('rok', 6.0)  // đặt rok lên 6x
document.documentElement.SpxShared.setGain('hv', 1.0)   // reset hv về bình thường
```
`setGain` update ngay lập tức, không cần reload.

## Lưu ý

- **Gain > 1.0 có thể gây clipping** nếu source audio đã gần max. Nghe thấy tiếng vỡ → giảm gain xuống.
- **sf-keyboard** và các synth trong **open-2-end** dùng AudioContext riêng — không bị ảnh hưởng bởi bảng này.
- **find-details fallback** (`new Audio(HV_SOUND_URL)` tại line 302) tạo Audio element mới không qua GainNode — chỉ xảy ra khi `_ensureHVAudio` fail.
