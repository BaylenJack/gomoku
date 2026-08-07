// 棋局持久化 — 单文件 JSON 快照, 原子写入
//
// 为什么不用数据库: 两个人下棋, 数据量以 KB 计, 上 SQLite 属于杀鸡用牛刀,
// 还多一个原生依赖(node-gyp 编译问题在小机器上很烦)。JSON 快照足够,
// 且人类可读 —— 真出问题时你能直接打开看。
//
// 原子性: 先写临时文件再 rename。rename 在同一文件系统上是原子操作,
// 保证任何时刻磁盘上的存档要么是旧的完整版本, 要么是新的完整版本,
// 不会出现写一半断电导致的半截 JSON。

import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(file) {
    this.file = file;
    this.rooms = new Map();
    this._writeTimer = null;
    this._writing = false;
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, 'utf8');
      if (!raw.trim()) return;
      const data = JSON.parse(raw);
      for (const [id, room] of Object.entries(data.rooms || {})) {
        this.rooms.set(id, room);
      }
      console.log(`[store] 已恢复 ${this.rooms.size} 个房间`);
    } catch (e) {
      // 存档损坏不能让服务起不来 —— 备份后从空白开始
      const bak = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, bak);
        console.error(`[store] 存档损坏, 已备份到 ${bak}: ${e.message}`);
      } catch {
        console.error(`[store] 存档损坏且无法备份: ${e.message}`);
      }
    }
  }

  // 合并短时间内的多次改动, 避免每落一子就同步写盘
  markDirty() {
    this._dirty = true;
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this.flush();
    }, 400);
  }

  flush() {
    if (this._writing || !this._dirty) return;
    this._writing = true;
    this._dirty = false;
    const payload = { savedAt: Date.now(), rooms: Object.fromEntries(this.rooms) };
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error(`[store] 写盘失败: ${e.message}`);
      this._dirty = true; // 下次重试
    } finally {
      this._writing = false;
    }
  }

  // 进程退出前同步落盘
  flushSync() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    this._dirty = true;
    this.flush();
  }

  get(id) {
    return this.rooms.get(id);
  }

  set(id, room) {
    this.rooms.set(id, room);
    this.markDirty();
  }

  delete(id) {
    this.rooms.delete(id);
    this.markDirty();
  }

  // 清理长期无人的空房间, 防止存档无限膨胀
  prune(maxAgeMs) {
    const now = Date.now();
    let removed = 0;
    for (const [id, room] of this.rooms) {
      if (now - (room.updatedAt || 0) > maxAgeMs) {
        this.rooms.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[store] 清理了 ${removed} 个过期房间`);
      this.markDirty();
    }
  }
}
