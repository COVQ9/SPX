# SETTINGS — SPX Helpers Volume & Gain

## Rok Gain Stepper (UI)

Button loa bên phải ô input trang Scan — điều chỉnh âm lượng `rok_covq9.mp3` / `rok_tsov.mp3`.

| Thao tác | Kết quả |
|----------|---------|
| Click vào container (không phải icon cuối) | Tăng 1 bậc (+100%) |
| Click icon cuối cùng | Giảm 1 bậc (-100%) |
| Double-click | Reset về 100% |
| Hover | Tooltip "Rok: N00%" |

- Tối thiểu: 1 icon = **100%**
- Tối đa: 10 icon = **1000%**
- Chime feedback: tone 880Hz khi thay đổi, volume theo mức mới
- Persist: IDB `spx_audio/mp3` key `rok_gain_level` (survives reboot)

---

## Audio Gain Table (hardcoded)

Tất cả HTMLAudioElement đi qua Web Audio API GainNode trong `spx-shared`. Thay đổi trong `src/spx-shared.user.js`:

```javascript
const _gainTable = { rok: 1.0, hv: 2.0 };  // rok = 1.0 vì UI stepper kiểm soát
```

| Key | Gain | Sound | Script |
|-----|------|-------|--------|
| `rok` | UI-controlled | `rok_covq9.mp3` / `rok_tsov.mp3` — Received Successfully | scan-job |
| `hv` | **2.0** | `hv.mp3` — HV alert | find-details |
| `welcome` | 1.0 | `welcome_covq9.mp3` / `welcome_tsov.mp3` — lời chào đầu phiên | scan-job |
| `sfx` | 1.0 | 17 error sounds (not-created, pending-canceled, too-many, ...) | scan-job |
| `silent` | 1.0 | silent 1s — dùng để unlock AudioContext | scan-job |
| `cod` | 1.0 | `cod.mp3` — tiền cước thay đổi | open-2-end |

### Thay đổi gain hardcoded tại runtime (console DevTools)

```javascript
document.documentElement.SpxShared.setGain('hv', 3.0)  // boost HV lên 3x
document.documentElement.SpxShared.setGain('cod', 2.0) // boost COD sound
```

`setGain` update ngay lập tức, không cần reload. Không persist qua reload — dùng code thay đổi nếu muốn cố định.

---

## Lưu ý

- **Gain > 1.0 có thể gây clipping** nếu source audio đã gần max. Nghe thấy tiếng vỡ → giảm gain.
- **sf-keyboard** dùng AudioContext synth riêng — không bị ảnh hưởng bởi bảng này.
- **open-2-end** AudioContext synths (beep, ding) cũng có gain envelope riêng.
- **find-details fallback** (`new Audio(HV_SOUND_URL)`) tạo Audio mới không qua GainNode — chỉ xảy ra khi `_ensureHVAudio` fail.
