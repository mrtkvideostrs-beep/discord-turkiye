const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// In-memory state
const channels = {
  'genel-sohbet': { name: 'genel-sohbet', icon: '#', topic: "Türkiye'nin en büyük oyun topluluğuna hoş geldiniz 🇹🇷", messages: [] },
  'meme-bölgesi':  { name: 'meme-bölgesi',  icon: '#', topic: 'Meme paylaş, güldür', messages: [] },
  'valorant':      { name: 'valorant',       icon: '#', topic: 'Valorant maçları ve stratejiler', messages: [] },
  'cs2':           { name: 'cs2',            icon: '#', topic: 'CS2 toplantı noktası', messages: [] },
  'minecraft':     { name: 'minecraft',      icon: '#', topic: 'Minecraft dünyaları', messages: [] },
  'müzik':         { name: 'müzik',          icon: '#', topic: 'Müzik önerileri', messages: [] },
  'duyurular':     { name: 'duyurular',      icon: '📢', topic: 'Sunucu duyuruları', messages: [
    { id: 1, userId: 'system', username: 'Discord TR', color: '#5865f2', initials: '📢', isBot: true,
      text: '🇹🇷 Discord Türkiye resmen açıldı! Herkese hoş geldiniz. Kuralları okuyun, rol alın ve eğlenin!',
      time: Date.now() - 3600000, reactions: [{ emoji: '🎉', count: 42 }, { emoji: '🇹🇷', count: 31 }] }
  ]},
};

const voiceChannels = {
  'Genel Lobi': { users: [] },
  'Oyun Odası': { users: [] },
  'AFK':        { users: [] },
};

const onlineUsers = new Map(); // socketId -> user

io.on('connection', (socket) => {
  console.log('Bağlantı:', socket.id);

  // JOIN
  socket.on('join', ({ username, color, initials }) => {
    const user = { id: socket.id, username, color, initials, status: 'online', currentChannel: 'genel-sohbet', currentVoice: null };
    onlineUsers.set(socket.id, user);
    socket.join('genel-sohbet');

    // Send state
    socket.emit('init', {
      channels: Object.fromEntries(Object.entries(channels).map(([k,v]) => [k, { ...v, messages: v.messages.slice(-100) }])),
      voiceChannels,
      users: Array.from(onlineUsers.values()),
    });

    // Notify others
    io.emit('user_join', user);
    io.emit('users_update', Array.from(onlineUsers.values()));

    // Welcome message
    const sysMsg = {
      id: Date.now() + Math.random(),
      type: 'system',
      text: `**${username}** sunucuya katıldı! 👋`,
      time: Date.now(),
    };
    io.to('genel-sohbet').emit('system_message', { channel: 'genel-sohbet', msg: sysMsg });
  });

  // MESSAGE
  socket.on('message', ({ channel, text }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !text.trim() || !channels[channel]) return;
    const msg = {
      id: Date.now() + Math.random(),
      userId: socket.id,
      username: user.username,
      color: user.color,
      initials: user.initials,
      text: text.trim(),
      time: Date.now(),
      reactions: [],
      edited: false,
    };
    channels[channel].messages.push(msg);
    if (channels[channel].messages.length > 500) channels[channel].messages.shift();
    io.emit('message', { channel, msg });
  });

  // TYPING
  socket.on('typing', ({ channel, isTyping }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    socket.to(channel).emit('typing', { username: user.username, channel, isTyping });
  });

  // REACTION
  socket.on('reaction', ({ channel, msgId, emoji }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !channels[channel]) return;
    const msg = channels[channel].messages.find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = [];
    const existing = msg.reactions.find(r => r.emoji === emoji);
    const myReactions = msg.reactions.filter(r => r.users && r.users.includes(socket.id));

    if (existing) {
      if (!existing.users) existing.users = [];
      const idx = existing.users.indexOf(socket.id);
      if (idx >= 0) { existing.users.splice(idx,1); existing.count--; if (existing.count <= 0) msg.reactions = msg.reactions.filter(r => r !== existing); }
      else { existing.users.push(socket.id); existing.count++; }
    } else {
      msg.reactions.push({ emoji, count: 1, users: [socket.id] });
    }
    io.emit('reaction_update', { channel, msgId, reactions: msg.reactions, reactorId: socket.id });
  });

  // DELETE
  socket.on('delete_message', ({ channel, msgId }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !channels[channel]) return;
    const idx = channels[channel].messages.findIndex(m => m.id === msgId && m.userId === socket.id);
    if (idx >= 0) {
      channels[channel].messages.splice(idx, 1);
      io.emit('message_deleted', { channel, msgId });
    }
  });

  // EDIT
  socket.on('edit_message', ({ channel, msgId, newText }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !channels[channel]) return;
    const msg = channels[channel].messages.find(m => m.id === msgId && m.userId === socket.id);
    if (msg) {
      msg.text = newText.trim();
      msg.edited = true;
      io.emit('message_edited', { channel, msgId, newText: msg.text });
    }
  });

  // SWITCH CHANNEL
  socket.on('switch_channel', ({ channel }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !channels[channel]) return;
    socket.leave(user.currentChannel);
    user.currentChannel = channel;
    socket.join(channel);
  });

  // VOICE JOIN/LEAVE
  socket.on('voice_join', ({ channel }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    if (user.currentVoice && voiceChannels[user.currentVoice]) {
      voiceChannels[user.currentVoice].users = voiceChannels[user.currentVoice].users.filter(u => u.id !== socket.id);
    }
    if (voiceChannels[channel]) {
      voiceChannels[channel].users.push({ id: socket.id, username: user.username, color: user.color, initials: user.initials });
      user.currentVoice = channel;
    }
    io.emit('voice_update', voiceChannels);
  });

  socket.on('voice_leave', () => {
    const user = onlineUsers.get(socket.id);
    if (!user || !user.currentVoice) return;
    if (voiceChannels[user.currentVoice]) {
      voiceChannels[user.currentVoice].users = voiceChannels[user.currentVoice].users.filter(u => u.id !== socket.id);
    }
    user.currentVoice = null;
    io.emit('voice_update', voiceChannels);
  });

  // STATUS
  socket.on('set_status', ({ status }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    user.status = status;
    io.emit('users_update', Array.from(onlineUsers.values()));
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      if (user.currentVoice && voiceChannels[user.currentVoice]) {
        voiceChannels[user.currentVoice].users = voiceChannels[user.currentVoice].users.filter(u => u.id !== socket.id);
        io.emit('voice_update', voiceChannels);
      }
      const sysMsg = {
        id: Date.now() + Math.random(),
        type: 'system',
        text: `**${user.username}** sunucudan ayrıldı.`,
        time: Date.now(),
      };
      io.to(user.currentChannel).emit('system_message', { channel: user.currentChannel, msg: sysMsg });
      onlineUsers.delete(socket.id);
      io.emit('users_update', Array.from(onlineUsers.values()));
    }
    console.log('Ayrıldı:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Discord TR sunucusu çalışıyor: http://localhost:${PORT}`));
