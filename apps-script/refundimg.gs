/**
 * Drive Proxy for Refund-NSS userscript
 * ─────────────────────────────────────────────────────────────
 * Endpoint web app trả về danh sách / nội dung ảnh proof
 * trong 1 folder Drive cụ thể, kèm cleanup file > 7 ngày.
 *
 * DEPLOY (làm 1 lần):
 *  1. Tạo 1 folder mới trên Drive (vd "NSS Proofs"), copy folder ID
 *     từ URL: https://drive.google.com/drive/folders/<FOLDER_ID>
 *  2. Vào https://script.google.com → New project → đổi tên project
 *     (vd "refundimg"), xóa code mẫu, paste TOÀN BỘ file này.
 *  3. Sửa 2 hằng dưới đây:
 *       FOLDER_ID = '...'        (folder ID ở bước 1)
 *       SECRET    = '...'        (chuỗi random dài, vd 32 ký tự)
 *  4. Ctrl+S lưu.
 *  5. Chạy thủ công 1 lần để cấp quyền Drive:
 *     - Chọn function "setupTrigger" trong dropdown đầu file → Run
 *     - Popup "Authorization required" → Review permissions →
 *       chọn account → "Advanced" → Go to refundimg (unsafe)
 *       → Allow. (Cảnh báo "unsafe" là chuẩn vì web app chưa verified.)
 *     - Sau khi xong, vào Triggers (icon đồng hồ trái) verify thấy
 *       cleanupOld chạy daily.
 *  6. Deploy → New deployment → gear icon → "Web app":
 *       Description : refundimg v2 (list+get+rename)
 *       Execute as  : Me
 *       Who has access : Anyone
 *       (Anyone = ai có URL đều gọi được — bảo mật bởi SECRET.)
 *     → Deploy → copy "Web app URL" (dạng .../macros/s/.../exec).
 *  7. Mở SPX Cash Collection page, click ⚙ Settings, paste:
 *       Drive proxy URL    = URL ở bước 6
 *       Drive proxy secret = SECRET ở bước 3
 *     Bấm Test → kỳ vọng "✓ Drive: 0 files" (folder rỗng).
 *  8. iOS Shortcut: tạo shortcut "Save File" → đích là folder
 *     Drive ở bước 1. Mỗi screenshot ck xong, share → run shortcut.
 *
 * KHI MUỐN ĐỔI SECRET / RETENTION:
 *  - Sửa hằng → Ctrl+S → Deploy → Manage deployments → edit
 *    deployment hiện tại → Version: New version → Deploy.
 *    URL không đổi.
 */

const FOLDER_ID = 'PASTE_FOLDER_ID_HERE';
const SECRET = 'PASTE_RANDOM_SECRET_HERE';
const RETENTION_DAYS = 10;

function doGet(e) {
  const p = e.parameter || {};
  if (p.secret !== SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const action = p.action || 'list';
    if (action === 'list')   return json(listFiles());
    if (action === 'get')    return json(getFile(p.id));
    if (action === 'rename') return json(renameFile(p.id, p.name));
    if (action === 'move')   return json(moveToSubfolder(p.id, p.subfolder));
    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function listFiles() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const it = folder.getFiles();
  const files = [];
  while (it.hasNext()) {
    const f = it.next();
    const mime = f.getMimeType();
    if (mime.indexOf('image/') !== 0) continue;
    files.push({
      id: f.getId(),
      name: f.getName(),
      mimeType: mime,
      modifiedTime: f.getLastUpdated().toISOString(),
      size: f.getSize()
    });
  }
  files.sort(function (a, b) { return b.modifiedTime.localeCompare(a.modifiedTime); });
  return { ok: true, files: files };
}

function getFile(id) {
  if (!id) return { ok: false, error: 'missing id' };
  const f = DriveApp.getFileById(id);
  // Verify file thuộc folder cho phép, chống truy cập tùy ý qua API
  const parents = f.getParents();
  let inFolder = false;
  while (parents.hasNext()) {
    if (parents.next().getId() === FOLDER_ID) { inFolder = true; break; }
  }
  if (!inFolder) return { ok: false, error: 'not in folder' };

  const blob = f.getBlob();
  return {
    ok: true,
    id: f.getId(),
    name: f.getName(),
    mimeType: blob.getContentType(),
    dataB64: Utilities.base64Encode(blob.getBytes())
  };
}

function renameFile(id, name) {
  if (!id || !name) return { ok: false, error: 'missing id or name' };
  const f = DriveApp.getFileById(id);
  // Verify file thuộc folder cho phép — chống abuse rename file tùy ý qua API
  const parents = f.getParents();
  let inFolder = false;
  while (parents.hasNext()) {
    if (parents.next().getId() === FOLDER_ID) { inFolder = true; break; }
  }
  if (!inFolder) return { ok: false, error: 'not in folder' };
  f.setName(name);
  return { ok: true, id: f.getId(), name: f.getName() };
}

/** Move file từ root FOLDER_ID xuống subfolder con (vd "garbage").
 *  - Tự create subfolder nếu chưa tồn tại.
 *  - Verify file đang ở root để chống abuse move file tùy ý.
 *  - listFiles() non-recursive nên file sau khi move sẽ biến mất khỏi gdList → script không tracking nữa. */
function moveToSubfolder(id, subName) {
  if (!id || !subName) return { ok: false, error: 'missing id or subfolder' };
  const f = DriveApp.getFileById(id);
  const root = DriveApp.getFolderById(FOLDER_ID);
  // Verify file đang ở root folder
  const parents = f.getParents();
  let inRoot = false;
  while (parents.hasNext()) {
    if (parents.next().getId() === FOLDER_ID) { inRoot = true; break; }
  }
  if (!inRoot) return { ok: false, error: 'not in folder' };
  // Find or create subfolder bên trong root
  const subIt = root.getFoldersByName(subName);
  const sub = subIt.hasNext() ? subIt.next() : root.createFolder(subName);
  f.moveTo(sub);
  return { ok: true, id: f.getId(), name: f.getName(), to: sub.getName() };
}

function cleanupOld() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
  const it = folder.getFiles();
  let deleted = 0;
  while (it.hasNext()) {
    const f = it.next();
    if (f.getLastUpdated().getTime() < cutoff) {
      f.setTrashed(true);
      deleted++;
    }
  }
  console.log('cleanupOld: deleted ' + deleted + ' files');
}

// Chạy 1 lần sau khi paste code: cấp quyền + tạo trigger daily
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'cleanupOld'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('cleanupOld')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();
  console.log('trigger created — cleanupOld runs daily at 3am');
  // Smoke test
  const r = listFiles();
  console.log('smoke test: ' + r.files.length + ' image files in folder');
}
