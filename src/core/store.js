// Project store with snapshot-based undo/redo.
//
// Every committed edit records a JSON snapshot of the project as it was
// before the edit. Continuous gestures (dragging a knob, moving clips) are
// grouped: begin() takes one snapshot, live() mutates freely, end() commits
// a single undo step if anything changed. Snapshots make undo exact and
// robust to any edit, at the cost of memory, which is capped.

const MAX_UNDO = 200;
const MAX_BYTES = 64 * 1024 * 1024;

export class Store extends EventTarget {
  constructor(project) {
    super();
    this.p = project;
    this.undoStack = [];
    this.redoStack = [];
    this.gesture = null;
    this.dirty = false;
    this.version = 0;
    this.savedVersion = 0;
  }

  snapshot() { return JSON.stringify(this.p); }

  emit(scope, detail = {}) {
    this.version++;
    this.dirty = true;
    this.dispatchEvent(new CustomEvent('change', { detail: { scope, ...detail } }));
  }

  pushUndo(label, before) {
    this.undoStack.push({ label, before });
    this.redoStack.length = 0;
    let bytes = 0;
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      bytes += this.undoStack[i].before.length;
      if (bytes > MAX_BYTES || this.undoStack.length - i > MAX_UNDO) { this.undoStack.splice(0, i + 1); break; }
    }
    this.dispatchEvent(new CustomEvent('history'));
  }

  // One-shot edit.
  do(label, fn, scope = 'all', detail = {}) {
    if (this.gesture) { fn(this.p); this.emit(scope, detail); return; }
    const before = this.snapshot();
    const res = fn(this.p);
    if (res === false) return;
    this.pushUndo(label, before);
    this.emit(scope, detail);
  }

  begin(label) {
    if (this.gesture) { this.gesture.depth++; return; }
    this.gesture = { label, before: this.snapshot(), depth: 1 };
  }
  live(fn, scope = 'all', detail = {}) {
    fn(this.p);
    this.emit(scope, { ...detail, transient: !!this.gesture });
  }
  end(scope = null) {
    const g = this.gesture;
    if (!g) return;
    if (--g.depth > 0) return;
    this.gesture = null;
    if (this.snapshot() !== g.before) this.pushUndo(g.label, g.before);
    if (scope) this.emit(scope, { committed: true });
  }
  cancel() {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this.p = JSON.parse(g.before);
    this.emit('all', { reason: 'cancel' });
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.canUndo ? this.undoStack[this.undoStack.length - 1].label : ''; }
  get redoLabel() { return this.canRedo ? this.redoStack[this.redoStack.length - 1].label : ''; }

  undo() {
    if (this.gesture) this.end();
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, before: this.snapshot() });
    this.p = JSON.parse(e.before);
    this.emit('all', { reason: 'undo' });
    this.dispatchEvent(new CustomEvent('history'));
    return e.label;
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, before: this.snapshot() });
    this.p = JSON.parse(e.before);
    this.emit('all', { reason: 'redo' });
    this.dispatchEvent(new CustomEvent('history'));
    return e.label;
  }

  replace(project) {
    this.p = project;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.gesture = null;
    this.emit('all', { reason: 'load' });
    this.markSaved();
    this.dispatchEvent(new CustomEvent('history'));
  }
  markSaved() { this.savedVersion = this.version; this.dirty = false; }
  get unsaved() { return this.version !== this.savedVersion; }
}
