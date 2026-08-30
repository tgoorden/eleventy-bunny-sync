import readline from 'node:readline';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function elapsed(started) {
  const seconds = Math.floor((Date.now() - started) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function shorten(value, maximum = 64) {
  const text = String(value ?? '');
  if (text.length <= maximum) return text;
  return `…${text.slice(-(maximum - 1))}`;
}

export class InteractiveProgress {
  constructor({ enabled = false, stream = process.stderr } = {}) {
    this.enabled = enabled;
    this.stream = stream;
    this.started = Date.now();
    this.phase = 'Starting';
    this.total = 0;
    this.completed = 0;
    this.active = 0;
    this.retries = 0;
    this.last = '';
    this.frame = 0;
    this.lastNonTtyRender = 0;
    this.timer = null;
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.render(true);
    this.timer = setInterval(() => this.render(), 200);
    this.timer.unref?.();
  }

  handle(event) {
    if (!this.enabled || !event) return;
    if (event.type === 'message') {
      if (this.stream.isTTY) {
        readline.clearLine(this.stream, 0);
        readline.cursorTo(this.stream, 0);
      }
      this.stream.write(`${event.message}\n`);
      this.render(true);
      return;
    }
    if (event.type === 'stage') {
      this.phase = event.phase;
      this.total = event.total ?? 0;
      this.completed = 0;
      this.active = 0;
      this.last = event.message ?? '';
      this.render(true);
      return;
    }
    if (event.type === 'operation-start') {
      this.active++;
      this.last = `${event.kind}: ${event.path}`;
    } else if (event.type === 'operation-complete') {
      this.active = Math.max(0, this.active - 1);
      this.completed++;
      this.last = `${event.kind} ${event.status}: ${event.path}`;
    } else if (event.type === 'retry') {
      this.retries++;
      this.last = `retry ${event.attempt}/${event.attempts}: ${event.operation}`;
    }
    this.render(event.type === 'retry');
  }

  line() {
    const frame = FRAMES[this.frame++ % FRAMES.length];
    const count = this.total ? ` ${this.completed}/${this.total}` : '';
    const active = this.active ? ` • ${this.active} active` : '';
    const retries = this.retries ? ` • ${this.retries} retries` : '';
    const detail = this.last ? ` • ${shorten(this.last)}` : '';
    return `${frame} ${this.phase}${count}${active}${retries} • ${elapsed(this.started)}${detail}`;
  }

  render(force = false) {
    if (!this.enabled) return;
    if (this.stream.isTTY) {
      readline.clearLine(this.stream, 0);
      readline.cursorTo(this.stream, 0);
      this.stream.write(this.line());
      return;
    }
    const now = Date.now();
    if (force || now - this.lastNonTtyRender >= 5000) {
      this.stream.write(`${this.line()}\n`);
      this.lastNonTtyRender = now;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.enabled && this.stream.isTTY) {
      readline.clearLine(this.stream, 0);
      readline.cursorTo(this.stream, 0);
    }
  }
}
