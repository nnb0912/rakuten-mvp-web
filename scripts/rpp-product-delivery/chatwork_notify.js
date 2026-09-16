require('dotenv').config();

function authContext(roomId) {
  const token = process.env.CHATWORK_API_TOKEN;
  const room = roomId || process.env.CHATWORK_ROOM_ID;
  if (!token || !room) {
    throw new Error('CHATWORK_API_TOKEN / CHATWORK_ROOM_ID が未設定です（--out または --dry で送信なし検証は可能）');
  }
  return { token, room };
}

async function sendChatwork(message, roomId) {
  const { token, room } = authContext(roomId);
  const res = await fetch(`https://api.chatwork.com/v2/rooms/${encodeURIComponent(room)}/messages`, {
    method: 'POST',
    headers: {
      'X-ChatWorkToken': token,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ body: message }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Chatwork送信失敗 status=${res.status} body=${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}

async function getChatworkMessage(messageId, roomId) {
  const { token, room } = authContext(roomId);
  const res = await fetch(`https://api.chatwork.com/v2/rooms/${encodeURIComponent(room)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'GET',
    headers: { 'X-ChatWorkToken': token },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Chatwork読み戻し失敗 status=${res.status} body=${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}

async function listChatworkMessages(roomId, force = true) {
  const { token, room } = authContext(roomId);
  const url = new URL(`https://api.chatwork.com/v2/rooms/${encodeURIComponent(room)}/messages`);
  if (force) url.searchParams.set('force', '1');
  const res = await fetch(url, { method: 'GET', headers: { 'X-ChatWorkToken': token } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Chatwork一覧取得失敗 status=${res.status} body=${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}

module.exports = { sendChatwork, getChatworkMessage, listChatworkMessages };
